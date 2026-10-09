import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { EmptyState } from "@/components/EmptyState";
import { EstadoErro, Etiqueta, Painel, TituloPagina } from "@/components/operacao/whatsapp/Blocos";
import { carregarResumosEnviados, type StatusEnvioResumo } from "@/lib/whatsapp/dados";
import { formatarData, formatarDataHora } from "@/lib/whatsapp/formato";
import { exigirAdminDaRequisicao } from "@/lib/whatsapp/guarda";
import { idDetalheDigest, idDetalheResumo } from "@/lib/whatsapp/resumos-detalhe";

export const dynamic = "force-dynamic";

const STATUS: Record<StatusEnvioResumo, { rotulo: string; tom: "neutro" | "destaque" | "alerta" }> = {
  enviado: { rotulo: "Enviado ao WhatsApp", tom: "destaque" },
  "destino-inativo": { rotulo: "Não enviado: destino de notificação inativo", tom: "neutro" },
  aguardando: { rotulo: "Aguardando envio", tom: "alerta" },
};

/** Célula inteira clicável: o link ocupa toda a área, então a linha toda abre o detalhe. */
function Celula({ href, className = "", children }: { href: string; className?: string; children: React.ReactNode }) {
  return (
    <td className="p-0">
      <Link href={href} className={`block px-3 py-3 text-ink-muted ${className}`}>{children}</Link>
    </td>
  );
}

export default async function ResumosEnviadosPage() {
  await exigirAdminDaRequisicao();
  const supabase = await createClient();
  const r = await carregarResumosEnviados(supabase);

  return (
    <div className="space-y-6">
      <TituloPagina titulo="Resumos enviados" descricao="Registro dos resumos gerados e se foram enviados ao WhatsApp. Clique em um para ler." />

      {!r.ok ? (
        <EstadoErro mensagem={r.erro} />
      ) : r.dados.linhas.length === 0 && r.dados.digestsDm.length === 0 ? (
        <EmptyState titulo="Nenhum resumo gerado ainda" descricao="Os resumos diários e semanais aparecem aqui assim que forem gerados, com o status do envio." />
      ) : (
        <>
        {r.dados.linhas.length > 0 && (
        <Painel>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-divider font-sans text-sm">
              <thead>
                <tr>
                  {["Grupo", "Período", "Referência", "Mensagens", "Gerado em", "Status"].map((t) => (
                    <th key={t} className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-ink-muted">{t}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-divider">
                {r.dados.linhas.map(({ resumo, chatNome, status, enviadoEm }) => (
                  <tr key={resumo.id} className="hover:bg-bg">
                    <Celula href={`/operacao/whatsapp/resumos-enviados/${idDetalheResumo(resumo.id)}`} className="text-ink">{chatNome}</Celula>
                    <Celula href={`/operacao/whatsapp/resumos-enviados/${idDetalheResumo(resumo.id)}`}>{resumo.periodo === "dia" ? "Diário" : "Semanal"}</Celula>
                    <Celula href={`/operacao/whatsapp/resumos-enviados/${idDetalheResumo(resumo.id)}`} className="whitespace-nowrap">{formatarData(resumo.data_ref)}</Celula>
                    <Celula href={`/operacao/whatsapp/resumos-enviados/${idDetalheResumo(resumo.id)}`}>{resumo.n_mensagens}</Celula>
                    <Celula href={`/operacao/whatsapp/resumos-enviados/${idDetalheResumo(resumo.id)}`} className="whitespace-nowrap">{formatarDataHora(resumo.gerado_em)}</Celula>
                    <Celula href={`/operacao/whatsapp/resumos-enviados/${idDetalheResumo(resumo.id)}`}>
                      <Etiqueta tom={STATUS[status].tom}>{STATUS[status].rotulo}</Etiqueta>
                      {enviadoEm && <span className="ml-2 text-xs text-ink-muted">{formatarDataHora(enviadoEm)}</span>}
                    </Celula>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Painel>
        )}
        {r.dados.digestsDm.length > 0 && (
          <Painel titulo="Digest de mensagens diretas" descricao="Resumo diário das DMs enviado a você, com o status real do envio. Não é um resumo de grupo.">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-divider font-sans text-sm">
                <thead>
                  <tr>
                    {["Data de referência", "Registrado em", "Status", "Motivo"].map((t) => (
                      <th key={t} className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-ink-muted">{t}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-divider">
                  {r.dados.digestsDm.map((d) => (
                    <tr key={d.data} className="hover:bg-bg">
                      <Celula href={`/operacao/whatsapp/resumos-enviados/${idDetalheDigest(d.data)}`} className="whitespace-nowrap text-ink">{formatarData(d.data)}</Celula>
                      <Celula href={`/operacao/whatsapp/resumos-enviados/${idDetalheDigest(d.data)}`} className="whitespace-nowrap">{formatarDataHora(d.em)}</Celula>
                      <Celula href={`/operacao/whatsapp/resumos-enviados/${idDetalheDigest(d.data)}`}>
                        <Etiqueta tom={d.enviado ? "destaque" : "alerta"}>{d.enviado ? "Enviado" : "Não enviado"}</Etiqueta>
                      </Celula>
                      <Celula href={`/operacao/whatsapp/resumos-enviados/${idDetalheDigest(d.data)}`}>{d.motivo ?? ""}</Celula>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Painel>
        )}
        </>
      )}
    </div>
  );
}
