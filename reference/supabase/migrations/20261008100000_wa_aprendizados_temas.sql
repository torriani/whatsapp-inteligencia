-- Aprendizados por tema do dono (camada curta, separada do resumo diário).
-- Aditiva: colunas novas, chave de config e função com parâmetro novo. Nenhuma linha é apagada.
-- Reversão: supabase/rollbacks/20261008100000_wa_aprendizados_temas.rollback.sql.txt
begin;

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
drop function if exists wa.registrar_aprendizado(uuid, text, text, bigint[], text[], smallint, public.vector);
create or replace function wa.registrar_aprendizado(
  p_chat_id   uuid,
  p_titulo    text,
  p_corpo     text,
  p_fontes    bigint[],
  p_tags      text[] default null,
  p_confianca smallint default null,
  p_embedding public.vector default null,
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

revoke all on function wa.registrar_aprendizado(uuid, text, text, bigint[], text[], smallint, public.vector, text) from public, anon, authenticated;
grant execute on function wa.registrar_aprendizado(uuid, text, text, bigint[], text[], smallint, public.vector, text) to service_role;
revoke all on wa.v_aprendizados from public, anon;
grant select on wa.v_aprendizados to authenticated, service_role;

commit;
