import { Fragment } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { EmptyState } from "@/components/EmptyState";
import { EstadoErro, Etiqueta, Painel, TituloPagina } from "@/components/operacao/whatsapp/Blocos";
import { LIMITE_TEXTO_RESPOSTA, carregarEnvioRespostasAtivo, carregarKillSwitchLigado, carregarPendencias, carregarTextosAprovados } from "@/lib/whatsapp/dados";
import { formatarDataHora, haQuantoTempo } from "@/lib/whatsapp/formato";
import { exigirAdminDaRequisicao } from "@/lib/whatsapp/guarda";
import type { Pendencia, UrgenciaPendencia } from "@/lib/whatsapp/tipos";
import { alternarEnvioRespostasAction, aprovarRespostaAction, cancelarRespostaAction, fecharPendenciaAction, liberarReaprovacaoAction } from "./actions";

export const dynamic = "force-dynamic";

const URGENCIA: Record<UrgenciaPendencia, { rotulo: string; tom: "neutro" | "destaque" | "alerta" }> = {
  alta: { rotulo: "Alta", tom: "alerta" },
  media: { rotulo: "Média", tom: "destaque" },
  baixa: { rotulo: "Baixa", tom: "neutro" },
};

type SearchParams = Record<string, string | string[] | undefined>;
const primeiro = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function PendenciasWhatsappPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await exigirAdminDaRequisicao();
  const sp = await searchParams;
  const aviso = { ok: primeiro(sp.ok), erro: primeiro(sp.erro) };
  const supabase = await createClient();
  const [r, envio, kill] = await Promise.all([carregarPendencias(supabase), carregarEnvioRespostasAtivo(supabase), carregarKillSwitchLigado(supabase)]);
  // Kill switch lido com falha fechada: erro de leitura também conta como parado.
  const killLigado = !kill.ok || kill.dados;
  const envioLigado = envio.ok && envio.dados && !killLigado;
  const idsVivos = r.ok ? r.dados.filter((p) => p.fila_id && p.fila_status && FILA_VIVA.includes(p.fila_status)).map((p) => Number(p.fila_id)) : [];
  const textos = await carregarTextosAprovados(supabase, idsVivos);
  const textoDe = (id: number | null | undefined) => (id && textos.ok ? textos.dados[Number(id)] ?? null : null);

  return (
    <div className="space-y-6">
      <TituloPagina
        titulo="Pendências de resposta"
        descricao="Mensagens diretas aguardando resposta sua, da mais urgente e mais antiga para a menos urgente."
      />

      {aviso.ok && (
        <p role="status" className="rounded-card border border-divider bg-surface p-3 font-sans text-sm text-ink">{aviso.ok}</p>
      )}
      {aviso.erro && (
        <p role="alert" className="rounded-card border border-danger bg-surface p-3 font-sans text-sm text-danger">{aviso.erro}</p>
      )}

      {killLigado && (
        <p role="alert" className="rounded-card border border-danger bg-surface p-3 font-sans text-sm text-danger">
          Kill switch de envio ligado: nenhuma resposta é aprovada nem enviada até ele ser desligado.
        </p>
      )}

      <Painel>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-sans text-sm font-medium text-ink">
              Envio de respostas: {!envio.ok ? "indisponível" : envioLigado ? "ligado" : "desligado"}
            </p>
            <p className="font-sans text-xs text-ink-muted">
              Nada sai pelo WhatsApp com a chave desligada. Com ela ligada, só sai o texto que você aprovar, com intervalo mínimo entre envios.
            </p>
          </div>
          {envio.ok && (
            <form action={alternarEnvioRespostasAction}>
              <input type="hidden" name="ativo" value={envioLigado ? "false" : "true"} />
              <button type="submit" className="rounded-md border border-divider px-3 py-1.5 font-sans text-sm text-ink hover:border-accent">
                {envioLigado ? "Desligar envio" : "Ligar envio"}
              </button>
            </form>
          )}
        </div>
      </Painel>

      {!r.ok ? (
        <EstadoErro mensagem={r.erro} />
      ) : r.dados.length === 0 ? (
        <EmptyState titulo="Nenhuma pendência aberta" descricao="Quando uma mensagem direta ficar sem resposta, ela aparece aqui com a urgência e o tipo de resposta esperado." />
      ) : (
        <Painel>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-divider font-sans text-sm">
              <thead>
                <tr>
                  {["Contato", "Espera desde", "Pedido", "Urgência", "Tipo de resposta", "Áudio sem transcrição", "Ação"].map((t) => (
                    <th key={t} className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-ink-muted">{t}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-divider">
                {r.dados.map((p) => (
                  <Fragment key={p.id}>
                  <tr>
                    <td className="px-3 py-3 text-ink">
                      <Link href={`/operacao/whatsapp/${p.chat_id}`} className="text-accent hover:underline">
                        {p.contato_nome || p.chat_nome}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-ink-muted">
                      {haQuantoTempo(p.espera_desde)}
                      <span className="block text-xs">{formatarDataHora(p.espera_desde)}</span>
                    </td>
                    <td className="max-w-[420px] break-words px-3 py-3 text-ink">{p.pedido ?? "Sem síntese do pedido"}</td>
                    <td className="px-3 py-3">
                      <Etiqueta tom={URGENCIA[p.urgencia]?.tom ?? "neutro"}>{URGENCIA[p.urgencia]?.rotulo ?? p.urgencia}</Etiqueta>
                    </td>
                    <td className="px-3 py-3 text-ink-muted">{p.tipo_resposta ?? "Não classificado"}</td>
                    <td className="px-3 py-3">
                      {p.audio_sem_transcricao ? <Etiqueta tom="alerta">Sim</Etiqueta> : <span className="text-ink-muted">Não</span>}
                    </td>
                    <td className="px-3 py-3">
                      <form action={fecharPendenciaAction} className="flex flex-wrap gap-2">
                        <input type="hidden" name="id" value={p.id} />
                        <button
                          type="submit"
                          name="status"
                          value="respondida"
                          className="rounded-md bg-accent px-3 py-1.5 font-sans text-sm text-on-accent hover:bg-accent-dark"
                        >
                          Marcar como respondida
                        </button>
                        <button
                          type="submit"
                          name="status"
                          value="descartada"
                          className="rounded-md border border-divider px-3 py-1.5 font-sans text-sm text-ink hover:border-accent"
                        >
                          Descartar
                        </button>
                      </form>
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={7} className="bg-surface px-3 pb-4 pt-0">
                      <RespostaPendencia p={p} envioLigado={envioLigado} texto={textoDe(p.fila_id)} />
                    </td>
                  </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </Painel>
      )}
    </div>
  );
}

const FILA_VIVA = ["aprovado", "enviando"];

/** Bloco de resposta de uma pendência: o texto é do dono; o botão Aprovar grava na fila de envio. */
function RespostaPendencia({ p, envioLigado, texto }: { p: Pendencia; envioLigado: boolean; texto: string | null }) {
  if (p.contato !== true) {
    return <p className="font-sans text-xs text-ink-muted">Resposta pelo portal só para contatos salvos na sua agenda.</p>;
  }
  if (p.fila_status && FILA_VIVA.includes(p.fila_status)) {
    return (
      <div className="space-y-2">
      {texto && (
        <p className="whitespace-pre-wrap break-words rounded-md border border-divider bg-surface p-2 font-sans text-sm text-ink">
          <span className="block text-xs font-semibold uppercase tracking-wider text-ink-muted">Texto aprovado</span>
          {texto}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Etiqueta tom="destaque">{p.fila_status === "enviando" ? "Enviando" : "Aprovada, aguardando envio"}</Etiqueta>
        {p.fila_status === "aprovado" && p.fila_id ? (
          <form action={cancelarRespostaAction}>
            <input type="hidden" name="fila_id" value={p.fila_id} />
            <button type="submit" className="rounded-md border border-divider px-3 py-1.5 font-sans text-sm text-ink hover:border-accent">
              Cancelar envio
            </button>
          </form>
        ) : null}
      </div>
      </div>
    );
  }
  const interrompido = p.fila_status === "falhou" && p.fila_erro === "interrompido_verificar";
  if (interrompido) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Etiqueta tom="alerta">Envio interrompido: a mensagem pode ter saído. Confira no WhatsApp.</Etiqueta>
        <span className="font-sans text-xs text-ink-muted">
          Se saiu, use Marcar como respondida. Se não saiu, libere uma nova aprovação.
        </span>
        {p.fila_id ? (
          <form action={liberarReaprovacaoAction}>
            <input type="hidden" name="fila_id" value={p.fila_id} />
            <button type="submit" className="rounded-md border border-divider px-3 py-1.5 font-sans text-sm text-ink hover:border-accent">
              Conferi: não saiu, liberar nova aprovação
            </button>
          </form>
        ) : null}
      </div>
    );
  }
  const idTexto = `resposta-${p.id}`;
  return (
    <form action={aprovarRespostaAction} className="space-y-2">
      <input type="hidden" name="id" value={p.id} />
      <label htmlFor={idTexto} className="block font-sans text-xs font-semibold uppercase tracking-wider text-ink-muted">
        Sua resposta
      </label>
      <textarea
        id={idTexto}
        name="texto"
        required
        rows={3}
        maxLength={LIMITE_TEXTO_RESPOSTA}
        className="w-full rounded-md border border-divider bg-surface p-2 font-sans text-sm text-ink focus:border-accent focus:outline-none"
      />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={!envioLigado}
          className="rounded-md bg-accent px-3 py-1.5 font-sans text-sm text-on-accent hover:bg-accent-dark disabled:opacity-50"
        >
          Aprovar e enviar
        </button>
        {!envioLigado && <span className="font-sans text-xs text-ink-muted">Envio de respostas desligado ou kill switch ligado: não é possível aprovar.</span>}
        {p.fila_status === "falhou" && (
          <Etiqueta tom="alerta">Último envio falhou{p.fila_erro ? ` (${p.fila_erro})` : ""}</Etiqueta>
        )}
        {p.fila_status === "expirado" && <Etiqueta tom="neutro">Aprovação anterior expirou sem envio</Etiqueta>}
        {p.fila_status === "cancelado" && <Etiqueta tom="neutro">Aprovação anterior cancelada</Etiqueta>}
      </div>
    </form>
  );
}
