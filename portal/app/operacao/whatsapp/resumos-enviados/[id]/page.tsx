import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { EmptyState } from "@/components/EmptyState";
import { EstadoErro, Etiqueta, LinkBotao, ListaTopicos, Painel, TituloPagina } from "@/components/operacao/whatsapp/Blocos";
import { formatarData, formatarDataHora, haQuantoTempo, normalizarItens, urlSegura } from "@/lib/whatsapp/formato";
import { exigirAdminDaRequisicao } from "@/lib/whatsapp/guarda";
import { carregarDigestDetalhe, carregarResumoDetalhe, lerIdDetalhe, type EnvioDetalhe } from "@/lib/whatsapp/resumos-detalhe";
import type { UrgenciaPendencia } from "@/lib/whatsapp/tipos";

export const dynamic = "force-dynamic";

const VOLTAR = <LinkBotao href="/operacao/whatsapp/resumos-enviados">Voltar aos resumos</LinkBotao>;

const URGENCIA: Record<UrgenciaPendencia, { rotulo: string; tom: "neutro" | "destaque" | "alerta" }> = {
  alta: { rotulo: "Alta", tom: "alerta" },
  media: { rotulo: "Média", tom: "destaque" },
  baixa: { rotulo: "Baixa", tom: "neutro" },
};

function BlocoEnvio({ envio }: { envio: Pick<EnvioDetalhe, "enviado" | "quando" | "motivo"> }) {
  return (
    <Painel titulo="Status de envio">
      <dl className="grid grid-cols-1 gap-3 font-sans text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Situação</dt>
          <dd className="mt-1">
            <Etiqueta tom={envio.enviado ? "destaque" : "alerta"}>{envio.enviado ? "Enviado" : "Não enviado"}</Etiqueta>
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Quando</dt>
          <dd className="mt-1 text-ink">{envio.quando ? formatarDataHora(envio.quando) : "Sem registro"}</dd>
        </div>
        {!envio.enviado && (
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Motivo</dt>
            <dd className="mt-1 break-words text-ink">{envio.motivo ?? "Motivo não registrado."}</dd>
          </div>
        )}
      </dl>
    </Painel>
  );
}

export default async function ResumoEnviadoDetalhePage({ params }: { params: Promise<{ id: string }> }) {
  await exigirAdminDaRequisicao();
  const alvo = lerIdDetalhe((await params).id);
  if (!alvo) notFound();
  const supabase = await createClient();

  if (alvo.tipo === "digest-dm") {
    const r = await carregarDigestDetalhe(supabase, alvo.data);
    if (!r.ok) return <EstadoErro mensagem={r.erro} />;
    const { digest, pendencias } = r.dados;
    if (!digest && pendencias.length === 0) notFound();
    return (
      <div className="space-y-6">
        <TituloPagina titulo={`Digest de mensagens diretas, ${formatarData(alvo.data)}`} descricao="Pendências de resposta registradas nesta data." acao={VOLTAR} />
        <BlocoEnvio envio={digest ? { enviado: digest.enviado, quando: digest.em, motivo: digest.motivo } : { enviado: false, quando: null, motivo: "Sem registro de envio para esta data." }} />
        <Painel titulo="Pendências da data">
          {pendencias.length === 0 ? (
            <EmptyState titulo="Nenhuma pendência nesta data" descricao="Não há pendências de resposta geradas nesta data." />
          ) : (
            <ul className="divide-y divide-divider font-sans text-sm">
              {pendencias.map((p) => (
                <li key={p.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="font-medium text-ink">{p.nomeExibido}</p>
                    <p className="mt-1 break-words text-ink">{p.pedido ?? "Sem síntese do pedido"}</p>
                    <p className="mt-1 text-xs text-ink-muted">
                      Espera há {haQuantoTempo(p.espera_desde)}
                      {p.tipo_resposta ? `, resposta esperada: ${p.tipo_resposta}` : ""}
                    </p>
                  </div>
                  <Etiqueta tom={URGENCIA[p.urgencia]?.tom ?? "neutro"}>{URGENCIA[p.urgencia]?.rotulo ?? p.urgencia}</Etiqueta>
                </li>
              ))}
            </ul>
          )}
        </Painel>
      </div>
    );
  }

  const r = await carregarResumoDetalhe(supabase, alvo.id);
  if (!r.ok) return <EstadoErro mensagem={r.erro} />;
  if (!r.dados) notFound();
  const { resumo, chatNome, envio, links } = r.dados;
  const periodo = resumo.periodo === "dia" ? "diário" : "semanal";

  return (
    <div className="space-y-6">
      <TituloPagina
        titulo={`${chatNome}, ${formatarData(resumo.data_ref)}`}
        descricao={`Resumo ${periodo} com ${resumo.n_mensagens} mensagens, gerado em ${formatarDataHora(resumo.gerado_em)}.`}
        acao={VOLTAR}
      />
      <BlocoEnvio envio={envio} />
      <Painel titulo="Resumo">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          <ListaTopicos rotulo="O que foi discutido" itens={normalizarItens(resumo.discutido)} vazio="Nada registrado." />
          <ListaTopicos rotulo="O que foi decidido" itens={normalizarItens(resumo.decidido)} vazio="Nenhuma decisão registrada." />
          <ListaTopicos rotulo="O que olhar" itens={normalizarItens(resumo.olhar)} vazio="Nada para olhar." />
        </div>
      </Painel>
      {resumo.periodo === "dia" && (
        <Painel titulo="Links do dia">
          {links.length === 0 ? (
            <p className="font-sans text-sm text-ink-muted">Nenhum link compartilhado neste dia.</p>
          ) : (
            <ul className="space-y-2 font-sans text-sm">
              {links.map((l) => {
                const href = urlSegura(l.url);
                return (
                  <li key={l.id} className="break-words">
                    {href ? (
                      <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">{l.titulo || l.url}</a>
                    ) : (
                      <span className="text-ink">{l.titulo || l.url}</span>
                    )}
                    <span className="ml-2 text-xs text-ink-muted">{l.dominio}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Painel>
      )}
    </div>
  );
}
