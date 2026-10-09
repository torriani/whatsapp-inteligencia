// Transforma uma linha crua em registro seguro: filtro sensivel ANTES de qualquer saida.
import crypto from "node:crypto";
import { classify } from "./sensitive.mjs";
import { extractLinks } from "./links.mjs";
import { appleParaIso } from "./reader.mjs";

// Mapa observado por contagem no ChatStorage (07/10/2026): 0 texto, 1 imagem, 2 video, 3 audio, 6 e 10 mensagem de sistema
// (entrou, saiu, mudou), 7 link com preview, 8 documento, 11 gif, 14 apagada para todos, 15 figurinha.
// ZGROUPEVENTTYPE vale 2 na maioria das mensagens comuns, entao NAO serve para detectar evento.
const TIPO_APAGADA = 14;
const TIPOS_SISTEMA = new Set([6, 10]);

export function processar(row, ctx = {}) {
  const base = {
    local_pk: row.pk,
    stanza_id: row.stanza || null,
    do_dono: !!row.fromMe,
    enviada_em: row.data == null ? null : appleParaIso(row.data),
    tipo: row.tipo,
    autor: row.autor || null,
    tem_midia: row.midia != null,
    responde_a_pk: row.pai || null,
  };
  const evento = TIPOS_SISTEMA.has(row.tipo);
  if (evento) return { ...base, kind: "evento", texto: null, redigida: false, apagada: false, links: [], hash: hash("evento", row) };
  if (row.tipo === TIPO_APAGADA) return { ...base, kind: "apagada", texto: null, redigida: false, apagada: true, links: [], hash: hash("apagada", row) };

  const texto = row.texto ?? null;
  const c = classify(texto, { fromMe: !!row.fromMe, direct: !!ctx.direct, termosRegex: ctx.termosRegex, termosEmTodas: ctx.termosEmTodas });
  if (c.sensivel) {
    return { ...base, kind: "redigida", texto: null, redigida: true, regra: c.regra, apagada: false, links: [], hash: hash("redigida", row) };
  }
  const links = extractLinks(texto, row.autor || null).map((l) => ({ ...l, titulo: row.titulo || null }));
  return { ...base, kind: texto ? "texto" : "midia", texto, redigida: false, apagada: false, links, hash: hash(texto ?? "", row) };
}

function hash(conteudo, row) {
  return crypto.createHash("sha256").update(`${row.tipo}|${conteudo}`).digest("hex");
}
