-- psql -v admin_id=<UUID do seu usuário Auth> -f supabase/bootstrap-admin.sql
\set ON_ERROR_STOP on
insert into wa.admins(user_id) values (:'admin_id'::uuid) on conflict do nothing;
select user_id from wa.admins where user_id=:'admin_id'::uuid;
