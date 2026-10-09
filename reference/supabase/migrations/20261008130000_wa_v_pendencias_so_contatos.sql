-- Inteligência de WhatsApp (v1), migration 6: portal só mostra pendências de contatos salvos.
-- Mesmas colunas e ordem; filtra `c.contato is true` e ordena pela mensagem recebida mais recente primeiro.
-- Não expõe telefone. A tabela mensagens entra só no join de ordenação.
-- Reversão: supabase/rollbacks/20261008130000_wa_v_pendencias_so_contatos.rollback.sql.txt

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
