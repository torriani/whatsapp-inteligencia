\set ON_ERROR_STOP on
begin;
insert into auth.users(id) values ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002');
insert into wa.admins values ('00000000-0000-0000-0000-000000000001');
insert into wa.chats(id,jid,tipo,nome,modo,contato) values ('10000000-0000-0000-0000-000000000001','5500000000000@s.whatsapp.net','direto','Contato Teste','registrar',true);
insert into wa.mensagens(chat_id,local_pk,enviada_em,tipo,texto,hash) values ('10000000-0000-0000-0000-000000000001',1,now(),0,'Pergunta sintética?','fixture') returning id as mensagem_id \gset
insert into wa.pendencias_resposta(chat_id,mensagem_id,espera_desde,pedido,urgencia,tipo_resposta) values ('10000000-0000-0000-0000-000000000001',:mensagem_id,now(),'Pedido sintético','baixa','Resposta manual') returning id as pendencia_id \gset
update wa.config set valor='true' where chave='ENVIO_RESPOSTAS_ATIVO';
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
set local role authenticated;
do $$ begin
 if wa.is_admin() then raise exception 'nonadmin escalated'; end if;
 if exists(select 1 from wa.chats) then raise exception 'RLS leak'; end if;
 begin
  perform wa.aprovar_resposta_pendencia(1,'não autorizado');
  raise exception 'nonadmin approved';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
set local role authenticated;
do $$ begin
 if not wa.is_admin() then raise exception 'admin missing'; end if;
 if not exists(select 1 from wa.chats) then raise exception 'admin cannot read'; end if;
 if has_function_privilege(current_user,'wa.aprovar_sugestao(bigint,text)','EXECUTE') then raise exception 'legacy approval exposed'; end if;
 if has_table_privilege(current_user,'wa.fila_envio','INSERT') then raise exception 'direct queue exposed'; end if;
end $$;
select wa.aprovar_resposta_pendencia(:pendencia_id,'Resposta sintética') as fila_id \gset
select wa.cancelar_resposta_pendencia(:fila_id);
select wa.aprovar_resposta_pendencia(:pendencia_id,'Outra resposta') as fila2 \gset
reset role;
select set_config('request.jwt.claim.sub','',true);
set local role wa_worker;
do $$ begin
 if has_function_privilege(current_user,'wa.aprovar_resposta_pendencia(bigint,text)','EXECUTE') then raise exception 'worker can approve'; end if;
 if has_table_privilege(current_user,'wa.admins','INSERT') then raise exception 'worker can grant admin'; end if;
 if not exists(select 1 from wa.reivindicar_envio_resposta()) then raise exception 'claim missing'; end if;
 if exists(select 1 from wa.reivindicar_envio_resposta()) then raise exception 'duplicate claim'; end if;
end $$;
select wa.concluir_envio_resposta(:fila2,true,'fake-message-id',null);
reset role;
do $$ begin
 if not exists(select 1 from wa.fila_envio where status='enviado') then raise exception 'completion missing'; end if;
 if not exists(select 1 from wa.pendencias_resposta where status='respondida') then raise exception 'pending not closed'; end if;
end $$;
rollback;
