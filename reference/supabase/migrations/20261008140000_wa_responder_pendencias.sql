-- Inteligência de WhatsApp (v1), migration 6: responder pendência de DM com aprovação do dono.
-- Fluxo: o dono (admin) escreve o texto no portal e clica Aprovar. A linha vai para wa.fila_envio
-- (status 'aprovado') e um consumidor local no Mac, via service_role, reivindica, envia pelo gateway
-- e conclui. Nenhum texto é gerado por IA aqui: a autoria gravada é {"origem":"dono","ia":false}.
-- Segurança: o texto aprovado é imutável (trigger), vale sha256 conferido na hora de reivindicar,
-- uma aprovação viva por pendência (índice único parcial), ritmo e limite por hora vêm de wa.config,
-- kill switch fail-closed: só o valor JSON false libera; true, texto, null, número ou linha ausente
-- significam PARADO, na aprovação e na reivindicação (nestas duas funções; o legado não muda).
-- Envio incerto: linha 'falhou' com erro 'interrompido_verificar' (pode ter saído) continua ocupando a
-- vaga da pendência até o dono conferir no WhatsApp e liberar (wa.liberar_reaprovacao) ou fechar a
-- pendência como respondida.
-- A auditoria nunca guarda o texto, só prefixo do hash e contagem de caracteres.
-- Pré-requisitos já aplicados no banco real: wa.chats.contato (20261008120000) e a versão atual de
-- wa.v_pendencias (20261008130000). A coluna entra aqui idempotente (add column if not exists).
-- Reversão: supabase/rollbacks/20261008140000_wa_responder_pendencias.rollback.sql.txt

-- ---------------------------------------------------------------- 1. wa.chats.contato
alter table wa.chats add column if not exists contato boolean;
comment on column wa.chats.contato is 'DM com contato salvo na agenda do dono. null = não avaliado; true = salvo; false = número desconhecido. Nunca guarda telefone.';

-- ---------------------------------------------------------------- 2. wa.fila_envio
alter table wa.fila_envio drop constraint if exists fila_envio_status_check;
alter table wa.fila_envio add constraint fila_envio_status_check
  check (status in ('pendente','copiado','aberto_no_whatsapp','confirmado_pelo_dono','cancelado','expirado',
                    'aprovado','enviando','enviado','falhou'));

alter table wa.fila_envio add column if not exists pendencia_id    bigint references wa.pendencias_resposta;
alter table wa.fila_envio add column if not exists tentativas      int not null default 0;
alter table wa.fila_envio add column if not exists reivindicado_em timestamptz;
alter table wa.fila_envio add column if not exists enviado_em      timestamptz;
alter table wa.fila_envio add column if not exists message_id      text;
alter table wa.fila_envio add column if not exists erro            text;
alter table wa.fila_envio add column if not exists idempotency_key text;

alter table wa.fila_envio drop constraint if exists fila_envio_erro_check;
alter table wa.fila_envio add constraint fila_envio_erro_check
  check (erro is null or char_length(erro) <= 200);
alter table wa.fila_envio drop constraint if exists fila_envio_texto_check;
alter table wa.fila_envio add constraint fila_envio_texto_check
  check (char_length(btrim(texto)) > 0 and char_length(texto) <= 4000);

comment on column wa.fila_envio.erro is 'Só código curto (ex.: hash_divergente, destino_invalido). Nunca texto de mensagem.';
comment on column wa.fila_envio.idempotency_key is 'Chave que o consumidor local usa para não enviar duas vezes a mesma linha.';

-- Uma aprovação viva por pendência. Cancelado, expirado e falhou comum liberam nova aprovação.
-- Falhou com erro 'interrompido_verificar' (envio incerto) NÃO libera: exige wa.liberar_reaprovacao.
drop index if exists wa.fila_envio_pendencia_viva_uidx;
create unique index fila_envio_pendencia_viva_uidx
  on wa.fila_envio (pendencia_id)
  where status in ('aprovado','enviando','enviado') or (status = 'falhou' and erro = 'interrompido_verificar');
create unique index if not exists fila_envio_idempotency_uidx
  on wa.fila_envio (idempotency_key) where idempotency_key is not null;
create index if not exists fila_envio_pendencia_idx on wa.fila_envio (pendencia_id, id desc);

-- Trava de edição e de transição de estado.
-- Imutáveis: sugestao_id, destino_jid, texto, texto_hash, aprovado_por, aprovado_em, pendencia_id.
-- Fluxo novo: aprovado -> enviando|cancelado|expirado|falhou; enviando -> enviado|falhou;
-- enviado, falhou, cancelado e expirado (do fluxo novo) são terminais e congelados. Única exceção:
-- em 'falhou' o erro pode passar de 'interrompido_verificar' para 'verificado_nao_enviado'
-- (via wa.liberar_reaprovacao), sem mudar nenhum outro campo.
-- Linhas legadas (sem pendencia_id e com estado legado) seguem como estavam, mas não migram para o fluxo novo.
create or replace function wa.trg_fila_envio_valida() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_fluxo_novo boolean;
begin
  if new.sugestao_id  is distinct from old.sugestao_id
  or new.destino_jid  is distinct from old.destino_jid
  or new.texto        is distinct from old.texto
  or new.texto_hash   is distinct from old.texto_hash
  or new.aprovado_por is distinct from old.aprovado_por
  or new.aprovado_em  is distinct from old.aprovado_em
  or new.pendencia_id is distinct from old.pendencia_id then
    raise exception 'wa.fila_envio: texto, destino e aprovação são imutáveis' using errcode = '42501';
  end if;
  if old.idempotency_key is not null and new.idempotency_key is distinct from old.idempotency_key then
    raise exception 'wa.fila_envio: idempotency_key é imutável' using errcode = '42501';
  end if;

  v_fluxo_novo := old.pendencia_id is not null or old.status in ('aprovado','enviando','enviado','falhou');

  if not v_fluxo_novo then
    if new.status in ('aprovado','enviando','enviado','falhou') then
      raise exception 'wa.fila_envio: linha legada (%) não entra no fluxo de envio novo', old.status
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.status = old.status then
    if old.status = 'falhou' and old.erro = 'interrompido_verificar'
       and new.erro = 'verificado_nao_enviado'
       and (to_jsonb(new) - 'erro') = (to_jsonb(old) - 'erro') then
      return new;
    end if;
    if old.status in ('enviado','falhou','cancelado','expirado') then
      raise exception 'wa.fila_envio: linha encerrada (%) não pode ser alterada', old.status using errcode = '42501';
    end if;
    return new;
  end if;

  if not ((old.status = 'aprovado' and new.status in ('enviando','cancelado','expirado','falhou'))
       or (old.status = 'enviando' and new.status in ('enviado','falhou'))) then
    raise exception 'wa.fila_envio: transição % -> % não permitida', old.status, new.status
      using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists fila_envio_valida on wa.fila_envio;
create trigger fila_envio_valida before update on wa.fila_envio
  for each row execute function wa.trg_fila_envio_valida();

-- ---------------------------------------------------------------- 3. sementes de config
insert into wa.config (chave, valor) values
  ('ENVIO_RESPOSTAS_ATIVO',       'false'::jsonb),
  ('ENVIO_RESPOSTAS_INTERVALO_S', '60'::jsonb),
  ('ENVIO_RESPOSTAS_MAX_HORA',    '5'::jsonb)
on conflict (chave) do nothing;

-- ---------------------------------------------------------------- 4. aprovar
-- Única porta de entrada do fluxo "responder pendência". O texto é o que o dono escreveu.
create or replace function wa.aprovar_resposta_pendencia(p_pendencia_id bigint, p_texto text) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_kill  jsonb;
  v_ativo jsonb;
  v_texto text;
  v_pend  wa.pendencias_resposta%rowtype;
  v_chat  wa.chats%rowtype;
  v_hash  text;
  v_sug   bigint;
  v_fila  bigint;
begin
  if auth.uid() is null or not wa.is_admin() then
    raise exception 'wa.aprovar_resposta_pendencia: apenas admin' using errcode = '42501';
  end if;

  select valor into v_kill from wa.config where chave = 'kill_switch_envio';
  if v_kill is distinct from 'false'::jsonb then
    raise exception 'wa.aprovar_resposta_pendencia: kill switch de envio ligado ou indefinido';
  end if;
  select valor into v_ativo from wa.config where chave = 'ENVIO_RESPOSTAS_ATIVO';
  if v_ativo is distinct from 'true'::jsonb then
    raise exception 'wa.aprovar_resposta_pendencia: envio de respostas desligado';
  end if;

  v_texto := btrim(coalesce(p_texto, ''), E' \t\r\n');
  if char_length(v_texto) = 0 then
    raise exception 'wa.aprovar_resposta_pendencia: texto vazio';
  end if;
  if char_length(v_texto) > 4000 then
    raise exception 'wa.aprovar_resposta_pendencia: texto maior que 4000 caracteres';
  end if;

  select * into v_pend from wa.pendencias_resposta where id = p_pendencia_id for update;
  if not found then
    raise exception 'wa.aprovar_resposta_pendencia: pendência % inexistente', p_pendencia_id;
  end if;
  if v_pend.status <> 'aberta' then
    raise exception 'wa.aprovar_resposta_pendencia: pendência % não está aberta (%)', p_pendencia_id, v_pend.status;
  end if;

  select * into v_chat from wa.chats where id = v_pend.chat_id;
  if v_chat.tipo <> 'direto' then
    raise exception 'wa.aprovar_resposta_pendencia: só chat direto recebe resposta';
  end if;
  if v_chat.contato is distinct from true then
    raise exception 'wa.aprovar_resposta_pendencia: o contato não está salvo na agenda';
  end if;
  if v_chat.modo = 'off' then
    raise exception 'wa.aprovar_resposta_pendencia: chat desligado (modo off)';
  end if;
  if v_chat.jid !~ '^[^@]+@(s\.whatsapp\.net|lid)$' then
    raise exception 'wa.aprovar_resposta_pendencia: destino inválido';
  end if;

  if exists (select 1 from wa.fila_envio f
              where f.pendencia_id = p_pendencia_id
                and (f.status in ('aprovado','enviando','enviado')
                     or (f.status = 'falhou' and f.erro = 'interrompido_verificar'))) then
    raise exception 'wa.aprovar_resposta_pendencia: envio anterior incerto ou resposta já aprovada: confirme no WhatsApp se saiu e libere a reaprovação ou feche a pendência como respondida'
      using errcode = '23505';
  end if;

  v_hash := encode(sha256(convert_to(v_texto, 'UTF8')), 'hex');

  insert into wa.sugestoes_resposta
    (chat_id, mensagem_origem, texto_sugerido, texto_final, status, autoria, validacoes, decidida_por, decidida_em)
  values
    (v_pend.chat_id, v_pend.mensagem_id, v_texto, v_texto, 'aprovada',
     '{"origem":"dono","ia":false}'::jsonb, '{}'::jsonb, auth.uid(), now())
  returning id into v_sug;

  insert into wa.fila_envio (sugestao_id, destino_jid, texto, texto_hash, aprovado_por, aprovado_em, status, pendencia_id)
  values (v_sug, v_chat.jid, v_texto, v_hash, auth.uid(), now(), 'aprovado', p_pendencia_id)
  returning id into v_fila;

  update wa.fila_envio
     set idempotency_key = 'wa-resp:' || v_fila::text || ':' || left(v_hash, 12)
   where id = v_fila;

  insert into wa.auditoria (ator, acao, alvo, detalhe)
  values (auth.uid()::text, 'aprova_resposta_dm', v_fila::text,
          jsonb_build_object('pendencia_id', p_pendencia_id, 'chat_id', v_pend.chat_id,
                             'hash_prefixo', left(v_hash, 8), 'caracteres', char_length(v_texto)));
  return v_fila;
end;
$$;

-- ---------------------------------------------------------------- 5. cancelar
-- Atômico: só cancela se ainda estiver 'aprovado'. false = já foi reivindicada, enviada ou encerrada.
create or replace function wa.cancelar_resposta_pendencia(p_fila_id bigint) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_sug  bigint;
  v_pend bigint;
begin
  if auth.uid() is null or not wa.is_admin() then
    raise exception 'wa.cancelar_resposta_pendencia: apenas admin' using errcode = '42501';
  end if;

  update wa.fila_envio
     set status = 'cancelado'
   where id = p_fila_id and status = 'aprovado'
   returning sugestao_id, pendencia_id into v_sug, v_pend;
  if not found then
    return false;
  end if;

  update wa.sugestoes_resposta
     set status = 'rejeitada', motivo_rejeicao = 'cancelada_pelo_dono'
   where id = v_sug;

  insert into wa.auditoria (ator, acao, alvo, detalhe)
  values (auth.uid()::text, 'cancela_resposta_dm', p_fila_id::text,
          jsonb_build_object('pendencia_id', v_pend));
  return true;
end;
$$;

-- ---------------------------------------------------------------- 5b. liberar reaprovação
-- Depois de conferir no WhatsApp que a mensagem NÃO saiu, o admin libera nova aprovação da pendência.
-- Só age em linha 'falhou' com erro 'interrompido_verificar'. false = nada a liberar.
create or replace function wa.liberar_reaprovacao(p_fila_id bigint) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_pend bigint;
begin
  if auth.uid() is null or not wa.is_admin() then
    raise exception 'wa.liberar_reaprovacao: apenas admin' using errcode = '42501';
  end if;

  update wa.fila_envio
     set erro = 'verificado_nao_enviado'
   where id = p_fila_id and status = 'falhou' and erro = 'interrompido_verificar'
   returning pendencia_id into v_pend;
  if not found then
    return false;
  end if;

  insert into wa.auditoria (ator, acao, alvo, detalhe)
  values (auth.uid()::text, 'libera_reaprovacao_dm', p_fila_id::text,
          jsonb_build_object('pendencia_id', v_pend));
  return true;
end;
$$;

-- ---------------------------------------------------------------- 6. reivindicar (consumidor local)
-- Devolve 0 ou 1 linha. Serializada por advisory lock. Aplica, nesta ordem: limpeza (expirados e
-- 'enviando' preso), travas (kill switch, ativo, intervalo, limite por hora), reconferência da linha.
-- Linha que falha na reconferência é encerrada com código curto e a próxima candidata é tentada;
-- só a linha realmente reivindicada conta para intervalo e limite por hora.
create or replace function wa.reivindicar_envio_resposta()
returns table (fila_id bigint, destino_jid text, texto text, texto_hash text,
               chat_id uuid, pendencia_id bigint, idempotency_key text)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_kill      jsonb;
  v_ativo     jsonb;
  v_intervalo jsonb;
  v_maxhora   jsonb;
  v_ultima    timestamptz;
  v_n         int;
  v_f         wa.fila_envio%rowtype;
  v_pend      wa.pendencias_resposta%rowtype;
  v_chat      wa.chats%rowtype;
  v_erro      text;
begin
  perform pg_advisory_xact_lock(hashtextextended('wa.reivindicar_envio_resposta', 0));

  -- Limpeza 1: aprovados vencidos viram expirados (sugestão também).
  with e as (
    update wa.fila_envio f set status = 'expirado'
     where f.status = 'aprovado' and f.expira_em < now()
     returning f.id, f.sugestao_id, f.pendencia_id
  ), s as (
    update wa.sugestoes_resposta g set status = 'expirada'
     where g.id in (select e.sugestao_id from e)
     returning 1
  )
  insert into wa.auditoria (ator, acao, alvo, detalhe)
  select 'worker', 'expira_resposta_dm', e.id::text, jsonb_build_object('pendencia_id', e.pendencia_id)
    from e;

  -- Limpeza 2: 'enviando' há mais de 10 minutos. Pode ter saído ou não: exige verificação manual.
  with p as (
    update wa.fila_envio f set status = 'falhou', erro = 'interrompido_verificar'
     where f.status = 'enviando' and f.reivindicado_em < now() - interval '10 minutes'
     returning f.id, f.pendencia_id
  )
  insert into wa.auditoria (ator, acao, alvo, detalhe)
  select 'worker', 'falha_envio_resposta_dm', p.id::text,
         jsonb_build_object('pendencia_id', p.pendencia_id, 'erro', 'interrompido_verificar')
    from p;

  -- Travas.
  select c.valor into v_kill      from wa.config c where c.chave = 'kill_switch_envio';
  select c.valor into v_ativo     from wa.config c where c.chave = 'ENVIO_RESPOSTAS_ATIVO';
  select c.valor into v_intervalo from wa.config c where c.chave = 'ENVIO_RESPOSTAS_INTERVALO_S';
  select c.valor into v_maxhora   from wa.config c where c.chave = 'ENVIO_RESPOSTAS_MAX_HORA';
  if v_kill is distinct from 'false'::jsonb then
    return;
  end if;
  if v_ativo is distinct from 'true'::jsonb then
    return;
  end if;
  -- Ritmo ausente ou inválido: não envia (falha para o lado seguro).
  if jsonb_typeof(v_intervalo) is distinct from 'number' or jsonb_typeof(v_maxhora) is distinct from 'number' then
    return;
  end if;

  select max(f.reivindicado_em) into v_ultima from wa.fila_envio f;
  if v_ultima is not null
     and v_ultima > now() - make_interval(secs => (v_intervalo #>> '{}')::double precision) then
    return;
  end if;
  select count(*) into v_n from wa.fila_envio f where f.reivindicado_em > now() - interval '1 hour';
  if v_n >= (v_maxhora #>> '{}')::numeric then
    return;
  end if;

  loop
    select * into v_f
      from wa.fila_envio f
     where f.status = 'aprovado' and f.expira_em >= now()
     order by f.aprovado_em, f.id
     limit 1
       for update skip locked;
    if not found then
      return;
    end if;

    v_erro := null;
    select * into v_pend from wa.pendencias_resposta p where p.id = v_f.pendencia_id;
    if not found or v_pend.status <> 'aberta' then
      v_erro := 'pendencia_fechada';
    else
      select * into v_chat from wa.chats c where c.id = v_pend.chat_id;
      if not found or v_chat.tipo <> 'direto' or v_chat.contato is distinct from true
         or v_chat.modo = 'off' or v_chat.jid !~ '^[^@]+@(s\.whatsapp\.net|lid)$'
         or v_chat.jid is distinct from v_f.destino_jid then
        v_erro := 'destino_invalido';
      elsif encode(sha256(convert_to(v_f.texto, 'UTF8')), 'hex') is distinct from v_f.texto_hash then
        v_erro := 'hash_divergente';
      end if;
    end if;

    if v_erro is not null then
      update wa.fila_envio f
         set status = case when v_erro = 'pendencia_fechada' then 'cancelado' else 'falhou' end,
             erro = v_erro
       where f.id = v_f.id;
      if v_erro = 'pendencia_fechada' then
        update wa.sugestoes_resposta g
           set status = 'rejeitada', motivo_rejeicao = 'pendencia_fechada'
         where g.id = v_f.sugestao_id;
      end if;
      insert into wa.auditoria (ator, acao, alvo, detalhe)
      values ('worker', 'falha_envio_resposta_dm', v_f.id::text,
              jsonb_build_object('pendencia_id', v_f.pendencia_id, 'erro', v_erro));
    else
      update wa.fila_envio f
         set status = 'enviando', reivindicado_em = now(), tentativas = f.tentativas + 1
       where f.id = v_f.id;
      fila_id := v_f.id;
      destino_jid := v_f.destino_jid;
      texto := v_f.texto;
      texto_hash := v_f.texto_hash;
      chat_id := v_pend.chat_id;
      pendencia_id := v_f.pendencia_id;
      idempotency_key := v_f.idempotency_key;
      return next;
      return;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------- 7. concluir (consumidor local)
-- Só age em linha 'enviando'. Qualquer outra situação é ignorada em silêncio (retentativa segura).
create or replace function wa.concluir_envio_resposta(
  p_fila_id    bigint,
  p_ok         boolean,
  p_message_id text default null,
  p_erro       text default null
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_f wa.fila_envio%rowtype;
begin
  select * into v_f from wa.fila_envio where id = p_fila_id and status = 'enviando' for update;
  if not found then
    return;
  end if;

  if coalesce(p_ok, false) then
    update wa.fila_envio
       set status = 'enviado', enviado_em = now(), message_id = left(p_message_id, 200), erro = null
     where id = v_f.id;
    update wa.sugestoes_resposta set status = 'enviada' where id = v_f.sugestao_id;
    update wa.pendencias_resposta set status = 'respondida' where id = v_f.pendencia_id and status = 'aberta';
    insert into wa.auditoria (ator, acao, alvo, detalhe)
    values ('worker', 'envia_resposta_dm', v_f.id::text,
            jsonb_build_object('pendencia_id', v_f.pendencia_id, 'hash_prefixo', left(v_f.texto_hash, 8),
                               'caracteres', char_length(v_f.texto), 'message_id', left(p_message_id, 200)));
  else
    update wa.fila_envio
       set status = 'falhou', erro = coalesce(left(nullif(btrim(p_erro), ''), 200), 'falha_desconhecida')
     where id = v_f.id;
    insert into wa.auditoria (ator, acao, alvo, detalhe)
    values ('worker', 'falha_envio_resposta_dm', v_f.id::text,
            jsonb_build_object('pendencia_id', v_f.pendencia_id,
                               'erro', coalesce(left(nullif(btrim(p_erro), ''), 200), 'falha_desconhecida')));
  end if;
end;
$$;

-- ---------------------------------------------------------------- 8. view do portal
-- Parte da definição vigente no banco (migration 20261008130000_wa_v_pendencias_so_contatos: só contatos
-- salvos, mais recente primeiro) e acrescenta, ao final, o estado da fila mais recente da pendência.
-- Mesmas colunas e ordem de antes. Sem o texto: o portal já o tem enquanto o dono escreve.
create or replace view wa.v_pendencias with (security_invoker = true) as
select p.id, p.chat_id, p.contato_nome, c.nome as chat_nome, p.espera_desde, p.pedido, p.urgencia,
       p.tipo_resposta, p.audio_sem_transcricao, p.status, p.gerado_em, c.contato,
       f.id as fila_id, f.status as fila_status, f.erro as fila_erro, f.expira_em as fila_expira_em
from wa.pendencias_resposta p
join wa.chats c on c.id = p.chat_id
join wa.mensagens m on m.id = p.mensagem_id
left join lateral (
  select x.id, x.status, x.erro, x.expira_em
    from wa.fila_envio x
   where x.pendencia_id = p.id
   order by x.id desc
   limit 1
) f on true
where c.contato is true
order by m.enviada_em desc;

revoke all on wa.v_pendencias from public, anon;
grant select on wa.v_pendencias to authenticated, service_role;

-- ---------------------------------------------------------------- 9. grants
revoke all on function wa.trg_fila_envio_valida() from public, anon, authenticated;
revoke all on function wa.aprovar_resposta_pendencia(bigint, text) from public, anon, authenticated;
revoke all on function wa.cancelar_resposta_pendencia(bigint) from public, anon, authenticated;
revoke all on function wa.liberar_reaprovacao(bigint) from public, anon, authenticated;
revoke all on function wa.reivindicar_envio_resposta() from public, anon, authenticated;
revoke all on function wa.concluir_envio_resposta(bigint, boolean, text, text) from public, anon, authenticated;

grant execute on function wa.aprovar_resposta_pendencia(bigint, text) to authenticated, service_role;
grant execute on function wa.cancelar_resposta_pendencia(bigint) to authenticated, service_role;
grant execute on function wa.liberar_reaprovacao(bigint) to authenticated, service_role;
grant execute on function wa.reivindicar_envio_resposta() to service_role;
grant execute on function wa.concluir_envio_resposta(bigint, boolean, text, text) to service_role;
-- wa.fila_envio continua sem insert/update para authenticated (só select, filtrado por RLS de admin).
