import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ACAO_RESUMO_ENVIADO,
  ACAO_RESUMO_NAO_ENVIADO,
  derivarStatusEnvio,
  extrairDigestsDm,
  motivoDoDetalhe,
  type DigestDmEnviado,
  type StatusEnvioResumo,
} from "./dados";
import { dataDoDia, mensagemErroAmigavel } from "./formato";
import type { AuditoriaEnvioResumo, DestinoNotificacao, LinkCompartilhado, Pendencia, Resultado, Resumo } from "./tipos";

/**
 * Detalhe de um item da tela "Resumos enviados". O id da URL é o id numérico de wa.resumos
 * ou `digest-dm-<AAAA-MM-DD>` para o digest de DMs. Nenhuma função lança.
 */

export type AlvoDetalhe = { tipo: "resumo"; id: number } | { tipo: "digest-dm"; data: string };

export function idDetalheResumo(id: number): string {
  return String(id);
}

export function idDetalheDigest(data: string): string {
  return `digest-dm-${data}`;
}

export function lerIdDetalhe(valor: string): AlvoDetalhe | null {
  if (/^[1-9]\d{0,15}$/.test(valor)) return { tipo: "resumo", id: Number(valor) };
  const m = /^digest-dm-(\d{4}-\d{2}-\d{2})$/.exec(valor);
  if (m && !Number.isNaN(new Date(`${m[1]}T00:00:00Z`).getTime())) return { tipo: "digest-dm", data: m[1] };
  return null;
}

/** Nome sem código cru: JID, e-mail técnico ou só dígitos viram um rótulo legível. */
export const NOME_NAO_IDENTIFICADO = "Contato sem nome identificado";

export function nomeExibivel(...candidatos: (string | null | undefined)[]): string {
  for (const c of candidatos) {
    const t = c?.trim();
    if (!t) continue;
    if (t.includes("@") || /^[+\d\s().-]+$/.test(t)) continue;
    return t;
  }
  return NOME_NAO_IDENTIFICADO;
}

type Retorno<T> = { data: T | null; error: { message?: string; code?: string } | null };

function ler<T>(r: Retorno<T>, padrao: T): Resultado<T> {
  if (r.error) return { ok: false, erro: mensagemErroAmigavel(r.error) };
  return { ok: true, dados: r.data ?? padrao };
}

const wa = (client: SupabaseClient) => client.schema("wa");

export type EnvioDetalhe = {
  status: StatusEnvioResumo | "nao-enviado";
  enviado: boolean;
  quando: string | null;
  motivo: string | null;
};

/** O evento mais recente de auditoria do alvo decide; sem evento, cai na regra do destino. */
export function derivarEnvioDetalhe(
  resumoId: number,
  auditorias: Pick<AuditoriaEnvioResumo, "alvo" | "quando" | "acao" | "detalhe">[],
  destino: Pick<DestinoNotificacao, "ativo"> | null,
): EnvioDetalhe {
  const eventos = auditorias
    .filter((a) => a.alvo === String(resumoId) && (a.acao === ACAO_RESUMO_ENVIADO || a.acao === ACAO_RESUMO_NAO_ENVIADO))
    .sort((a, b) => new Date(b.quando).getTime() - new Date(a.quando).getTime());
  const ultimo = eventos[0];
  if (ultimo?.acao === ACAO_RESUMO_ENVIADO) return { status: "enviado", enviado: true, quando: ultimo.quando, motivo: null };
  if (ultimo) return { status: "nao-enviado", enviado: false, quando: ultimo.quando, motivo: motivoDoDetalhe(ultimo.detalhe) };
  const { status } = derivarStatusEnvio(resumoId, [], destino);
  return {
    status,
    enviado: false,
    quando: null,
    motivo: status === "destino-inativo" ? "Destino de notificação inativo." : "Ainda não houve tentativa de envio.",
  };
}

export type ResumoDetalhe = {
  resumo: Resumo;
  chatNome: string;
  envio: EnvioDetalhe;
  links: LinkCompartilhado[];
};

/** Retorna dados null quando o resumo não existe ou pertence a uma DM (404 na página). */
export async function carregarResumoDetalhe(client: SupabaseClient, id: number): Promise<Resultado<ResumoDetalhe | null>> {
  const rr = ler<Resumo | null>((await wa(client).from("resumos").select("*").eq("id", id).maybeSingle()) as Retorno<Resumo | null>, null);
  if (!rr.ok) return rr;
  const resumo = rr.dados;
  if (!resumo) return { ok: true, dados: null };

  const [chat, auditoria, destino] = await Promise.all([
    wa(client).from("chats").select("id, nome, tipo").eq("id", resumo.chat_id).maybeSingle(),
    wa(client)
      .from("auditoria")
      .select("id, quando, ator, acao, alvo, detalhe")
      .in("acao", [ACAO_RESUMO_ENVIADO, ACAO_RESUMO_NAO_ENVIADO])
      .eq("alvo", String(id))
      .order("quando", { ascending: false })
      .limit(20),
    wa(client).from("notificacao_destino").select("jid, nome, ativo, atualizado_em").maybeSingle(),
  ]);
  const c = ler<{ id: string; nome: string; tipo?: string } | null>(chat as Retorno<{ id: string; nome: string; tipo?: string } | null>, null);
  if (!c.ok) return c;
  if (c.dados?.tipo === "direto") return { ok: true, dados: null };
  const au = ler<AuditoriaEnvioResumo[]>(auditoria as Retorno<AuditoriaEnvioResumo[]>, []);
  if (!au.ok) return au;
  const de = ler<DestinoNotificacao | null>(destino as Retorno<DestinoNotificacao | null>, null);
  if (!de.ok) return de;

  let links: LinkCompartilhado[] = [];
  if (resumo.periodo === "dia") {
    // Links do dia: janela larga no banco e corte exato pelo dia no fuso do portal.
    const r = await wa(client).from("v_links").select("*").eq("chat_id", resumo.chat_id).order("compartilhado_em", { ascending: false }).limit(500);
    const l = ler<LinkCompartilhado[]>(r as Retorno<LinkCompartilhado[]>, []);
    if (!l.ok) return l;
    links = l.dados.filter((x) => dataDoDia(x.compartilhado_em) === resumo.data_ref);
  }

  return {
    ok: true,
    dados: { resumo, chatNome: c.dados?.nome ?? "Chat removido", envio: derivarEnvioDetalhe(id, au.dados, de.dados), links },
  };
}

export type DigestDetalhe = { digest: DigestDmEnviado | null; pendencias: (Pendencia & { nomeExibido: string })[] };

/** Pendências geradas na data do digest, com nome resolvido. Só chats liberados chegam aqui (RLS e v_pendencias). */
export async function carregarDigestDetalhe(client: SupabaseClient, data: string): Promise<Resultado<DigestDetalhe>> {
  const [auditoria, pend] = await Promise.all([
    wa(client)
      .from("auditoria")
      .select("id, quando, ator, acao, alvo, detalhe")
      .in("acao", [ACAO_RESUMO_ENVIADO, ACAO_RESUMO_NAO_ENVIADO])
      .eq("alvo", `digest-dm:${data}`)
      .order("quando", { ascending: false })
      .limit(20),
    wa(client).from("v_pendencias").select("*").order("gerado_em", { ascending: false }).limit(500),
  ]);
  const au = ler<AuditoriaEnvioResumo[]>(auditoria as Retorno<AuditoriaEnvioResumo[]>, []);
  if (!au.ok) return au;
  const p = ler<Pendencia[]>(pend as Retorno<Pendencia[]>, []);
  if (!p.ok) return p;
  const pesoUrgencia: Record<string, number> = { alta: 1, media: 2, baixa: 3 };
  const pendencias = p.dados
    .filter((x) => dataDoDia(x.gerado_em) === data)
    .sort((a, b) => (pesoUrgencia[a.urgencia] ?? 9) - (pesoUrgencia[b.urgencia] ?? 9) || new Date(a.espera_desde).getTime() - new Date(b.espera_desde).getTime())
    .map((x) => ({ ...x, nomeExibido: nomeExibivel(x.contato_nome, x.chat_nome) }));
  return { ok: true, dados: { digest: extrairDigestsDm(au.dados)[0] ?? null, pendencias } };
}
