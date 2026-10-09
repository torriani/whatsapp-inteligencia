-- Inteligência de WhatsApp (v1), migration 1 de 3: schema `wa`, tabelas, índices e travas.
-- Tudo vive no schema novo `wa`. Nenhuma tabela existente é alterada.
-- Única dependência de fora: wa.admins (leitura, para identificar admin).
-- Seguro por padrão: RLS ligada e acesso revogado já nesta migration; as policies e grants
-- entram na migration 2. Entre as duas, ninguém além de postgres/service_role alcança os dados.
-- Reversão: supabase/rollbacks/20261007120000_wa_inteligencia_base.rollback.sql.txt

create schema if not exists extensions;
create extension if not exists vector with schema public;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists wa;
create table wa.admins (user_id uuid primary key references auth.users(id) on delete cascade);
alter table wa.admins enable row level security;
revoke all on wa.admins from public, anon, authenticated;
-- Primeiro admin: somente bootstrap privilegiado; nunca autoinscrição pelo navegador.
comment on schema wa is 'Inteligência de WhatsApp do portal. Acesso só admin (wa.is_admin) e service_role. Nunca expor a anon.';

-- pgvector (schema public, v0.8.0) já está habilitado no projeto; pg_trgm entra no schema extensions.
create extension if not exists pg_trgm with schema extensions;

-- Papel admin do portal: mesma regra de public.clientes_is_admin().
create or replace function wa.is_admin() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from wa.admins
    where user_id = auth.uid()
  );
$$;

create or replace function wa.set_atualizado_em() returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.atualizado_em := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------- chats (allowlist)
create table if not exists wa.chats (
  id               uuid primary key default gen_random_uuid(),
  jid              text not null unique,
  tipo             text not null check (tipo in ('grupo','comunidade','direto')),
  nome             text not null,
  categoria        text,
  modo             text not null default 'off'
                   check (modo in ('off','registrar','inteligencia','dm_sugerir')),
  liberado_por     uuid,
  liberado_em      timestamptz,
  ultimo_pk_local  bigint not null default 0,
  ultima_msg_em    timestamptz,
  retencao_dias    int check (retencao_dias is null or retencao_dias > 0),
  criado_em        timestamptz not null default now(),
  atualizado_em    timestamptz not null default now()
);
comment on table wa.chats is 'Chats conhecidos e allowlist. modo=off (padrão) significa negado: nada é gravado.';
comment on column wa.chats.retencao_dias is 'Null = guardar sem expirar (padrão, decisão D5). Nenhum job automático apaga dados.';

create trigger chats_atualizado_em before update on wa.chats
  for each row execute function wa.set_atualizado_em();

-- Trava de allowlist: recusa gravar em chat inexistente ou com modo=off.
create or replace function wa.trg_exigir_chat_liberado() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_modo text;
begin
  select modo into v_modo from wa.chats where id = new.chat_id;
  if v_modo is null or v_modo = 'off' then
    raise exception 'wa: chat % não liberado (modo=%), gravação negada',
      new.chat_id, coalesce(v_modo, 'inexistente') using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------- participantes
create table if not exists wa.participantes (
  id          uuid primary key default gen_random_uuid(),
  chat_id     uuid not null references wa.chats on delete cascade,
  jid         text not null,
  nome        text,
  push_name   text,
  e_admin     boolean not null default false,
  ativo       boolean not null default true,
  e_dono  boolean not null default false,
  anonimizado boolean not null default false,
  criado_em   timestamptz not null default now(),
  unique (chat_id, jid)
);
create trigger participantes_exigir_chat_liberado before insert on wa.participantes
  for each row execute function wa.trg_exigir_chat_liberado();

-- ---------------------------------------------------------------- mensagens
create table if not exists wa.mensagens (
  id            bigint generated always as identity primary key,
  chat_id       uuid not null references wa.chats,
  local_pk      bigint not null,
  stanza_id     text,
  autor_id      uuid references wa.participantes,
  do_dono   boolean not null default false,
  enviada_em    timestamptz not null,
  tipo          smallint not null,
  texto         text,
  redigida      boolean not null default false,
  apagada       boolean not null default false,
  responde_a    bigint references wa.mensagens,
  tem_midia     boolean not null default false,
  midia_meta    jsonb,
  transcrito    boolean not null default false,
  hash          text not null,
  texto_tsv     tsvector generated always as (to_tsvector('portuguese'::regconfig, coalesce(texto, ''))) stored,
  ingerido_em   timestamptz not null default now(),
  unique (chat_id, stanza_id),
  unique (chat_id, local_pk),
  check (not (redigida or apagada) or texto is null)
);
comment on column wa.mensagens.tipo is 'ZMESSAGETYPE do WhatsApp (mapa confirmado na Fase 0).';
comment on column wa.mensagens.midia_meta is 'Só metadado (tipo, nome, tamanho, duração). O arquivo nunca sobe.';
create index if not exists mensagens_chat_data_idx on wa.mensagens (chat_id, enviada_em desc, id desc);
create index if not exists mensagens_tsv_idx on wa.mensagens using gin (texto_tsv);
create index if not exists mensagens_texto_trgm_idx on wa.mensagens using gin (texto extensions.gin_trgm_ops);
create index if not exists mensagens_autor_idx on wa.mensagens (autor_id);
create index if not exists mensagens_responde_a_idx on wa.mensagens (responde_a) where responde_a is not null;
create trigger mensagens_exigir_chat_liberado before insert on wa.mensagens
  for each row execute function wa.trg_exigir_chat_liberado();

-- ---------------------------------------------------------------- links
create table if not exists wa.links (
  id               bigint generated always as identity primary key,
  chat_id          uuid not null references wa.chats,
  mensagem_id      bigint not null references wa.mensagens,
  autor_id         uuid references wa.participantes,
  url              text not null,
  url_norm         text not null,
  dominio          text not null,
  titulo           text,
  compartilhado_em timestamptz not null,
  vezes            int not null default 1,
  tags             text[],
  unique (chat_id, url_norm)
);
comment on column wa.links.mensagem_id is 'Primeira mensagem que trouxe o link; as demais ficam em wa.link_mencoes.';
create index if not exists links_dominio_idx on wa.links (dominio);
create index if not exists links_chat_data_idx on wa.links (chat_id, compartilhado_em desc);
create index if not exists links_data_idx on wa.links (compartilhado_em desc);
create index if not exists links_url_trgm_idx on wa.links using gin (url_norm extensions.gin_trgm_ops);
create index if not exists links_mensagem_idx on wa.links (mensagem_id);

-- Menções do mesmo link (acréscimo ao desenho): torna registrar_link idempotente.
create table if not exists wa.link_mencoes (
  link_id     bigint not null references wa.links on delete cascade,
  mensagem_id bigint not null references wa.mensagens,
  primary key (link_id, mensagem_id)
);
create index if not exists link_mencoes_mensagem_idx on wa.link_mencoes (mensagem_id);

-- ---------------------------------------------------------------- perguntas
create table if not exists wa.perguntas (
  id                   bigint generated always as identity primary key,
  chat_id              uuid not null references wa.chats,
  mensagem_id          bigint not null unique references wa.mensagens,
  autor_id             uuid references wa.participantes,
  texto_norm           text not null,
  topico               text,
  status               text not null default 'aberta' check (status in ('aberta','respondida','ignorada')),
  respondida_por_msg   bigint references wa.mensagens,
  dirigida_ao_dono boolean not null default false,
  embedding            public.vector(1536),
  detectada_em         timestamptz not null default now()
);
create index if not exists perguntas_chat_status_idx on wa.perguntas (chat_id, status);
create index if not exists perguntas_embedding_idx on wa.perguntas using hnsw (embedding public.vector_cosine_ops);

-- ---------------------------------------------------------------- resumos e decisões
create table if not exists wa.resumos (
  id          bigint generated always as identity primary key,
  chat_id     uuid not null references wa.chats,
  periodo     text not null check (periodo in ('dia','semana')),
  data_ref    date not null,
  discutido   jsonb not null check (jsonb_typeof(discutido) = 'array'),
  decidido    jsonb not null check (jsonb_typeof(decidido) = 'array'),
  olhar       jsonb not null check (jsonb_typeof(olhar) = 'array'),
  n_mensagens int not null check (n_mensagens >= 0),
  msg_de      bigint,
  msg_ate     bigint,
  modelo      text,
  gerado_em   timestamptz not null default now(),
  unique (chat_id, periodo, data_ref)
);
create index if not exists resumos_chat_data_idx on wa.resumos (chat_id, periodo, data_ref desc);

create table if not exists wa.decisoes (
  id           bigint generated always as identity primary key,
  chat_id      uuid not null references wa.chats,
  resumo_id    bigint references wa.resumos,
  texto        text not null,
  mensagem_ref bigint references wa.mensagens,
  decidida_em  date,
  responsavel  text,
  status       text not null default 'registrada',
  criada_em    timestamptz not null default now()
);
create index if not exists decisoes_chat_idx on wa.decisoes (chat_id, decidida_em desc);
create unique index if not exists decisoes_resumo_texto_uidx on wa.decisoes (resumo_id, md5(texto)) where resumo_id is not null;

-- ---------------------------------------------------------------- aprendizados
create table if not exists wa.aprendizados (
  id            bigint generated always as identity primary key,
  chat_id       uuid references wa.chats,
  titulo        text not null,
  corpo         text not null,
  tags          text[],
  fontes        bigint[] not null check (cardinality(fontes) >= 1),
  confianca     smallint check (confianca between 1 and 5),
  status        text not null default 'candidato' check (status in ('candidato','aprovado','descartado')),
  embedding     public.vector(1536),
  busca_tsv     tsvector generated always as (to_tsvector('portuguese'::regconfig, coalesce(titulo,'') || ' ' || coalesce(corpo,''))) stored,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
comment on column wa.aprendizados.fontes is 'Ids de wa.mensagens. Rastreabilidade obrigatória: sem fonte não existe aprendizado.';
create unique index if not exists aprendizados_chat_titulo_uidx on wa.aprendizados (chat_id, md5(titulo));
create index if not exists aprendizados_chat_status_idx on wa.aprendizados (chat_id, status);
create index if not exists aprendizados_tsv_idx on wa.aprendizados using gin (busca_tsv);
create index if not exists aprendizados_tags_idx on wa.aprendizados using gin (tags);
create index if not exists aprendizados_embedding_idx on wa.aprendizados using hnsw (embedding public.vector_cosine_ops);
create trigger aprendizados_atualizado_em before update on wa.aprendizados
  for each row execute function wa.set_atualizado_em();

-- ---------------------------------------------------------------- sugestões e fila de envio
create table if not exists wa.sugestoes_resposta (
  id                  bigint generated always as identity primary key,
  chat_id             uuid not null references wa.chats,
  mensagem_origem     bigint not null references wa.mensagens,
  texto_sugerido      text not null,
  texto_final         text,
  status              text not null default 'sugerida'
                      check (status in ('sugerida','aprovada','editada','enviada','rejeitada','expirada','reprovada_filtro')),
  exige_revisao_forte boolean not null default false,
  autoria             jsonb not null,
  validacoes          jsonb not null,
  motivo_rejeicao     text,
  decidida_por        uuid,
  decidida_em         timestamptz,
  criada_em           timestamptz not null default now(),
  atualizado_em       timestamptz not null default now()
);
create index if not exists sugestoes_status_idx on wa.sugestoes_resposta (status, criada_em desc);
create index if not exists sugestoes_chat_idx on wa.sugestoes_resposta (chat_id, criada_em desc);
create index if not exists sugestoes_origem_idx on wa.sugestoes_resposta (mensagem_origem);
create trigger sugestoes_atualizado_em before update on wa.sugestoes_resposta
  for each row execute function wa.set_atualizado_em();

create table if not exists wa.fila_envio (
  id            bigint generated always as identity primary key,
  sugestao_id   bigint not null unique references wa.sugestoes_resposta,
  destino_jid   text not null,
  texto         text not null,
  texto_hash    text not null check (length(texto_hash) = 64),
  aprovado_por  uuid not null,
  aprovado_em   timestamptz not null,
  status        text not null default 'pendente'
                check (status in ('pendente','copiado','aberto_no_whatsapp','confirmado_pelo_dono','cancelado','expirado')),
  expira_em     timestamptz not null default (now() + interval '30 minutes'),
  confirmado_em timestamptz
);
comment on table wa.fila_envio is 'Nada sai sem aprovação: linha só nasce em wa.aprovar_sugestao (sem insert direto).';
create index if not exists fila_envio_status_idx on wa.fila_envio (status, expira_em);

-- ---------------------------------------------------------------- auditoria, execuções, config
create table if not exists wa.auditoria (
  id      bigint generated always as identity primary key,
  quando  timestamptz not null default now(),
  ator    text not null,
  acao    text not null,
  alvo    text,
  detalhe jsonb
);
create index if not exists auditoria_quando_idx on wa.auditoria (quando desc);
create index if not exists auditoria_acao_idx on wa.auditoria (acao, quando desc);

-- Auditoria é só-acréscimo: ninguém atualiza, apaga ou trunca.
create or replace function wa.trg_auditoria_imutavel() returns trigger
language plpgsql set search_path = ''
as $$
begin
  raise exception 'wa.auditoria é imutável (%)', tg_op using errcode = '42501';
end;
$$;
create trigger auditoria_sem_update_delete before update or delete on wa.auditoria
  for each row execute function wa.trg_auditoria_imutavel();
create trigger auditoria_sem_truncate before truncate on wa.auditoria
  for each statement execute function wa.trg_auditoria_imutavel();

-- Toda mudança de modo de chat (allowlist) é auditada, venha de onde vier.
create or replace function wa.trg_chat_modo_auditar() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and new.modo = 'off' then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.modo is not distinct from old.modo then
    return new;
  end if;
  insert into wa.auditoria (ator, acao, alvo, detalhe)
  values (
    coalesce(auth.uid()::text, 'worker'),
    'altera_modo_chat',
    new.id::text,
    jsonb_build_object('de', case when tg_op = 'UPDATE' then old.modo end, 'para', new.modo, 'jid', new.jid)
  );
  return new;
end;
$$;
create trigger chats_auditar_modo after insert or update of modo on wa.chats
  for each row execute function wa.trg_chat_modo_auditar();

create table if not exists wa.ingestao_execucoes (
  id                   bigint generated always as identity primary key,
  iniciou_em           timestamptz,
  terminou_em          timestamptz,
  lidas                int,
  gravadas             int,
  descartadas_sensivel int,
  erro                 text
);
create index if not exists ingestao_execucoes_inicio_idx on wa.ingestao_execucoes (iniciou_em desc);

create table if not exists wa.config (
  chave         text primary key,
  valor         jsonb not null,
  atualizado_em timestamptz not null default now()
);
comment on table wa.config is 'Chaves de operação. kill_switch_envio=true faz o helper de envio parar tudo.';
insert into wa.config (chave, valor) values ('kill_switch_envio', 'false'::jsonb)
on conflict (chave) do nothing;

-- Destino das notificações (grupo de WhatsApp). Linha única; jid ainda a preencher.
create table if not exists wa.notificacao_destino (
  id             boolean primary key default true check (id),
  jid            text,
  nome           text,
  ativo          boolean not null default false,
  atualizado_por uuid,
  atualizado_em  timestamptz not null default now(),
  check (not ativo or jid is not null)
);
comment on column wa.notificacao_destino.jid is 'JID do grupo de notificações. A preencher; só pode ativar com jid definido.';
create trigger notificacao_destino_atualizado_em before update on wa.notificacao_destino
  for each row execute function wa.set_atualizado_em();
insert into wa.notificacao_destino (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------- segurança por padrão
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'wa' loop
    execute format('alter table wa.%I enable row level security', t);
    execute format('revoke all on wa.%I from public, anon, authenticated', t);
  end loop;
end;
$$;
revoke all on all sequences in schema wa from public, anon, authenticated;
revoke all on all functions in schema wa from public, anon, authenticated;
revoke all on schema wa from public, anon, authenticated;
grant usage on schema wa to service_role;
grant all on all tables in schema wa to service_role;
grant all on all sequences in schema wa to service_role;
grant execute on all functions in schema wa to service_role;
