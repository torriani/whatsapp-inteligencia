# Validação local

- Autor: Juliano Torriani.
- Licença MIT na raiz; licença original preservada no gateway.
- Worker: 137 testes aprovados, com configuração/estado isolados e dados fictícios.
- Portal: 66 testes aprovados; TypeScript e build aprovados; login HTTP 200 e redirecionamento protegido 307 sem sessão.
- Gateway: teste integrado fake aprovado: concorrência, duplicidade, incerteza, corrupção e reinício.
- Migration standalone: aplicada em PostgreSQL 16 vazio, transacionalmente, sem dados reais.
- Testes SQL: isolamento admin/não-admin, bloqueio de aprovação pelo worker, aprovação, cancelamento, reivindicação única e conclusão.
- Somente arquivos de código/configuração exemplo foram reunidos; nenhum arquivo de sessão, banco WhatsApp, credencial ou mensagem pessoal integra o pacote.

## Limites

Não foi validada uma sessão autenticada no Supabase do receptor, pareamento ou entrega real de WhatsApp. Esses passos exigem contas e consentimento do receptor. Testes locais não provam operação de produção. CI está incluída, mas só pode ter resultado remoto após publicação.

O arquivo PROMPT contém requisitos adicionais para validar na instalação final. A lista não é uma declaração de que cada requisito possui evidência de produção. Retenção automática, transcrição e geração de respostas não estão disponíveis.
