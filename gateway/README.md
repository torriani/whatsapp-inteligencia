# Gateway local

Autor: Juliano Torriani. Licença MIT.

`npm ci` instala as dependências quando o lockfile estiver presente; `npm install` pode ser usado na primeira instalação. Execute `npm test` para validar o daemon com backend simulado e diretório temporário. Nenhum teste pareia ou envia mensagens reais.

O daemon usa socket Unix privado, diretórios `0700` e arquivos `0600`. O ledger reserva uma chave antes de enviar, grava com arquivo temporário, fsync e rename e mantém envios incertos pendentes. Uma chave pendente exige conferir o WhatsApp antes de qualquer decisão de reenvio. Isso reduz duplicações, mas não promete entrega exatamente uma vez pelo serviço externo.

Só um daemon pode usar um diretório de dados. Encerramentos normais removem o lock; após queda abrupta, o arquivo `send-ledger.json.lock` permanece por segurança. Leia o PID nele, confirme que o processo terminou e que nenhum daemon usa esse diretório antes de remover manualmente o lock. Um socket remanescente também só deve ser removido depois dessa verificação. Nunca apague o ledger para resolver bloqueios; restaure um backup verificado se estiver corrompido.

Use um diretório novo nesta distribuição. Não importe autenticação ou ledger de outras instalações: as chaves de grupo desta versão têm prefixo `group:` e as individuais `to:`. `WAI_GATEWAY_DATA_DIR` e `WAI_GATEWAY_RUNTIME_DIR` permitem definir diretórios exclusivos. Nunca execute cópias do gateway em diretórios diferentes com a mesma sessão de autenticação.

Os testes validam persistência, concorrência, duplicidade, reserva incerta, corrupção e reinício local. Pareamento, entrega real e comportamento do provedor exigem validação na máquina de destino.
