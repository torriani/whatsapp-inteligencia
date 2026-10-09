import { createClient } from "@/lib/supabase/server";
import { EmptyState } from "@/components/EmptyState";
import { EstadoErro, Etiqueta, Painel, TituloPagina } from "@/components/operacao/whatsapp/Blocos";
import { carregarConfiguracoes } from "@/lib/whatsapp/dados";
import { formatarData, formatarDataHora } from "@/lib/whatsapp/formato";
import { exigirAdminDaRequisicao } from "@/lib/whatsapp/guarda";

export const dynamic = "force-dynamic";

const MODOS: Record<string, string> = {
  registrar: "Somente registrar",
  inteligencia: "Inteligência",
  dm_sugerir: "Mensagens diretas com sugestão",
};

export default async function ConfiguracoesWhatsappPage() {
  await exigirAdminDaRequisicao();
  const supabase = await createClient();
  const r = await carregarConfiguracoes(supabase);

  return (
    <div className="space-y-6">
      <TituloPagina titulo="Configurações" descricao="Somente leitura nesta versão. A liberação de chats é feita fora do portal." />

      {!r.ok ? (
        <EstadoErro mensagem={r.erro} />
      ) : (
        <>
          <Painel titulo="Destino de notificação" descricao="Grupo que recebe os resumos enviados.">
            {r.dados.destino ? (
              <dl className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <Item rotulo="Situação">
                  <Etiqueta tom={r.dados.destino.ativo ? "destaque" : "neutro"}>{r.dados.destino.ativo ? "Ativo" : "Inativo"}</Etiqueta>
                </Item>
                <Item rotulo="Grupo">{r.dados.destino.nome ?? "Não definido"}</Item>
                <Item rotulo="Identificador">{r.dados.destino.jid ? "Preenchido" : "A preencher"}</Item>
              </dl>
            ) : (
              <p className="font-sans text-sm text-ink-muted">Nenhum destino de notificação cadastrado.</p>
            )}
          </Painel>

          {r.dados.chats.length === 0 ? (
            <EmptyState titulo="Nenhum chat liberado" descricao="Os chats liberados para leitura aparecem aqui, com o modo de cada um." />
          ) : (
            <Painel titulo="Chats liberados" descricao="Somente estes chats são lidos pelo worker.">
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-divider font-sans text-sm">
                  <thead>
                    <tr>
                      {["Chat", "Tipo", "Modo", "Liberado em", "Retenção", "Mensagens"].map((t) => (
                        <th key={t} className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-ink-muted">{t}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-divider">
                    {r.dados.chats.map((c) => (
                      <tr key={c.id}>
                        <td className="px-3 py-3 text-ink">{c.nome}</td>
                        <td className="px-3 py-3 text-ink-muted">{c.tipo === "grupo" ? "Grupo" : c.tipo === "comunidade" ? "Comunidade" : "Direto"}</td>
                        <td className="px-3 py-3 text-ink-muted">{MODOS[c.modo] ?? c.modo}</td>
                        <td className="whitespace-nowrap px-3 py-3 text-ink-muted">{c.liberado_em ? formatarData(c.liberado_em) : "sem registro"}</td>
                        <td className="px-3 py-3 text-ink-muted">{c.retencao_dias ? `${c.retencao_dias} dias` : "Guardar sempre"}</td>
                        <td className="px-3 py-3 text-ink-muted">{c.n_mensagens}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Painel>
          )}
          {r.dados.destino && (
            <p className="font-sans text-xs text-ink-muted">Destino atualizado em {formatarDataHora(r.dados.destino.atualizado_em)}.</p>
          )}
        </>
      )}
    </div>
  );
}

function Item({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="font-sans text-xs font-semibold uppercase tracking-wider text-ink-muted">{rotulo}</dt>
      <dd className="mt-1 font-sans text-sm text-ink">{children}</dd>
    </div>
  );
}
