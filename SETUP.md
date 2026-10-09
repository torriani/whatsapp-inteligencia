# Instalação e operação

Autor: Juliano Torriani.

## 1. Preparar o computador

Use Node 22.16+ e npm. No Mac, tenha WhatsApp Desktop conectado, sqlite3 e psql. Configure um provedor de modelo próprio; o adaptador incluído usa CLI Claude autenticada. Ter Codex instalado não autentica a CLI Claude.

Rode `npm run setup`, `npm run doctor` e `npm run verify`. Não execute os arquivos de reference como setup.

## 2. Banco próprio

Crie projeto Supabase vazio. Use a string/conexão fornecida pelo seu projeto. Configure PGHOST, PGPORT, PGUSER, PGDATABASE, PGPASSWORD e PGSSLMODE no ambiente protegido; arquivos .env não são carregados automaticamente por psql. Não cole senha no chat.

```sh
npm run db:apply
```

A migration é para instalação nova, aplicada uma vez e de forma transacional. Não é migração de um banco pessoal antigo. Pela CLI Supabase, pode usar o fluxo normal `supabase link` e `supabase db push` num projeto novo designado por você, após conferir o destino. No painel Supabase, acrescente `wa` aos schemas expostos da Data API. RLS e grants permanecem restritos.

A migration cria `wa_worker` sem login. Por conexão administrativa, habilite LOGIN e atribua uma senha própria pelo comando interativo seguro `\password wa_worker` do psql (e `alter role wa_worker login;`). Configure a conexão do worker de acordo com o host/pooler do seu projeto. O acesso administrativo fica apenas no bootstrap. Não use senha de outro aplicativo.

## 3. Login e admin

Crie seu usuário no Supabase Auth. Copie seu UUID, então, na conexão administrativa:

```sh
psql -X -v ON_ERROR_STOP=1 -v admin_id=SEU_UUID -f supabase/bootstrap-admin.sql
```

Copie `portal/.env.example` para `portal/.env.local` e preencha a URL e a chave pública do seu projeto. Autorize `http://localhost:3040` nas URLs do Auth. Rode `npm run dev`, faça login e confira que usuário não admin não acessa o módulo.

## 4. Worker e allowlist

```sh
npm run worker -- init
npm run worker -- status
```

A configuração fica em `~/.wa-intelligence/`, ou WAI_CONFIG_DIR. Mantenha arquivos 0600 e pasta 0700. Em `whatsapp-db.env`, informe WA_DB_HOST, WA_DB_PORT, WA_DB_USER, WA_DB_NAME, WA_DB_PASSWORD e WA_DB_SSLMODE. Para Supabase use TLS; somente para banco local isolado pode usar disable.

Configure WAI_TIMEZONE e autentique o modelo. Escolha um grupo de teste na allowlist; DMs continuam desligadas até sua decisão explícita e arquivo de exclusões válido. Em notificacao.gateway_entry da configuração, use caminho absoluto para `gateway/dist/cli.js` desta instalação. Destinos começam vazios.

Conceda Acesso Total ao Disco ao executável Node efetivamente usado pelo launchd. Não altere banco/WAL do WhatsApp. Rode dry-run primeiro, sem conteúdo de mensagens nos logs; só então ingest e resumo em um grupo autorizado.

## 5. Gateway e piloto

```sh
npm run gateway -- doctor
npm run gateway -- install
```

Antes de pair, confira que é uma instalação nova com diretório próprio. Pareamento é ação humana no celular. Não copie sessões de outro sistema. O número que responde é o pareado no gateway; pode ser diferente do número lido pelo Desktop. `groups` provoca conexão; depois confirme `channel status`.

Para mensagens individuais, configure WAI_GATEWAY_ALLOW_SEND_TO=1 no daemon, respostas.gateway_aceita_to=true localmente e ENVIO_RESPOSTAS_ATIVO=true no banco, apenas após validar o piloto. Notificações usam ENVIO_ATIVO local. kill_switch_envio precisa ser o booleano JSON false. Confira grupo/JID e limite baixo de 5 mensagens/hora.

Escreva e aprove uma resposta no portal para um contato de teste controlado. Execute consumidor em dry-run e depois, com autorização explícita, `node worker/src/respostas-cli.mjs --real`. Confirme o recebimento. Teste a mesma chave, cancelamento e kill switch. Não chamar build ou HTTP 200 de teste de entrega.

## 6. Agendamento

```sh
npm run worker -- plist --print
npm run worker -- plist-pendencias --print
npm run worker -- plist-respostas --print
```

Os comandos sem --print gravam os plists; não carregam automaticamente. Respostas têm dry-run por padrão, --real é opção explícita. Só carregue os agentes depois do piloto. Use caminhos absolutos de instalação estável, mantenha configuração privada fora do Git e confirme execução pelo launchd.

## 7. Pausar e recuperar

Desligue ENVIO_RESPOSTAS_ATIVO, ligue kill_switch_envio e desligue ENVIO_ATIVO local. Descarregue os LaunchAgents se quiser parar os jobs. Uma mensagem já transmitida não pode ser recolhida pelo kill switch.

Envio interrompido: confira no WhatsApp antes de liberar nova aprovação. Ledger pendente/corrompido bloqueia envio. Consulte gateway/README.md antes de remover lock/socket; nunca apagar ledger/auth como tentativa de conserto.

Backup: pare os escritores; faça dump do schema wa, configuração privada e dados do gateway em armazenamento protegido. Teste restauração em ambiente separado. Nunca restaurar ledger antigo e reativar envios automaticamente. A coluna de retenção não executa expiração automática; defina a política antes de operar com dados reais.

## 8. Teste de SQL local

Use somente banco vazio descartável: `supabase/tests/bootstrap-local.sql` cria roles e auth mínimos para testes PostgreSQL, não deve ser aplicado no Supabase real. Aplique a migration e execute `supabase/tests/security.sql`. O teste usa somente dados sintéticos e rollback.
