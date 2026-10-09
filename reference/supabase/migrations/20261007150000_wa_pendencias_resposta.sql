-- Inteligência de WhatsApp (v1), migration 4: pendências de resposta de DMs.
-- Guarda só metadado e uma síntese curta (pedido, tipo de resposta). Nunca texto redigido para envio.
-- Acesso: admin lê (wa.is_admin); admin atualiza só `status` (auditado); escrita de conteúdo só service_role via RPC.
-- Trava: só aceita chat liberado (modo <> off), tipo 'direto', e mensagem do próprio chat e da outra pessoa.
-- Reversão: supabase/rollbacks/20261007150000_wa_pendencias_resposta.rollback.sql.txt

create table if not exists wa.pendencias_resposta (
  id                    bigint generated always as identity primary key,
  chat_id               uuid not null references wa.chats,
  mensagem_id           bigint not null references wa.mensagens,
  contato_nome          text,
  espera_desde          timestamptz not null,
  pedido                text check (pedido is null or char_length(pedido) <= 500),
  urgencia              text not null check (urgencia in ('alta','media','baixa')),
  tipo_resposta         text check (tipo_resposta is null or (char_length(tipo_resposta) <= 200 and tipo_resposta !~ E'[\\n\\r]')),
  audio_sem_transcricao boolean not null default false,
  status                text not null default 'aberta' check (status in ('aberta','respondida','descartada')),
  modelo                text,
  gerado_em             timestamptz not null default now(),
  atualizado_em         timestamptz not null default now(),
  unique (chat_id, mensagem_id)
);
comment on table wa.pendencias_resposta is 'DMs aguardando resposta do dono. Sem texto de mensagem; tipo_resposta descreve o tipo de resposta, nunca a redige.';
create index if not exists pendencias_resposta_fila_idx on wa.pendencias_resposta (status, urgencia, espera_desde);
create index if not exists pendencias_resposta_chat_idx on wa.pendencias_resposta (chat_id, mensagem_id);

alter table wa.pendencias_resposta enable row level security;

create trigger pendencias_resposta_atualizado_em before update on wa.pendencias_resposta
  for each row execute function wa.set_atualizado_em();

-- Trava de inserção: chat liberado, tipo direto, mensagem do chat e da outra pessoa.
create or replace function wa.trg_pendencia_valida() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_modo text;
  v_tipo text;
  v_msg_chat uuid;
  v_dono boolean;
begin
  select modo, tipo into v_modo, v_tipo from wa.chats where id = new.chat_id;
  if v_modo is null or v_modo = 'off' then
    raise exception 'wa: chat % não liberado (modo=%), gravação negada',
      new.chat_id, coalesce(v_modo, 'inexistente') using errcode = '42501';
  end if;
  if v_tipo <> 'direto' then
    raise exception 'wa: pendência de resposta só vale para chat direto (chat % é %)', new.chat_id, v_tipo
      using errcode = '23514';
  end if;
  select chat_id, do_dono into v_msg_chat, v_dono from wa.mensagens where id = new.mensagem_id;
  if v_msg_chat is distinct from new.chat_id then
    raise exception 'wa: mensagem % não pertence ao chat %', new.mensagem_id, new.chat_id using errcode = '23514';
  end if;
  if v_dono then
    raise exception 'wa: mensagem % é do dono, não gera pendência', new.mensagem_id using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger pendencias_resposta_valida before insert on wa.pendencias_resposta
  for each row execute function wa.trg_pendencia_valida();

-- Mudança de status é auditada (ator = uid do admin, ou 'worker').
create or replace function wa.trg_pendencia_auditar() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into wa.auditoria (ator, acao, alvo, detalhe)
  values (coalesce(auth.uid()::text, 'worker'), 'altera_status_pendencia', new.id::text,
          jsonb_build_object('chat_id', new.chat_id, 'de', old.status, 'para', new.status));
  return new;
end;
$$;
create trigger pendencias_resposta_auditar after update of status on wa.pendencias_resposta
  for each row when (old.status is distinct from new.status)
  execute function wa.trg_pendencia_auditar();

-- RLS: admin lê; admin atualiza só a coluna status (grant por coluna); service_role ignora RLS.
drop policy if exists pendencias_resposta_admin_select on wa.pendencias_resposta;
create policy pendencias_resposta_admin_select on wa.pendencias_resposta for select to authenticated
  using (wa.is_admin());
drop policy if exists pendencias_resposta_admin_update on wa.pendencias_resposta;
create policy pendencias_resposta_admin_update on wa.pendencias_resposta for update to authenticated
  using (wa.is_admin()) with check (wa.is_admin());

revoke all on wa.pendencias_resposta from public, anon, authenticated;
grant select on wa.pendencias_resposta to authenticated;
grant update (status) on wa.pendencias_resposta to authenticated;
grant all on wa.pendencias_resposta to service_role;

-- Worker: registra (upsert idempotente). Pendência já respondida ou descartada não é reaberta nem reescrita.
create or replace function wa.registrar_pendencia(
  p_chat_id               uuid,
  p_mensagem_id           bigint,
  p_contato_nome          text,
  p_espera_desde          timestamptz,
  p_pedido                text,
  p_urgencia              text,
  p_tipo_resposta         text,
  p_audio_sem_transcricao boolean default false,
  p_modelo                text default null
) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_id bigint;
begin
  perform wa.exigir_chat_liberado(p_chat_id);
  insert into wa.pendencias_resposta as p
    (chat_id, mensagem_id, contato_nome, espera_desde, pedido, urgencia, tipo_resposta, audio_sem_transcricao, modelo)
  values
    (p_chat_id, p_mensagem_id, p_contato_nome, p_espera_desde, p_pedido, p_urgencia, p_tipo_resposta,
     coalesce(p_audio_sem_transcricao, false), p_modelo)
  on conflict (chat_id, mensagem_id) do update
    set contato_nome = excluded.contato_nome,
        espera_desde = excluded.espera_desde,
        pedido = excluded.pedido,
        urgencia = excluded.urgencia,
        tipo_resposta = excluded.tipo_resposta,
        audio_sem_transcricao = excluded.audio_sem_transcricao,
        modelo = excluded.modelo,
        gerado_em = now()
    where p.status = 'aberta'
  returning p.id into v_id;
  if v_id is null then
    select id into v_id from wa.pendencias_resposta where chat_id = p_chat_id and mensagem_id = p_mensagem_id;
  end if;
  return v_id;
end;
$$;

-- Worker: fecha como respondidas as abertas do chat até a mensagem informada. Retorna quantas fechou.
create or replace function wa.fechar_pendencias(p_chat_id uuid, p_ate_mensagem bigint) returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_n int;
begin
  update wa.pendencias_resposta
     set status = 'respondida'
   where chat_id = p_chat_id and status = 'aberta' and mensagem_id <= p_ate_mensagem;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function wa.trg_pendencia_valida(), wa.trg_pendencia_auditar() from public, anon, authenticated;
revoke all on function wa.registrar_pendencia(uuid, bigint, text, timestamptz, text, text, text, boolean, text) from public, anon, authenticated;
revoke all on function wa.fechar_pendencias(uuid, bigint) from public, anon, authenticated;
grant execute on function wa.registrar_pendencia(uuid, bigint, text, timestamptz, text, text, text, boolean, text) to service_role;
grant execute on function wa.fechar_pendencias(uuid, bigint) to service_role;

-- Portal: fila ordenada (alta primeiro, mais antiga primeiro). Invoker: RLS de admin vale.
create or replace view wa.v_pendencias with (security_invoker = true) as
select p.id, p.chat_id, p.contato_nome, c.nome as chat_nome, p.espera_desde, p.pedido, p.urgencia,
       p.tipo_resposta, p.audio_sem_transcricao, p.status, p.gerado_em
from wa.pendencias_resposta p
join wa.chats c on c.id = p.chat_id
order by case p.urgencia when 'alta' then 1 when 'media' then 2 else 3 end, p.espera_desde;

revoke all on wa.v_pendencias from public, anon;
grant select on wa.v_pendencias to authenticated, service_role;
