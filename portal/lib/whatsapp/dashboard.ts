import type { SupabaseClient } from "@supabase/supabase-js";
import { carregarPendencias, carregarResumosEnviados } from "./dados";
import { dataDoDia, mensagemErroAmigavel } from "./formato";
import type { Pendencia, Resultado, UrgenciaPendencia } from "./tipos";

/**
 * Dashboard do WhatsApp (somente leitura, só admin). Agrega no servidor o que as views
 * wa.* já expõem. Mensagens diretas entram apenas como contagem: nenhum nome, texto
 * ou id de DM sai deste módulo.
 */

export const DIAS_JANELA = 14;
export const TOP_CHATS = 10;
const TAMANHO_PAGINA = 1000;
const MAX_PAGINAS = 30;
const DIA_MS = 24 * 60 * 60 * 1000;

type Retorno<T> = { data: T | null; error: { message?: string; code?: string } | null };

export type PontoDia = { dia: string; total: number };
export type ChatAtivo = { id: string; nome: string; mensagens: number };
export type FaixaIdade = "hoje" | "um-a-tres" | "mais-de-tres";

export type PendenciasDashboard = {
  total: number;
  porUrgencia: Record<UrgenciaPendencia, number>;
  porIdade: Record<FaixaIdade, number>;
};

export type EnvioDashboard = {
  gruposEnviados: number;
  gruposNaoEnviados: number;
  digestsEnviados: number;
  digestsNaoEnviados: number;
};

export type DadosDashboard = {
  dias: string[];
  mensagensGrupos: PontoDia[];
  linksGrupos: PontoDia[];
  /** Só contagem: nenhum identificador de DM. */
  diretos: { conversas: number; mensagens: number };
  chatsAtivos: ChatAtivo[];
  pendencias: PendenciasDashboard;
  envios: EnvioDashboard;
  truncado: boolean;
};

/** Os `n` últimos dias (AAAA-MM-DD, fuso do portal), do mais antigo ao de hoje. */
export function ultimosDias(n: number, agora: Date = new Date()): string[] {
  const dias: string[] = [];
  for (let i = n - 1; i >= 0; i--) dias.push(dataDoDia(new Date(agora.getTime() - i * DIA_MS).toISOString()));
  return dias;
}

export function contarPorDia(instantes: string[], dias: string[]): PontoDia[] {
  const contagem = new Map(dias.map((d) => [d, 0]));
  for (const iso of instantes) {
    const dia = dataDoDia(iso);
    if (contagem.has(dia)) contagem.set(dia, (contagem.get(dia) ?? 0) + 1);
  }
  return dias.map((dia) => ({ dia, total: contagem.get(dia) ?? 0 }));
}

export function faixaDeIdade(esperaDesde: string, agora: Date = new Date()): FaixaIdade {
  const dias = Math.floor((agora.getTime() - new Date(esperaDesde).getTime()) / DIA_MS);
  if (dias < 1) return "hoje";
  return dias <= 3 ? "um-a-tres" : "mais-de-tres";
}

export function resumirPendencias(
  linhas: Pick<Pendencia, "urgencia" | "espera_desde">[],
  agora: Date = new Date(),
): PendenciasDashboard {
  const r: PendenciasDashboard = {
    total: linhas.length,
    porUrgencia: { alta: 0, media: 0, baixa: 0 },
    porIdade: { hoje: 0, "um-a-tres": 0, "mais-de-tres": 0 },
  };
  for (const p of linhas) {
    if (p.urgencia in r.porUrgencia) r.porUrgencia[p.urgencia] += 1;
    r.porIdade[faixaDeIdade(p.espera_desde, agora)] += 1;
  }
  return r;
}

type Chat = { id: string; tipo: string; nome: string };
type LinhaDatada = { chat_id: string; instante: string };

/**
 * Separa grupos de DMs. Grupos viram série por dia e ranking; DMs viram só dois números.
 * Chats fora da lista de liberados são ignorados.
 */
export function agregarAtividade(chats: Chat[], mensagens: LinhaDatada[], links: LinhaDatada[], dias: string[]) {
  const porId = new Map(chats.map((c) => [c.id, c]));
  const ehGrupo = (id: string) => {
    const t = porId.get(id)?.tipo;
    return t === "grupo" || t === "comunidade";
  };
  const ehDireto = (id: string) => porId.get(id)?.tipo === "direto";

  const msgGrupos = mensagens.filter((m) => ehGrupo(m.chat_id));
  const msgDiretos = mensagens.filter((m) => ehDireto(m.chat_id));
  const ranking = new Map<string, number>();
  for (const m of msgGrupos) ranking.set(m.chat_id, (ranking.get(m.chat_id) ?? 0) + 1);

  return {
    mensagensGrupos: contarPorDia(msgGrupos.map((m) => m.instante), dias),
    linksGrupos: contarPorDia(links.filter((l) => ehGrupo(l.chat_id)).map((l) => l.instante), dias),
    diretos: { conversas: chats.filter((c) => c.tipo === "direto").length, mensagens: msgDiretos.length },
    chatsAtivos: [...ranking.entries()]
      .map(([id, n]) => ({ id, nome: porId.get(id)?.nome ?? "", mensagens: n }))
      .sort((a, b) => b.mensagens - a.mensagens || a.nome.localeCompare(b.nome))
      .slice(0, TOP_CHATS),
  };
}

async function lerPaginado(
  pagina: (de: number, ate: number) => PromiseLike<unknown>,
): Promise<Resultado<{ linhas: Record<string, string>[]; truncado: boolean }>> {
  const linhas: Record<string, string>[] = [];
  for (let p = 0; p < MAX_PAGINAS; p++) {
    const r = (await pagina(p * TAMANHO_PAGINA, (p + 1) * TAMANHO_PAGINA - 1)) as Retorno<Record<string, string>[]>;
    if (r.error) return { ok: false, erro: mensagemErroAmigavel(r.error) };
    const lote = r.data ?? [];
    linhas.push(...lote);
    if (lote.length < TAMANHO_PAGINA) return { ok: true, dados: { linhas, truncado: false } };
  }
  return { ok: true, dados: { linhas, truncado: true } };
}

export async function carregarDashboard(client: SupabaseClient, agora: Date = new Date()): Promise<Resultado<DadosDashboard>> {
  const dias = ultimosDias(DIAS_JANELA, agora);
  // Início do primeiro dia com folga de um dia; o corte exato por dia é feito na agregação.
  const desde = new Date(agora.getTime() - (DIAS_JANELA + 1) * DIA_MS).toISOString();
  const wa = client.schema("wa");

  const chatsR = (await wa.from("v_chats_resumo").select("id, tipo, nome").neq("modo", "off")) as Retorno<Chat[]>;
  if (chatsR.error) return { ok: false, erro: mensagemErroAmigavel(chatsR.error) };
  const chats = chatsR.data ?? [];

  const [msgs, links, pend, envios] = await Promise.all([
    lerPaginado((de, ate) => wa.from("mensagens").select("chat_id, enviada_em").gte("enviada_em", desde).order("id", { ascending: false }).range(de, ate)),
    lerPaginado((de, ate) => wa.from("v_links").select("chat_id, compartilhado_em").gte("compartilhado_em", desde).order("id", { ascending: false }).range(de, ate)),
    carregarPendencias(client),
    carregarResumosEnviados(client),
  ]);
  if (!msgs.ok) return msgs;
  if (!links.ok) return links;
  if (!pend.ok) return pend;
  if (!envios.ok) return envios;

  const atividade = agregarAtividade(
    chats,
    msgs.dados.linhas.map((l) => ({ chat_id: l.chat_id, instante: l.enviada_em })),
    links.dados.linhas.map((l) => ({ chat_id: l.chat_id, instante: l.compartilhado_em })),
    dias,
  );

  const diasSet = new Set(dias);
  const recentes = envios.dados.linhas.filter((l) => diasSet.has(dataDoDia(l.resumo.gerado_em)));
  const digests = envios.dados.digestsDm.filter((d) => diasSet.has(d.data));

  return {
    ok: true,
    dados: {
      dias,
      ...atividade,
      pendencias: resumirPendencias(pend.dados, agora),
      envios: {
        gruposEnviados: recentes.filter((l) => l.status === "enviado").length,
        gruposNaoEnviados: recentes.filter((l) => l.status !== "enviado").length,
        digestsEnviados: digests.filter((d) => d.enviado).length,
        digestsNaoEnviados: digests.filter((d) => !d.enviado).length,
      },
      truncado: msgs.dados.truncado || links.dados.truncado,
    },
  };
}
