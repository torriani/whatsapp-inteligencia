# Inteligência de WhatsApp

**Autor: Juliano Torriani · Licença MIT · Interface DS Azul.**

Sistema pessoal para macOS: leitura autorizada do WhatsApp Desktop, resumos, aprendizados, links e pendências de resposta. O dono escreve e aprova cada resposta antes do envio.

## Instalação assistida com Codex

Baixe este repositório, abra a pasta no Codex e envie:

> Leia SETUP.md e PROMPT.md, configure e valide o sistema nesta máquina usando o código incluído. Não envie mensagens reais sem minha aprovação. Continue as etapas independentes enquanto aguarda contas, permissões ou pareamento.

## Início rápido

Node 22.16+ e npm. A ingestão real requer macOS, WhatsApp Desktop e permissões locais. PostgreSQL/Supabase, conta de modelo e WhatsApp são seus.

```sh
npm run setup
npm run doctor
npm run verify
```

Depois siga [SETUP.md](SETUP.md) para banco, login e configuração local. Com o portal configurado:

```sh
npm run dev
```

Abra http://localhost:3040. Esse comando não liga envios nem agendamento.

## Componentes incluídos

| Pasta | Conteúdo |
|---|---|
| portal/ | Next.js independente, login Supabase, visão geral, dashboard, chats, pendências, links, aprendizados, resumos e configurações |
| worker/ | Leitura macOS, filtros, resumos, consumidor, plists e testes |
| gateway/ | CLI/daemon local, reservas duráveis de envio e backend falso de teste |
| supabase/ | Migration standalone, bootstrap admin e testes SQL |
| reference/ | Contratos e migrations históricas, não aplicar junto da migration standalone |
| PROMPT.md | Requisitos completos e código incorporado para o Codex |

Embeddings não são calculados nesta versão; campos reservados usam arrays PostgreSQL, sem dependência de pgvector. Áudios são sinalizados, não transcritos. Respostas são manuais, não imitam voz de terceiros.

## Validação e limites

O portal, worker e gateway têm testes locais; a migration e o fluxo de fila foram testados em PostgreSQL isolado. Login real Supabase, permissões macOS, pareamento e recebimento no WhatsApp precisam de validação na sua instalação. Confira [VALIDACAO.md](VALIDACAO.md).

As chaves de envio e DMs começam desligadas. O gateway utiliza cliente WhatsApp não oficial e pode sofrer incompatibilidades/restrições de conta. Nunca use este pacote para disparo em massa. Leia o guia antes de habilitar envios.

Não versione configurações pessoais, conversas, backups, bancos, sessão pareada ou segredos. O gateway mantém sua licença original; demais arquivos estão sob a licença MIT da raiz.
