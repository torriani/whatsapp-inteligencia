// Temas dos aprendizados: lista editavel em wa.config (chave aprendizado_temas). Nada fixo no codigo.
import { sanitizar } from "./textguard.mjs";

export const CHAVE_TEMAS = "aprendizado_temas";
// Limite tecnico de tamanho de um aprendizado (espelha a checagem de wa.registrar_aprendizado).
export const LIMITE_CORPO = 200;
export const LIMITE_TITULO = 100;

export function normalizarTemas(valor) {
  if (!Array.isArray(valor)) return [];
  const vistos = new Set();
  const out = [];
  for (const t of valor) {
    const nome = String(typeof t === "string" ? t : t?.nome ?? "").trim();
    if (!nome || vistos.has(nome.toLowerCase())) continue;
    vistos.add(nome.toLowerCase());
    out.push({ nome, descricao: String(typeof t === "string" ? "" : t?.descricao ?? "").trim() });
  }
  return out;
}

export async function carregarTemas(db) {
  const rows = await db.rows(`select valor from wa.config where chave = '${CHAVE_TEMAS}'`);
  return normalizarTemas(rows[0]?.valor);
}

export const listaTemasPrompt = (temas) => temas.map((t) => `- ${t.nome}${t.descricao ? `: ${t.descricao}` : ""}`).join("\n");

// Regras do extrator. Recebe a lista de temas, sem nenhum tema escrito aqui.
export function regrasAprendizado(temas) {
  return `Aprendizado e uma camada curta, lida de vez em quando. So vira aprendizado o que ensina algo ligado a um destes temas do dono:
${listaTemasPrompt(temas)}
DESCARTE e nao devolva: suporte (duvida de acesso, login, instalacao ou erro de uso de um produto, reembolso, pedido de ajuda de aluno, logistica de aula ou encontro, avisos operacionais), conversa social e tudo que nao se ligue a um tema da lista. Tecnica, pratica ou comparacao sobre agentes, ferramentas, repositorios, modelos, vendas, copy ou video conta como tema. Se nada servir, devolva lista vazia.
Cada aprendizado: "corpo" com uma ou duas frases do que se aprendeu, no maximo ${LIMITE_CORPO} caracteres; "titulo" com no maximo ${LIMITE_TITULO} caracteres; "tema" exatamente um nome da lista acima.`;
}

// Corta no ultimo fim de frase dentro do limite. Sem fim de frase, nao inventa: devolve null.
export function encurtar(texto, max = LIMITE_CORPO) {
  const t = sanitizar(String(texto ?? "")).replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (t.length <= max) return t;
  const corte = t.slice(0, max);
  const fim = Math.max(corte.lastIndexOf(". "), corte.lastIndexOf("! "), corte.lastIndexOf("? "));
  if (fim > 0) return corte.slice(0, fim + 1);
  return null;
}

// Valida um aprendizado devolvido pelo modelo. null = descartar.
export function prepararAprendizado(a, { temas, ids }) {
  const tema = temas.find((t) => t.nome.toLowerCase() === String(a?.tema ?? "").trim().toLowerCase());
  if (!tema) return null;
  const fontes = (Array.isArray(a.fontes) ? a.fontes : []).map(Number).filter((f) => ids.has(f));
  const corpo = encurtar(a.corpo);
  const titulo = sanitizar(String(a.titulo ?? "")).trim().slice(0, LIMITE_TITULO);
  if (!fontes.length || !corpo || !titulo) return null;
  return {
    tema: tema.nome, fontes, corpo, titulo,
    confianca: Math.min(5, Math.max(1, Number(a.confianca) || 3)),
    tags: (Array.isArray(a.tags) ? a.tags : []).map((x) => sanitizar(String(x)).slice(0, 40)).slice(0, 6),
  };
}
