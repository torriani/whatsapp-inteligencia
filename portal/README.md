# Portal de Inteligência WhatsApp

Painel Next.js independente com DS Azul, login Supabase e acesso administrativo via `wa.is_admin()`. Autor: Juliano Torriani. Licença MIT, conforme a raiz do repositório.

## Executar

1. Siga a instalação do banco na raiz deste repositório; aplique todas as migrations e exponha o schema `wa` na API Supabase.
2. Crie seu usuário em Supabase Authentication e conceda o papel administrativo conforme o README da raiz. Sem esse papel, as páginas retornam 404 por proteção de acesso.
3. Copie `.env.example` para `.env.local` e preencha a URL e a chave pública do seu projeto. Nunca coloque a chave `service_role` no portal.
4. Use Node.js 22 ou superior, rode `npm ci` e `npm run dev`.
5. Abra http://localhost:3040 e entre com e-mail e senha.

Para produção: `npm run build` e `npm start`. Configure HTTPS no host e cadastre a URL nas configurações de Auth do Supabase.

## Telas

- Visão geral: grupos e mensagens diretas separados, saúde da ingestão, resumos e tópicos.
- Conversa: mensagens paginadas, busca por período e tratamento de texto sensível.
- Dashboard: métricas, séries por dia e pendências por urgência.
- Links: busca, filtro por grupo e favoritos.
- Aprendizados: filtro por tema, aprovação, descarte e edição de temas.
- Pendências: aprovar texto escrito por você, cancelar fila e controlar envio.
- Resumos enviados: auditoria e detalhe de resumos de grupos e digest de DMs.
- Configurações: leitura do estado de ingestão, destinos e políticas.

O painel usa os dados reais do seu banco. Sem ingestão, as telas ficam vazias. Envio depende do worker e do gateway configurados na raiz; aprovar uma resposta no painel não substitui a execução desses processos. A autorização é verificada novamente nas ações do servidor e no banco por RLS.

## Validação local

`npm test` executa os testes de regras e acesso a dados com fixtures. `npm run typecheck` verifica TypeScript. `npm run build` compila as rotas. Esses checks não comprovam login real, ingestão ou envio: valide o fluxo com seu próprio projeto e WhatsApp antes de habilitar envio.
