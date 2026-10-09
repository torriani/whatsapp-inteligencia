-- Inteligência de WhatsApp (v1), migration 3 de 3: RPCs do worker, RPCs/views do portal.
-- Funções do worker: só service_role. Funções do portal: authenticated, mas cada uma
-- reforça admin (RLS em views/leituras; checagem explícita nas que escrevem).
-- Reversão: supabase/rollbacks/20261007140000_wa_inteligencia_funcoes.rollback.sql.txt

-- ---------------------------------------------------------------- auxiliares
create or replace function wa.exigir_chat_liberado(p_chat_id uuid) returns void
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_modo text;
begin
  select modo into v_modo from wa.chats where id = p_chat_id;
  if v_modo is null or v_modo = 'off' then
    raise exception 'wa: chat % não liberado (modo=%)', p_chat_id, coalesce(v_modo, 'inexistente')
      using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------- worker: mensagem
-- Upsert idempotente por (chat, stanza_id); sem stanza_id usa (chat, local_pk).
-- Reexecutar não duplica. Só reescreve a linha quando o hash muda (edição, apagada para todos)
-- ou quando uma resposta citada passa a ser resolvível. Retorna o id da mensagem.
create or replace function wa.upsert_mensagem(
  p_chat_id           uuid,
  p_local_pk          bigint,
  p_stanza_id         text,
  p_autor_jid         text,
  p_autor_nome        text,
  p_autor_push_name   text,
  p_do_dono       boolean,
  p_enviada_em        timestamptz,
  p_tipo              smallint,
  p_texto             text,
  p_redigida          boolean default false,
  p_apagada           boolean default false,
  p_responde_a_stanza text default null,
  p_tem_midia         boolean default false,
  p_midia_meta        jsonb default null,
  p_transcrito        boolean default false,
  p_hash              text default null
) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_autor   uuid;
  v_resp    bigint;
  v_texto   text;
  v_hash    text;
  v_id      bigint;
begin
  v_texto := case when p_redigida or p_apagada then null else p_texto end;
  v_hash := coalesce(
    p_hash,
    encode(sha256(convert_to(
      coalesce(v_texto, '') || '|' || p_apagada::text || '|' || p_redigida::text || '|' || p_tipo::text,
      'UTF8')), 'hex')
  );

  if p_autor_jid is not null then
    insert into wa.participantes (chat_id, jid, nome, push_name, e_dono)
    values (p_chat_id, p_autor_jid, p_autor_nome, p_autor_push_name, coalesce(p_do_dono, false))
    on conflict (chat_id, jid) do update
      set nome       = coalesce(excluded.nome, wa.participantes.nome),
          push_name  = coalesce(excluded.push_name, wa.participantes.push_name),
          e_dono = wa.participantes.e_dono or excluded.e_dono
    returning id into v_autor;
  end if;

  if p_responde_a_stanza is not null then
    select id into v_resp from wa.mensagens
    where chat_id = p_chat_id and stanza_id = p_responde_a_stanza;
  end if;

  if p_stanza_id is not null then
    insert into wa.mensagens as m (chat_id, local_pk, stanza_id, autor_id, do_dono, enviada_em, tipo,
                                   texto, redigida, apagada, responde_a, tem_midia, midia_meta, transcrito, hash)
    values (p_chat_id, p_local_pk, p_stanza_id, v_autor, coalesce(p_do_dono, false), p_enviada_em, p_tipo,
            v_texto, p_redigida, p_apagada, v_resp, p_tem_midia, p_midia_meta, p_transcrito, v_hash)
    on conflict (chat_id, stanza_id) do update
      set tipo = excluded.tipo, texto = excluded.texto, redigida = excluded.redigida, apagada = excluded.apagada,
          responde_a = coalesce(excluded.responde_a, m.responde_a), tem_midia = excluded.tem_midia,
          midia_meta = excluded.midia_meta, transcrito = excluded.transcrito, hash = excluded.hash
      where m.hash is distinct from excluded.hash
         or (m.responde_a is null and excluded.responde_a is not null)
    returning m.id into v_id;
    if v_id is null then
      select id into v_id from wa.mensagens where chat_id = p_chat_id and stanza_id = p_stanza_id;
    end if;
  else
    insert into wa.mensagens as m (chat_id, local_pk, stanza_id, autor_id, do_dono, enviada_em, tipo,
                                   texto, redigida, apagada, responde_a, tem_midia, midia_meta, transcrito, hash)
    values (p_chat_id, p_local_pk, null, v_autor, coalesce(p_do_dono, false), p_enviada_em, p_tipo,
            v_texto, p_redigida, p_apagada, v_resp, p_tem_midia, p_midia_meta, p_transcrito, v_hash)
    on conflict (chat_id, local_pk) do update
      set tipo = excluded.tipo, texto = excluded.texto, redigida = excluded.redigida, apagada = excluded.apagada,
          responde_a = coalesce(excluded.responde_a, m.responde_a), tem_midia = excluded.tem_midia,
          midia_meta = excluded.midia_meta, transcrito = excluded.transcrito, hash = excluded.hash
      where m.hash is distinct from excluded.hash
         or (m.responde_a is null and excluded.responde_a is not null)
    returning m.id into v_id;
    if v_id is null then
      select id into v_id from wa.mensagens where chat_id = p_chat_id and local_pk = p_local_pk;
    end if;
  end if;

  update wa.chats
     set ultimo_pk_local = greatest(ultimo_pk_local, p_local_pk),
         ultima_msg_em   = greatest(coalesce(ultima_msg_em, p_enviada_em), p_enviada_em)
   where id = p_chat_id
     and (ultimo_pk_local < p_local_pk or ultima_msg_em is null or ultima_msg_em < p_enviada_em);

  return v_id;
end;
$$;

-- Lote: p_lote é um array JSON com as mesmas chaves (sem o prefixo p_). Processa em ordem de local_pk.
-- Qualquer erro (inclusive chat não liberado) aborta o lote inteiro.
create or replace function wa.upsert_mensagens(p_chat_id uuid, p_lote jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  r   jsonb;
  n   int := 0;
begin
  if jsonb_typeof(p_lote) is distinct from 'array' then
    raise exception 'wa.upsert_mensagens: p_lote deve ser um array JSON';
  end if;
  for r in
    select e from jsonb_array_elements(p_lote) as e order by (e->>'local_pk')::bigint
  loop
    perform wa.upsert_mensagem(
      p_chat_id,
      (r->>'local_pk')::bigint,
      r->>'stanza_id',
      r->>'autor_jid',
      r->>'autor_nome',
      r->>'autor_push_name',
      coalesce((r->>'do_dono')::boolean, false),
      (r->>'enviada_em')::timestamptz,
      (r->>'tipo')::smallint,
      r->>'texto',
      coalesce((r->>'redigida')::boolean, false),
      coalesce((r->>'apagada')::boolean, false),
      r->>'responde_a_stanza',
      coalesce((r->>'tem_midia')::boolean, false),
      r->'midia_meta',
      coalesce((r->>'transcrito')::boolean, false),
      r->>'hash'
    );
    n := n + 1;
  end loop;
  return jsonb_build_object('processadas', n);
end;
$$;

-- ---------------------------------------------------------------- worker: link
-- Idempotente: o mesmo (link, mensagem) não soma duas vezes. Mantém a primeira menção como origem.
create or replace function wa.registrar_link(
  p_chat_id          uuid,
  p_mensagem_id      bigint,
  p_url              text,
  p_url_norm         text,
  p_dominio          text,
  p_titulo           text default null,
  p_tags             text[] default null
) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_msg  wa.mensagens%rowtype;
  v_id   bigint;
begin
  perform wa.exigir_chat_liberado(p_chat_id);
  select * into v_msg from wa.mensagens where id = p_mensagem_id and chat_id = p_chat_id;
  if not found then
    raise exception 'wa.registrar_link: mensagem % não pertence ao chat %', p_mensagem_id, p_chat_id;
  end if;

  insert into wa.links as l (chat_id, mensagem_id, autor_id, url, url_norm, dominio, titulo, compartilhado_em, tags)
  values (p_chat_id, p_mensagem_id, v_msg.autor_id, p_url, p_url_norm, lower(p_dominio), p_titulo, v_msg.enviada_em, p_tags)
  on conflict (chat_id, url_norm) do update
    set titulo      = coalesce(l.titulo, excluded.titulo),
        tags        = coalesce(l.tags, excluded.tags),
        mensagem_id = case when excluded.compartilhado_em < l.compartilhado_em then excluded.mensagem_id else l.mensagem_id end,
        autor_id    = case when excluded.compartilhado_em < l.compartilhado_em then excluded.autor_id else l.autor_id end,
        compartilhado_em = least(l.compartilhado_em, excluded.compartilhado_em)
  returning l.id into v_id;

  insert into wa.link_mencoes (link_id, mensagem_id) values (v_id, p_mensagem_id)
  on conflict do nothing;

  update wa.links set vezes = (select count(*) from wa.link_mencoes where link_id = v_id)
   where id = v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------- worker: resumo
-- Upsert por (chat, periodo, data_ref). p_decisoes: array de {texto, mensagem_ref, decidida_em, responsavel}.
-- Decisões já registradas para o mesmo resumo e texto não são duplicadas nem apagadas.
create or replace function wa.registrar_resumo(
  p_chat_id     uuid,
  p_periodo     text,
  p_data_ref    date,
  p_discutido   jsonb,
  p_decidido    jsonb,
  p_olhar       jsonb,
  p_n_mensagens int,
  p_msg_de      bigint default null,
  p_msg_ate     bigint default null,
  p_modelo      text default null,
  p_decisoes    jsonb default '[]'::jsonb
) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_id bigint;
  d    jsonb;
begin
  perform wa.exigir_chat_liberado(p_chat_id);

  insert into wa.resumos as r (chat_id, periodo, data_ref, discutido, decidido, olhar, n_mensagens, msg_de, msg_ate, modelo)
  values (p_chat_id, p_periodo, p_data_ref, p_discutido, p_decidido, p_olhar, p_n_mensagens, p_msg_de, p_msg_ate, p_modelo)
  on conflict (chat_id, periodo, data_ref) do update
    set discutido = excluded.discutido, decidido = excluded.decidido, olhar = excluded.olhar,
        n_mensagens = excluded.n_mensagens, msg_de = excluded.msg_de, msg_ate = excluded.msg_ate,
        modelo = excluded.modelo, gerado_em = now()
  returning r.id into v_id;

  if jsonb_typeof(p_decisoes) = 'array' then
    for d in select e from jsonb_array_elements(p_decisoes) as e loop
      insert into wa.decisoes (chat_id, resumo_id, texto, mensagem_ref, decidida_em, responsavel)
      values (p_chat_id, v_id, d->>'texto', nullif(d->>'mensagem_ref','')::bigint,
              nullif(d->>'decidida_em','')::date, d->>'responsavel')
      on conflict (resumo_id, md5(texto)) where resumo_id is not null do nothing;
    end loop;
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------- worker: aprendizado
-- Exige fontes reais (ids de wa.mensagens, do mesmo chat quando p_chat_id é informado).
-- Reenvio do mesmo título no mesmo chat só atualiza enquanto o status for 'candidato'.
create or replace function wa.registrar_aprendizado(
  p_chat_id   uuid,
  p_titulo    text,
  p_corpo     text,
  p_fontes    bigint[],
  p_tags      text[] default null,
  p_confianca smallint default null,
  p_embedding public.vector default null
) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_id     bigint;
  v_validas int;
  v_dist    int;
begin
  if p_fontes is null or cardinality(p_fontes) < 1 then
    raise exception 'wa.registrar_aprendizado: fontes obrigatórias';
  end if;
  if p_chat_id is not null then
    perform wa.exigir_chat_liberado(p_chat_id);
  end if;
  select count(distinct f) into v_dist from unnest(p_fontes) as f;
  select count(*) into v_validas from wa.mensagens
   where id = any(p_fontes) and (p_chat_id is null or chat_id = p_chat_id);
  if v_validas <> v_dist then
    raise exception 'wa.registrar_aprendizado: fontes inexistentes ou de outro chat';
  end if;

  insert into wa.aprendizados as a (chat_id, titulo, corpo, tags, fontes, confianca, embedding)
  values (p_chat_id, p_titulo, p_corpo, p_tags, p_fontes, p_confianca, p_embedding)
  on conflict (chat_id, md5(titulo)) do update
    set corpo = excluded.corpo,
        tags = coalesce(excluded.tags, a.tags),
        fontes = (select array_agg(distinct x) from unnest(a.fontes || excluded.fontes) as x),
        confianca = coalesce(excluded.confianca, a.confianca),
        embedding = coalesce(excluded.embedding, a.embedding)
    where a.status = 'candidato'
  returning a.id into v_id;
  if v_id is null then
    select id into v_id from wa.aprendizados
     where chat_id is not distinct from p_chat_id and md5(titulo) = md5(p_titulo);
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------- portal: escrita controlada
-- Libera, muda ou desliga um chat. Só admin logado. Auditado pelo trigger de modo.
create or replace function wa.definir_modo_chat(p_chat_id uuid, p_modo text) returns wa.chats
language plpgsql security definer set search_path = ''
as $$
declare
  v_chat wa.chats;
begin
  if auth.uid() is null or not wa.is_admin() then
    raise exception 'wa.definir_modo_chat: apenas admin' using errcode = '42501';
  end if;
  if p_modo not in ('off','registrar','inteligencia','dm_sugerir') then
    raise exception 'wa.definir_modo_chat: modo inválido %', p_modo;
  end if;
  update wa.chats
     set modo = p_modo,
         liberado_por = case when p_modo = 'off' then null else auth.uid() end,
         liberado_em  = case when p_modo = 'off' then null else now() end
   where id = p_chat_id
   returning * into v_chat;
  if not found then
    raise exception 'wa.definir_modo_chat: chat % inexistente', p_chat_id;
  end if;
  return v_chat;
end;
$$;

-- Única porta de entrada de wa.fila_envio. Exige admin logado, kill switch desligado,
-- sugestão aprovável e chat em dm_sugerir. Calcula o hash do texto aprovado e audita.
create or replace function wa.aprovar_sugestao(p_sugestao_id bigint, p_texto_final text default null) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_sug   wa.sugestoes_resposta%rowtype;
  v_chat  wa.chats%rowtype;
  v_texto text;
  v_fila  bigint;
  v_kill  jsonb;
begin
  if auth.uid() is null or not wa.is_admin() then
    raise exception 'wa.aprovar_sugestao: apenas admin' using errcode = '42501';
  end if;
  select valor into v_kill from wa.config where chave = 'kill_switch_envio';
  if coalesce(v_kill, 'false'::jsonb) = 'true'::jsonb then
    raise exception 'wa.aprovar_sugestao: kill switch de envio ligado';
  end if;

  select * into v_sug from wa.sugestoes_resposta where id = p_sugestao_id for update;
  if not found then
    raise exception 'wa.aprovar_sugestao: sugestão % inexistente', p_sugestao_id;
  end if;
  if v_sug.status not in ('sugerida','editada','aprovada') then
    raise exception 'wa.aprovar_sugestao: status % não permite aprovação', v_sug.status;
  end if;
  select * into v_chat from wa.chats where id = v_sug.chat_id;
  if v_chat.modo <> 'dm_sugerir' then
    raise exception 'wa.aprovar_sugestao: chat não está em dm_sugerir';
  end if;

  v_texto := coalesce(nullif(btrim(p_texto_final), ''), v_sug.texto_final, v_sug.texto_sugerido);

  insert into wa.fila_envio (sugestao_id, destino_jid, texto, texto_hash, aprovado_por, aprovado_em)
  values (v_sug.id, v_chat.jid, v_texto, encode(sha256(convert_to(v_texto, 'UTF8')), 'hex'), auth.uid(), now())
  returning id into v_fila;

  update wa.sugestoes_resposta
     set texto_final = v_texto,
         status = case when v_texto is distinct from texto_sugerido then 'editada' else 'aprovada' end
   where id = v_sug.id;

  insert into wa.auditoria (ator, acao, alvo, detalhe)
  values (auth.uid()::text, 'aprova_resposta', v_sug.id::text,
          jsonb_build_object('fila_id', v_fila, 'chat_id', v_sug.chat_id, 'editada', v_texto is distinct from v_sug.texto_sugerido));
  return v_fila;
end;
$$;

-- ---------------------------------------------------------------- portal: leitura
-- Views com security_invoker: a RLS das tabelas base (admin) vale para quem consulta.
create or replace view wa.v_chats_resumo with (security_invoker = true) as
select
  c.id, c.jid, c.tipo, c.nome, c.categoria, c.modo, c.ultima_msg_em, c.liberado_em, c.retencao_dias,
  coalesce(m.total, 0)  as n_mensagens,
  coalesce(m.h24, 0)    as n_mensagens_24h,
  coalesce(l.n, 0)      as n_links,
  coalesce(p.n, 0)      as n_perguntas_abertas,
  coalesce(a.n, 0)      as n_aprendizados,
  r.id          as resumo_id,
  r.data_ref    as resumo_data_ref,
  r.discutido   as resumo_discutido,
  r.decidido    as resumo_decidido,
  r.olhar       as resumo_olhar,
  r.n_mensagens as resumo_n_mensagens,
  r.gerado_em   as resumo_gerado_em
from wa.chats c
left join lateral (
  select count(*) as total, count(*) filter (where x.enviada_em > now() - interval '24 hours') as h24
  from wa.mensagens x where x.chat_id = c.id) m on true
left join lateral (select count(*) as n from wa.links x where x.chat_id = c.id) l on true
left join lateral (select count(*) as n from wa.perguntas x where x.chat_id = c.id and x.status = 'aberta') p on true
left join lateral (select count(*) as n from wa.aprendizados x where x.chat_id = c.id and x.status <> 'descartado') a on true
left join lateral (
  select * from wa.resumos x where x.chat_id = c.id and x.periodo = 'dia' order by x.data_ref desc limit 1) r on true;

create or replace view wa.v_links with (security_invoker = true) as
select l.id, l.chat_id, c.nome as chat_nome, l.mensagem_id, l.url, l.url_norm, l.dominio, l.titulo,
       l.compartilhado_em, l.vezes, l.tags,
       l.autor_id, coalesce(p.nome, p.push_name) as autor_nome
from wa.links l
join wa.chats c on c.id = l.chat_id
left join wa.participantes p on p.id = l.autor_id;

create or replace view wa.v_aprendizados with (security_invoker = true) as
select a.id, a.chat_id, c.nome as chat_nome, a.titulo, a.corpo, a.tags, a.fontes, a.confianca,
       a.status, a.criado_em, a.atualizado_em
from wa.aprendizados a
left join wa.chats c on c.id = a.chat_id;

-- Mensagens paginadas por cursor (enviada_em, id) decrescente. Invoker: RLS vale.
-- Próxima página: passar p_antes_em e p_antes_id da última linha recebida.
create or replace function wa.listar_mensagens(
  p_chat_id   uuid,
  p_antes_em  timestamptz default null,
  p_antes_id  bigint default null,
  p_limite    int default 50,
  p_busca     text default null,
  p_autor_id  uuid default null
) returns table (
  id bigint, chat_id uuid, enviada_em timestamptz, autor_id uuid, autor_nome text, do_dono boolean,
  tipo smallint, texto text, redigida boolean, apagada boolean, tem_midia boolean, midia_meta jsonb,
  transcrito boolean, responde_a bigint
)
language sql stable security invoker set search_path = ''
as $$
  select m.id, m.chat_id, m.enviada_em, m.autor_id, coalesce(p.nome, p.push_name), m.do_dono,
         m.tipo, m.texto, m.redigida, m.apagada, m.tem_midia, m.midia_meta, m.transcrito, m.responde_a
  from wa.mensagens m
  left join wa.participantes p on p.id = m.autor_id
  where m.chat_id = p_chat_id
    and (p_antes_em is null or (m.enviada_em, m.id) < (p_antes_em, coalesce(p_antes_id, 9223372036854775807)))
    and (p_autor_id is null or m.autor_id = p_autor_id)
    and (p_busca is null or btrim(p_busca) = ''
         or m.texto_tsv @@ websearch_to_tsquery('portuguese'::regconfig, p_busca)
         or m.texto ilike '%' || replace(replace(replace(p_busca, '\', '\\'), '%', '\%'), '_', '\_') || '%')
  order by m.enviada_em desc, m.id desc
  limit least(greatest(coalesce(p_limite, 50), 1), 200);
$$;

-- ---------------------------------------------------------------- grants
revoke all on all functions in schema wa from public, anon, authenticated;
grant execute on all functions in schema wa to service_role;
grant execute on function wa.is_admin() to authenticated;
grant execute on function wa.definir_modo_chat(uuid, text) to authenticated;
grant execute on function wa.aprovar_sugestao(bigint, text) to authenticated;
grant execute on function wa.listar_mensagens(uuid, timestamptz, bigint, int, text, uuid) to authenticated;

revoke all on wa.v_chats_resumo, wa.v_links, wa.v_aprendizados from public, anon;
grant select on wa.v_chats_resumo, wa.v_links, wa.v_aprendizados to authenticated, service_role;
