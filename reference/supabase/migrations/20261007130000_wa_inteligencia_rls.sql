-- Inteligência de WhatsApp (v1), migration 2 de 3: RLS, policies e grants.
-- Regra: leitura só para admin do portal (wa.is_admin) via authenticated; escrita de dados
-- de conteúdo só por service_role (worker e rotas server-side). anon não recebe nada.
-- Reversão: supabase/rollbacks/20261007130000_wa_inteligencia_rls.rollback.sql.txt

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
