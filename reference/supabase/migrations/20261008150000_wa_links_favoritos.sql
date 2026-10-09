-- Inteligência de WhatsApp: favoritos em links.
-- Duas colunas em wa.links (menor mudança): favorito e favoritado_em. Sem tabela nova.
-- Acesso: admin lê (policy de select existente) e atualiza SOMENTE a coluna `favorito` (grant por coluna + RLS).
-- favoritado_em é mantido pelo banco (trigger), nunca pelo cliente. O worker (registrar_link) não toca nas duas colunas.
-- Reversão: supabase/rollbacks/20261008150000_wa_links_favoritos.rollback.sql.txt

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
