BEGIN;
-- Instalação standalone. Aplicar uma vez em projeto vazio.

-- Inteligência de WhatsApp (v1), migration 1 de 3: schema `wa`, tabelas, índices e travas.
-- Tudo vive no schema novo `wa`. Nenhuma tabela existente é alterada.
-- Única dependência de fora: wa.admins (leitura, para identificar admin).
-- Seguro por padrão: RLS ligada e acesso revogado já nesta migration; as policies e grants
-- entram na migration 2. Entre as duas, ninguém além de postgres/service_role alcança os dados.

create schema if not exists extensions;

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
  embedding            double precision[],
  detectada_em         timestamptz not null default now()
);
create index if not exists perguntas_chat_status_idx on wa.perguntas (chat_id, status);

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
  embedding     double precision[],
  busca_tsv     tsvector generated always as (to_tsvector('portuguese'::regconfig, coalesce(titulo,'') || ' ' || coalesce(corpo,''))) stored,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
comment on column wa.aprendizados.fontes is 'Ids de wa.mensagens. Rastreabilidade obrigatória: sem fonte não existe aprendizado.';
create unique index if not exists aprendizados_chat_titulo_uidx on wa.aprendizados (chat_id, md5(titulo));
create index if not exists aprendizados_chat_status_idx on wa.aprendizados (chat_id, status);
create index if not exists aprendizados_tsv_idx on wa.aprendizados using gin (busca_tsv);
create index if not exists aprendizados_tags_idx on wa.aprendizados using gin (tags);
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

-- Inteligência de WhatsApp (v1), migration 2 de 3: RLS, policies e grants.
-- Regra: leitura só para admin do portal (wa.is_admin) via authenticated; escrita de dados
-- de conteúdo só por service_role (worker e rotas server-side). anon não recebe nada.

-- Garante RLS ligada em todas as tabelas de wa (idempotente com a migration 1).
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'wa' loop
    execute format('alter table wa.%I enable row level security', t);
  end loop;
end;
$$;

-- Leitura: admin em todas as tabelas.
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'wa' loop
    execute format('drop policy if exists %I on wa.%I', t || '_admin_select', t);
    execute format('create policy %I on wa.%I for select to authenticated using (wa.is_admin())',
                   t || '_admin_select', t);
  end loop;
end;
$$;

-- Escritas permitidas ao admin logado, restritas por coluna:
--  sugestoes_resposta: status, texto_final, motivo_rejeicao (sugestão reprovada no filtro é intocável)
drop policy if exists sugestoes_resposta_admin_update on wa.sugestoes_resposta;
create policy sugestoes_resposta_admin_update on wa.sugestoes_resposta for update to authenticated
  using (wa.is_admin() and status <> 'reprovada_filtro')
  with check (wa.is_admin() and status <> 'reprovada_filtro');

--  aprendizados: status (aprovar ou descartar candidato)
drop policy if exists aprendizados_admin_update on wa.aprendizados;
create policy aprendizados_admin_update on wa.aprendizados for update to authenticated
  using (wa.is_admin()) with check (wa.is_admin());

--  config (kill switch) e notificacao_destino
drop policy if exists config_admin_update on wa.config;
create policy config_admin_update on wa.config for update to authenticated
  using (wa.is_admin()) with check (wa.is_admin());
drop policy if exists notificacao_destino_admin_update on wa.notificacao_destino;
create policy notificacao_destino_admin_update on wa.notificacao_destino for update to authenticated
  using (wa.is_admin()) with check (wa.is_admin());

-- Quem decidiu e quando: preenchido pelo banco, não pelo cliente.
create or replace function wa.trg_sugestao_decisao() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if auth.uid() is not null and new.status is distinct from old.status then
    new.decidida_por := auth.uid();
    new.decidida_em := now();
  end if;
  return new;
end;
$$;
drop trigger if exists sugestoes_decisao on wa.sugestoes_resposta;
create trigger sugestoes_decisao before update on wa.sugestoes_resposta
  for each row execute function wa.trg_sugestao_decisao();

-- Alterações de config e destino de notificação são auditadas.
create or replace function wa.trg_auditar_config() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into wa.auditoria (ator, acao, alvo, detalhe)
  values (
    coalesce(auth.uid()::text, 'worker'),
    'altera_' || tg_table_name,
    case when tg_table_name = 'config' then to_jsonb(new)->>'chave' else 'unico' end,
    case when tg_table_name = 'config'
         then jsonb_build_object('de', to_jsonb(old)->'valor', 'para', to_jsonb(new)->'valor')
         else jsonb_build_object('jid_antes', to_jsonb(old)->>'jid', 'jid_depois', to_jsonb(new)->>'jid',
                                 'ativo_antes', to_jsonb(old)->'ativo', 'ativo_depois', to_jsonb(new)->'ativo') end
  );
  return new;
end;
$$;
drop trigger if exists config_auditar on wa.config;
create trigger config_auditar after update on wa.config
  for each row execute function wa.trg_auditar_config();
drop trigger if exists notificacao_destino_auditar on wa.notificacao_destino;
create trigger notificacao_destino_auditar after update on wa.notificacao_destino
  for each row execute function wa.trg_auditar_config();

-- Grants: authenticated lê (RLS filtra para admin) e atualiza só colunas listadas.
grant usage on schema wa to authenticated;
grant execute on function wa.is_admin() to authenticated;
grant select on all tables in schema wa to authenticated;
grant update (status, texto_final, motivo_rejeicao) on wa.sugestoes_resposta to authenticated;
grant update (status) on wa.aprendizados to authenticated;
grant update (valor) on wa.config to authenticated;
grant update (jid, nome, ativo, atualizado_por) on wa.notificacao_destino to authenticated;
grant usage on all sequences in schema wa to service_role;

-- Inteligência de WhatsApp (v1), migration 3 de 3: RPCs do worker, RPCs/views do portal.
-- Funções do worker: só service_role. Funções do portal: authenticated, mas cada uma
-- reforça admin (RLS em views/leituras; checagem explícita nas que escrevem).

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
  p_embedding double precision[] default null
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

-- Inteligência de WhatsApp (v1), migration 4: pendências de resposta de DMs.
-- Guarda só metadado e uma síntese curta (pedido, tipo de resposta). Nunca texto redigido para envio.
-- Acesso: admin lê (wa.is_admin); admin atualiza só `status` (auditado); escrita de conteúdo só service_role via RPC.
-- Trava: só aceita chat liberado (modo <> off), tipo 'direto', e mensagem do próprio chat e da outra pessoa.

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

-- Aprendizados por tema do dono (camada curta, separada do resumo diário).
-- Aditiva: colunas novas, chave de config e função com parâmetro novo. Nenhuma linha é apagada.

alter table wa.aprendizados add column if not exists tema text;
alter table wa.aprendizados add column if not exists motivo_descarte text;
alter table wa.aprendizados drop constraint if exists aprendizados_motivo_descarte_check;
alter table wa.aprendizados add constraint aprendizados_motivo_descarte_check
  check (motivo_descarte is null or motivo_descarte in ('suporte', 'fora_do_tema'));
comment on column wa.aprendizados.tema is 'Nome de um tema de wa.config[aprendizado_temas]. Nulo em aprendizado descartado por falta de tema.';
comment on column wa.aprendizados.motivo_descarte is 'Preenchido quando a reclassificação descartou: suporte ou fora_do_tema. Descarte manual do admin deixa nulo.';
create index if not exists aprendizados_tema_idx on wa.aprendizados (tema, atualizado_em desc);

-- Lista editável de temas: [{ "nome": "...", "descricao": "..." }]. O worker lê daqui; nada fica fixo no código.
insert into wa.config (chave, valor) values ('aprendizado_temas', $json$[]$json$::jsonb)
on conflict (chave) do nothing;

-- View com as colunas novas no fim (create or replace exige a ordem anterior).
create or replace view wa.v_aprendizados with (security_invoker = true) as
select a.id, a.chat_id, c.nome as chat_nome, a.titulo, a.corpo, a.tags, a.fontes, a.confianca,
       a.status, a.criado_em, a.atualizado_em, a.tema, a.motivo_descarte
from wa.aprendizados a
left join wa.chats c on c.id = a.chat_id;

-- Função com p_tema. Troca de assinatura: remove a anterior para não deixar sobrecarga ambígua.
drop function if exists wa.registrar_aprendizado(uuid, text, text, bigint[], text[], smallint, double precision[]);
create or replace function wa.registrar_aprendizado(
  p_chat_id   uuid,
  p_titulo    text,
  p_corpo     text,
  p_fontes    bigint[],
  p_tags      text[] default null,
  p_confianca smallint default null,
  p_embedding double precision[] default null,
  p_tema      text default null
) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_id     bigint;
  v_validas int;
  v_dist    int;
  v_tipo    text;
begin
  if p_fontes is null or cardinality(p_fontes) < 1 then
    raise exception 'wa.registrar_aprendizado: fontes obrigatórias';
  end if;
  if p_corpo is null or char_length(p_corpo) > 200 then
    raise exception 'wa.registrar_aprendizado: corpo acima de 200 caracteres';
  end if;
  if p_chat_id is not null then
    perform wa.exigir_chat_liberado(p_chat_id);
    select tipo into v_tipo from wa.chats where id = p_chat_id;
    if v_tipo = 'direto' then
      raise exception 'wa.registrar_aprendizado: aprendizado nunca vem de mensagem direta';
    end if;
  end if;
  select count(distinct f) into v_dist from unnest(p_fontes) as f;
  select count(*) into v_validas from wa.mensagens
   where id = any(p_fontes) and (p_chat_id is null or chat_id = p_chat_id);
  if v_validas <> v_dist then
    raise exception 'wa.registrar_aprendizado: fontes inexistentes ou de outro chat';
  end if;

  insert into wa.aprendizados as a (chat_id, titulo, corpo, tags, fontes, confianca, embedding, tema)
  values (p_chat_id, p_titulo, p_corpo, p_tags, p_fontes, p_confianca, p_embedding, p_tema)
  on conflict (chat_id, md5(titulo)) do update
    set corpo = excluded.corpo,
        tags = coalesce(excluded.tags, a.tags),
        fontes = (select array_agg(distinct x) from unnest(a.fontes || excluded.fontes) as x),
        confianca = coalesce(excluded.confianca, a.confianca),
        embedding = coalesce(excluded.embedding, a.embedding),
        tema = coalesce(excluded.tema, a.tema)
    where a.status = 'candidato'
  returning a.id into v_id;
  if v_id is null then
    select id into v_id from wa.aprendizados
     where chat_id is not distinct from p_chat_id and md5(titulo) = md5(p_titulo);
  end if;
  return v_id;
end;
$$;

revoke all on function wa.registrar_aprendizado(uuid, text, text, bigint[], text[], smallint, double precision[], text) from public, anon, authenticated;
grant execute on function wa.registrar_aprendizado(uuid, text, text, bigint[], text[], smallint, double precision[], text) to service_role;
revoke all on wa.v_aprendizados from public, anon;
grant select on wa.v_aprendizados to authenticated, service_role;


-- Inteligência de WhatsApp (v1), migration 5: marca se o contato do DM está salvo na agenda do dono.
-- Regra: só contatos salvos entram no digest "Quem espera sua resposta" e nas pendências visíveis no portal.
-- Não guarda telefone. null = ainda não avaliado; true = contato salvo; false = número desconhecido.

alter table wa.chats add column if not exists contato boolean;
comment on column wa.chats.contato is 'DM com contato salvo na agenda do dono. null = não avaliado; true = salvo; false = número desconhecido. Nunca guarda telefone.';

-- Mesmas colunas e ordem da versão anterior; `contato` acrescentada ao final.
create or replace view wa.v_pendencias with (security_invoker = true) as
select p.id, p.chat_id, p.contato_nome, c.nome as chat_nome, p.espera_desde, p.pedido, p.urgencia,
       p.tipo_resposta, p.audio_sem_transcricao, p.status, p.gerado_em, c.contato
from wa.pendencias_resposta p
join wa.chats c on c.id = p.chat_id
order by case p.urgencia when 'alta' then 1 when 'media' then 2 else 3 end, p.espera_desde;

revoke all on wa.v_pendencias from public, anon;
grant select on wa.v_pendencias to authenticated, service_role;

-- Inteligência de WhatsApp (v1), migration 6: portal só mostra pendências de contatos salvos.
-- Mesmas colunas e ordem; filtra `c.contato is true` e ordena pela mensagem recebida mais recente primeiro.
-- Não expõe telefone. A tabela mensagens entra só no join de ordenação.

create or replace view wa.v_pendencias with (security_invoker = true) as
select p.id, p.chat_id, p.contato_nome, c.nome as chat_nome, p.espera_desde, p.pedido, p.urgencia,
       p.tipo_resposta, p.audio_sem_transcricao, p.status, p.gerado_em, c.contato
from wa.pendencias_resposta p
join wa.chats c on c.id = p.chat_id
join wa.mensagens m on m.id = p.mensagem_id
where c.contato is true
order by m.enviada_em desc;

revoke all on wa.v_pendencias from public, anon;
grant select on wa.v_pendencias to authenticated, service_role;

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

-- Inteligência de WhatsApp: favoritos em links.
-- Duas colunas em wa.links (menor mudança): favorito e favoritado_em. Sem tabela nova.
-- Acesso: admin lê (policy de select existente) e atualiza SOMENTE a coluna `favorito` (grant por coluna + RLS).
-- favoritado_em é mantido pelo banco (trigger), nunca pelo cliente. O worker (registrar_link) não toca nas duas colunas.

alter table wa.links add column if not exists favorito boolean not null default false;
alter table wa.links add column if not exists favoritado_em timestamptz;

create index if not exists links_favoritos_idx on wa.links (favoritado_em desc) where favorito;

-- Coerência: favoritado_em existe se e somente se favorito.
create or replace function wa.trg_link_favorito() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.favorito is distinct from old.favorito then
    new.favoritado_em := case when new.favorito then now() else null end;
  else
    new.favoritado_em := old.favoritado_em;
  end if;
  return new;
end;
$$;
drop trigger if exists links_favorito on wa.links;
create trigger links_favorito before update of favorito, favoritado_em on wa.links
  for each row execute function wa.trg_link_favorito();

-- RLS: só admin atualiza.
drop policy if exists links_admin_update on wa.links;
create policy links_admin_update on wa.links for update to authenticated
  using (wa.is_admin()) with check (wa.is_admin());

revoke update on wa.links from public, anon, authenticated;
grant update (favorito) on wa.links to authenticated;

-- View: colunas novas no fim (create or replace view só permite acrescentar ao final).
create or replace view wa.v_links with (security_invoker = true) as
select l.id, l.chat_id, c.nome as chat_nome, l.mensagem_id, l.url, l.url_norm, l.dominio, l.titulo,
       l.compartilhado_em, l.vezes, l.tags,
       l.autor_id, coalesce(p.nome, p.push_name) as autor_nome,
       l.favorito, l.favoritado_em
from wa.links l
join wa.chats c on c.id = l.chat_id
left join wa.participantes p on p.id = l.autor_id;

revoke all on wa.v_links from public, anon;
grant select on wa.v_links to authenticated, service_role;

-- Sem embeddings gerados nesta versão; arrays reservados para uma futura integração.
revoke all on function wa.aprovar_sugestao(bigint,text) from public, anon, authenticated, service_role;
revoke all on wa.admins from anon, authenticated;
revoke all on all functions in schema wa from public, anon;
-- Papel local do worker, criado sem login/senha na migration. Configurar senha por canal seguro.
do $$ begin
 if not exists(select 1 from pg_roles where rolname='wa_worker') then create role wa_worker nologin; end if;
end $$;
grant usage on schema wa to wa_worker;
grant select on all tables in schema wa to wa_worker;
revoke all on wa.admins from wa_worker;
grant insert, update on wa.chats, wa.participantes, wa.mensagens, wa.perguntas,
 wa.resumos, wa.decisoes, wa.aprendizados, wa.pendencias_resposta, wa.ingestao_execucoes to wa_worker;
grant insert on wa.auditoria to wa_worker;
grant usage, select on all sequences in schema wa to wa_worker;
do $$ declare t text; f record; begin
 foreach t in array array['chats','participantes','mensagens','perguntas','resumos','decisoes','aprendizados','pendencias_resposta','ingestao_execucoes','auditoria','links','link_mencoes','config','notificacao_destino','fila_envio'] loop
  execute format('create policy worker_read on wa.%I for select to wa_worker using (true)',t);
 end loop;
 foreach t in array array['chats','participantes','mensagens','perguntas','resumos','decisoes','aprendizados','pendencias_resposta','ingestao_execucoes'] loop
  execute format('create policy worker_insert on wa.%I for insert to wa_worker with check (true)',t);
  execute format('create policy worker_update on wa.%I for update to wa_worker using (true) with check (true)',t);
 end loop;
 create policy worker_audit on wa.auditoria for insert to wa_worker with check (true);
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='wa' and p.proname in ('exigir_chat_liberado','upsert_mensagem','upsert_mensagens','registrar_link','registrar_resumo','registrar_aprendizado','registrar_pendencia','fechar_pendencias','reivindicar_envio_resposta','concluir_envio_resposta') loop
  execute format('grant execute on function %s to wa_worker',f.signature);
 end loop;
end $$;

COMMIT;
