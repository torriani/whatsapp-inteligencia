-- Inteligência de WhatsApp (v1), migration 5: marca se o contato do DM está salvo na agenda do dono.
-- Regra: só contatos salvos entram no digest "Quem espera sua resposta" e nas pendências visíveis no portal.
-- Não guarda telefone. null = ainda não avaliado; true = contato salvo; false = número desconhecido.
-- Reversão: supabase/rollbacks/20261008120000_wa_chats_contato.rollback.sql.txt

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
