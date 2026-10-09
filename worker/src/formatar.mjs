// Formatacao das mensagens de WhatsApp (sintaxe do app: *negrito*, _italico_, listas com hifen).
// Emoji so no cabecalho e nos marcadores, a pedido expresso do founder (mensagem para ele mesmo).
// O codigo-fonte usa escapes \u para nao carregar emoji literal.
import fs from "node:fs";
import { ICONES_FILE } from "./paths.mjs";
import { parseJsonSeguro } from "./safejson.mjs";
import { sanitizar } from "./textguard.mjs";
import { norm } from "./allowlist.mjs";

export const LIMITE_MENSAGEM = 1500;
const EMOJI_PADRAO = "\u{1F4AC}";
const URGENCIA = { alta: "\u{1F534}", media: "\u{1F7E1}", baixa: "\u{1F7E2}" };

export function carregarIcones(file = ICONES_FILE) {
  if (!fs.existsSync(file)) return { padrao: EMOJI_PADRAO, regras: [] };
  const j = parseJsonSeguro(fs.readFileSync(file, "utf8"), "icones");
  return { padrao: j.padrao || EMOJI_PADRAO, regras: Array.isArray(j.regras) ? j.regras : [] };
}

// Primeira regra cujo "contem" aparece no nome. { emoji, links }
export function iconeDoGrupo(nome, icones) {
  const n = norm(nome);
  const r = icones.regras.find((x) => x.contem && n.includes(norm(x.contem)));
  return { emoji: r?.emoji || icones.padrao || EMOJI_PADRAO, links: !!r?.links };
}

const SEM_EMOJI = /[\p{Extended_Pictographic}‍️]/gu;
// Conteudo vindo do modelo ou de terceiros: sem markup que quebre a formatacao, sem travessao, sem emoji.
export function limparItem(s, max = 160) {
  let t = sanitizar(String(s ?? "")).replace(SEM_EMOJI, "").replace(/[*_~`]/g, "").replace(/\s+/g, " ").trim().replace(/^[-.\s]+/, "");
  if (t.length > max) { const corte = t.slice(0, max - 1); t = `${corte.slice(0, Math.max(corte.lastIndexOf(" "), Math.floor(max / 2))).trimEnd()}...`; }
  return t;
}

export const nomeCurto = (nome) => limparItem(String(nome).split("|")[0], 60);
const ddmm = (dia) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;

function bloco(titulo, itens) {
  const l = itens.map((i) => limparItem(i)).filter(Boolean);
  return l.length ? `*${titulo}*\n${l.map((i) => `- ${i}`).join("\n")}` : null;
}

// Divide em partes de ate `limite` caracteres, repetindo o cabecalho em cada parte.
function dividir(cabecalho, blocos, limite) {
  const partes = [];
  let atual = [];
  const tam = (arr) => cabecalho.length + 2 + arr.join("\n\n").length + 14;
  for (let b of blocos) {
    while (tam([b]) > limite && b.includes("\n")) {
      const linhas = b.split("\n");
      linhas.pop();
      b = linhas.join("\n");
    }
    if (atual.length && tam([...atual, b]) > limite) { partes.push(atual); atual = []; }
    atual.push(b);
  }
  if (atual.length) partes.push(atual);
  return partes.map((p, i) => `${cabecalho}${partes.length > 1 ? ` (${i + 1}/${partes.length})` : ""}\n\n${p.join("\n\n")}`);
}

// links: [{ url_norm, titulo }] do dia, ja limitados. Retorna uma lista de mensagens (normalmente uma).
export function formatarResumoGrupo({ nome, dia, discutido = [], decidido = [], olhar = [], links = [], icones, limite = LIMITE_MENSAGEM }) {
  const { emoji, links: comLinks } = iconeDoGrupo(nome, icones);
  const cab = `${emoji} *${nomeCurto(nome)}* · ${ddmm(dia)}`;
  const linhasLinks = comLinks ? links.slice(0, 5).map((l) => limparItem(String(l.url_norm).replace(/^https?:\/\/(www\.)?/, ""), 80)) : [];
  const blocos = [
    bloco("O que foi discutido", discutido),
    bloco("O que foi decidido", decidido),
    bloco("O que você precisa olhar", olhar),
    comLinks ? bloco("Links do dia", linhasLinks) : null,
  ].filter(Boolean);
  if (!blocos.length) blocos.push("_Sem movimento relevante._");
  return dividir(cab, blocos, limite);
}

export function esperaTexto(desdeIso, agoraMs = Date.now()) {
  const h = Math.max(0, Math.round((agoraMs - Date.parse(desdeIso)) / 3600e3));
  if (h < 1) return "menos de 1 h";
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} dias`;
}

export const haTexto = (iso, agoraMs = Date.now()) => `há ${esperaTexto(iso, agoraMs)}`;

// pendencias: [{ contato_nome, ultima_em, espera_desde, pedido, urgencia, tipo_resposta, audio_sem_transcricao }].
// Ordem: ultima mensagem recebida, da mais recente para a mais antiga. "há X" conta desde essa mensagem.
export function formatarDigestDm({ dia, pendencias: lista, porMensagem = 10, agoraMs = Date.now() }) {
  const quando = (p) => p.ultima_em || p.espera_desde;
  const pendencias = [...lista].sort((a, b) => Date.parse(quando(b)) - Date.parse(quando(a)));
  const grupos = [];
  for (let i = 0; i < pendencias.length; i += porMensagem) grupos.push(pendencias.slice(i, i + porMensagem));
  return grupos.map((g, idx) => {
    const cab = `\u{1F4EC} *Quem espera sua resposta* · ${ddmm(dia)}${grupos.length > 1 ? ` (${idx + 1}/${grupos.length})` : ""}`;
    const corpo = g.map((p) => {
      const linhas = [`${URGENCIA[p.urgencia] || URGENCIA.media} *${limparItem(p.contato_nome, 50)}* · ${haTexto(quando(p), agoraMs)}`];
      linhas.push(p.audio_sem_transcricao ? "- Quer: áudio sem transcrição" : `- Quer: ${limparItem(p.pedido, 140)}`);
      if (p.tipo_resposta) linhas.push(`- Resposta: ${limparItem(p.tipo_resposta, 100)}`);
      return linhas.join("\n");
    });
    return `${cab}\n\n${corpo.join("\n\n")}`;
  });
}
