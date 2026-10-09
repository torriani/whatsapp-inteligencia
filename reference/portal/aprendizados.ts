import type { Aprendizado, TemaAprendizado } from "./tipos";
import { primeiro, type SearchParams } from "./parametros";

/** Lógica pura da tela de aprendizados por tema: busca, filtro, agrupamento e edição da lista de temas. */

export const SEM_TEMA = "Sem tema";
export const MAX_TEMAS = 30;
export const MAX_NOME_TEMA = 60;
export const MAX_DESCRICAO_TEMA = 160;

export type VisaoAprendizados = "temas" | "resumos";

export type ParametrosAprendizados = { visao: VisaoAprendizados; tema: string; grupo: string; q: string };

export function lerParametrosAprendizados(sp: SearchParams): ParametrosAprendizados {
  return {
    visao: primeiro(sp.visao) === "resumos" ? "resumos" : "temas",
    tema: primeiro(sp.tema).trim().slice(0, MAX_NOME_TEMA),
    grupo: primeiro(sp.grupo).trim().slice(0, 64),
    q: primeiro(sp.q).trim().slice(0, 80),
  };
}

/** Minúsculas e sem acento, para busca por palavra-chave. */
export function normalizarBusca(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Todas as palavras da busca precisam aparecer no tema, título, corpo ou tags. Busca vazia casa tudo. */
export function casaBusca(a: Pick<Aprendizado, "titulo" | "corpo" | "tags" | "tema">, q: string): boolean {
  const palavras = normalizarBusca(q).split(/\s+/).filter(Boolean);
  if (palavras.length === 0) return true;
  const alvo = normalizarBusca([a.tema ?? "", a.titulo, a.corpo, ...(a.tags ?? [])].join(" "));
  return palavras.every((p) => alvo.includes(p));
}

/** Mais recente primeiro (data de criação). Desempate por id. */
export function maisRecentePrimeiro(a: Aprendizado, b: Aprendizado): number {
  return Date.parse(b.criado_em) - Date.parse(a.criado_em) || b.id - a.id;
}

export function filtrarAprendizados(lista: Aprendizado[], p: Pick<ParametrosAprendizados, "tema" | "grupo" | "q">): Aprendizado[] {
  return lista
    .filter((a) => a.status !== "descartado")
    .filter((a) => !p.tema || (a.tema ?? SEM_TEMA) === p.tema)
    .filter((a) => !p.grupo || a.chat_id === p.grupo)
    .filter((a) => casaBusca(a, p.q))
    .sort(maisRecentePrimeiro);
}

export type GrupoDeTema = { tema: string; itens: Aprendizado[] };

/** Agrupa pela ordem dos temas configurados; temas fora da lista e itens sem tema vão ao fim. Só entram temas com itens. */
export function agruparPorTema(itens: Aprendizado[], temas: TemaAprendizado[]): GrupoDeTema[] {
  const mapa = new Map<string, Aprendizado[]>();
  for (const a of itens) {
    const k = a.tema ?? SEM_TEMA;
    mapa.set(k, [...(mapa.get(k) ?? []), a]);
  }
  const ordem = temas.map((t) => t.nome);
  const extras = [...mapa.keys()].filter((k) => !ordem.includes(k) && k !== SEM_TEMA).sort();
  return [...ordem, ...extras, SEM_TEMA].filter((k) => mapa.has(k)).map((k) => ({ tema: k, itens: mapa.get(k)! }));
}

export function contarPor<T extends string | null>(valores: T[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of valores) m.set(v ?? SEM_TEMA, (m.get(v ?? SEM_TEMA) ?? 0) + 1);
  return m;
}

/** Texto do editor: uma linha por tema, "Nome: descrição". */
export function temasParaTexto(temas: TemaAprendizado[]): string {
  return temas.map((t) => (t.descricao ? `${t.nome}: ${t.descricao}` : t.nome)).join("\n");
}

const TRAVESSAO_OU_EMOJI = /[\u2013\u2014\p{Extended_Pictographic}]/u;

export function textoParaTemas(texto: string): { ok: true; temas: TemaAprendizado[] } | { ok: false; erro: string } {
  const vistos = new Set<string>();
  const temas: TemaAprendizado[] = [];
  for (const linha of texto.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const i = linha.indexOf(":");
    const nome = (i < 0 ? linha : linha.slice(0, i)).trim();
    const descricao = i < 0 ? "" : linha.slice(i + 1).trim();
    if (!nome) return { ok: false, erro: "Cada linha precisa de um nome de tema." };
    if (nome.length > MAX_NOME_TEMA) return { ok: false, erro: `O nome de um tema aceita até ${MAX_NOME_TEMA} caracteres.` };
    if (descricao.length > MAX_DESCRICAO_TEMA) return { ok: false, erro: `A descrição de um tema aceita até ${MAX_DESCRICAO_TEMA} caracteres.` };
    if (TRAVESSAO_OU_EMOJI.test(nome + descricao)) return { ok: false, erro: "Temas não aceitam travessão nem emoji." };
    if (nome.toLowerCase() === SEM_TEMA.toLowerCase()) return { ok: false, erro: `"${SEM_TEMA}" é reservado.` };
    if (vistos.has(nome.toLowerCase())) return { ok: false, erro: `Tema repetido: ${nome}.` };
    vistos.add(nome.toLowerCase());
    temas.push({ nome, descricao });
  }
  if (temas.length === 0) return { ok: false, erro: "Informe ao menos um tema." };
  if (temas.length > MAX_TEMAS) return { ok: false, erro: `No máximo ${MAX_TEMAS} temas.` };
  return { ok: true, temas };
}

/** Lê o jsonb de wa.config; formato inesperado vira lista vazia. */
export function lerTemasConfig(valor: unknown): TemaAprendizado[] {
  if (!Array.isArray(valor)) return [];
  const out: TemaAprendizado[] = [];
  for (const t of valor) {
    const nome = String(typeof t === "string" ? t : (t as { nome?: unknown })?.nome ?? "").trim();
    if (!nome || out.some((o) => o.nome.toLowerCase() === nome.toLowerCase())) continue;
    out.push({ nome, descricao: typeof t === "string" ? "" : String((t as { descricao?: unknown })?.descricao ?? "").trim() });
  }
  return out;
}

export function statusDecisao(valor: unknown): "aprovado" | "descartado" | null {
  return valor === "aprovado" || valor === "descartado" ? valor : null;
}
