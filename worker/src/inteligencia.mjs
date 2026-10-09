// Resumo diario e semanal, decisoes, perguntas e aprendizados via claude -p.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { lit, jsonLit } from "./db.mjs";
import { chamarClaude, extrairJson } from "./llm.mjs";
import { sanitizar, textoLimpo } from "./textguard.mjs";
import { TMP_DIR, HOME, TIMEZONE } from "./paths.mjs";
import { carregarTemas, regrasAprendizado, prepararAprendizado } from "./temas.mjs";

const TZ = TIMEZONE;
const VALIDADOR = ""; // Validação local via textguard; sem dependência externa.

const REGRAS_FORMA = `Cada item com no maximo 100 caracteres, uma ideia por linha. Regras de forma: portugues do Brasil com acentos, frases curtas e diretas, sem travessao, sem emoji, sem adjetivos de marketing, nao cite mensagens literalmente, nao copie frases das pessoas, nao invente nada que nao esteja nas mensagens. Dados pessoais sensiveis (documentos, senhas, dinheiro pessoal) nunca entram.`;

// Valida forma. Retorna { ok, motivo } sem expor texto de chat (so o resumo gerado).
export function validarAntiIa(textoResumo, validador = VALIDADOR) {
  if (!textoLimpo(textoResumo)) return { ok: false, motivo: "travessao ou emoji" };
  if (!fs.existsSync(validador)) return { ok: true, motivo: "validador ausente" };
  fs.mkdirSync(TMP_DIR, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(TMP_DIR, "val-"));
  const arq = path.join(dir, "resumo.md");
  fs.writeFileSync(arq, textoResumo, { mode: 0o600 });
  try {
    const r = spawnSync("bash", [validador, arq], { encoding: "utf8", timeout: 30000 });
    return { ok: r.status === 0, motivo: r.status === 0 ? "ok" : `anti-ia status ${r.status}`, detalhe: (r.stdout || "").slice(0, 600) };
  } finally {
    fs.unlinkSync(arq);
    fs.rmdirSync(dir);
  }
}

const juntar = (o) => [...(o.discutido || []), ...(o.decidido || []), ...(o.olhar || [])].map((x) => (typeof x === "string" ? x : x.texto || "")).join("\n");

export const textos = (l) => [].concat(l || []).map((x) => (typeof x === "string" ? x : x?.texto || "")).filter(Boolean).join("; ");
const objs = (l) => l.map((texto) => ({ texto }));

function limparLista(l, max = 8) {
  return (Array.isArray(l) ? l : []).map((x) => (typeof x === "string" ? x : x?.texto || "")).map((s) => sanitizar(s.trim())).filter(Boolean).slice(0, max);
}

async function gerarComValidacao(prompt, { modelo, custo }) {
  let tentativa = 0; let aviso = "";
  let ultimo = null;
  while (tentativa < 2) {
    const r = await chamarClaude(prompt + aviso, { modelo });
    custo.total += r.custo;
    const obj = extrairJson(r.texto);
    const v = validarAntiIa(juntar(obj));
    ultimo = { obj, antiIa: v.ok };
    if (v.ok) return ultimo;
    aviso = `\n\nA versao anterior foi reprovada na checagem de forma (${v.motivo}). Reescreva todo o JSON com frases mais naturais, curtas e especificas, sem travessao e sem emoji.`;
    tentativa++;
  }
  return ultimo;
}

export async function mensagensDoDia(db, chatId, dia, maxChars) {
  const rows = await db.rows(`select m.id, to_char(m.enviada_em at time zone ${lit(TZ)}, 'HH24:MI') hh,
      coalesce(p.nome, p.push_name, 'participante') autor, m.do_dono, left(m.texto, 400) texto
    from wa.mensagens m left join wa.participantes p on p.id = m.autor_id
    where m.chat_id = ${lit(chatId)}::uuid and m.texto is not null and length(m.texto) >= 4
      and (m.enviada_em at time zone ${lit(TZ)})::date = ${lit(dia)}::date
    order by m.enviada_em`);
  const linhas = rows.map((r) => `[${r.id}] ${r.hh} ${r.do_dono ? "DONO" : r.autor}: ${r.texto.replace(/\s+/g, " ")}`);
  let total = 0; const manter = [];
  for (let i = linhas.length - 1; i >= 0; i--) { total += linhas[i].length + 1; if (total > maxChars) break; manter.unshift(rows[i]); }
  const ids = new Set(manter.map((r) => Number(r.id)));
  return { linhas: linhas.slice(linhas.length - manter.length), ids, total: rows.length, msgDe: manter[0]?.id, msgAte: manter.at(-1)?.id };
}

export async function resumoDiario({ db, chat, dia, cfg, custo }) {
  const ja = await db.rows(`select id from wa.resumos where chat_id = ${lit(chat.id)}::uuid and periodo = 'dia' and data_ref = ${lit(dia)}::date`);
  if (ja.length) return { status: "ja_existe" };
  const m = await mensagensDoDia(db, chat.id, dia, cfg.resumo.max_chars_entrada);
  if (m.total < cfg.resumo.minimo_mensagens_dia) return { status: "poucas_mensagens", mensagens: m.total };
  // Aprendizado nunca vem de DM e so existe com temas configurados em wa.config.
  const temas = chat.modo === "inteligencia" && chat.tipo !== "direto" ? await carregarTemas(db) : [];
  const aprender = temas.length > 0;
  const prompt = `Voce resume um dia de um grupo de WhatsApp de trabalho para o dono do negocio. Cada linha: [id] hora autor: texto.
${REGRAS_FORMA}
Devolva JSON com estas chaves:
- "discutido": lista de ate 6 topicos curtos (uma frase cada)
- "decidido": lista de ate 5 objetos {"texto", "mensagem_id", "responsavel"} so para decisoes explicitas; responsavel pode ser null
- "olhar": lista de ate 5 itens que o dono precisa ver ou responder
- "perguntas": lista de ate 8 objetos {"mensagem_id", "topico"} para perguntas reais ainda sem resposta clara
- "aprendizados": ${aprender ? `lista de ate ${cfg.resumo.max_aprendizados_por_dia} objetos {"titulo", "corpo", "tema", "tags", "fontes", "confianca"}, fontes = ids das mensagens, confianca de 1 a 5; sem nome de pessoa. ${regrasAprendizado(temas)}` : "lista vazia"}
Use apenas ids que aparecem nas linhas. Se nao houver nada para uma chave, devolva lista vazia.

Mensagens do dia ${dia}:
${m.linhas.join("\n")}`;
  const { obj, antiIa } = await gerarComValidacao(prompt, { modelo: cfg.resumo.modelo, custo });
  const discutido = limparLista(obj.discutido, 6);
  const olhar = limparLista(obj.olhar, 5);
  const decis = (Array.isArray(obj.decidido) ? obj.decidido : []).slice(0, 5).map((d) => ({
    texto: sanitizar(String(d.texto || "").trim()), mensagem_ref: m.ids.has(Number(d.mensagem_id)) ? Number(d.mensagem_id) : null,
    decidida_em: dia, responsavel: d.responsavel ? sanitizar(String(d.responsavel)) : null,
  })).filter((d) => d.texto);
  const modelo = `${cfg.resumo.modelo}${antiIa ? "" : "+anti-ia-pendente"}`;
  await db.exec(`select wa.registrar_resumo(p_chat_id => ${lit(chat.id)}::uuid, p_periodo => 'dia', p_data_ref => ${lit(dia)}::date,
    p_discutido => ${jsonLit(objs(discutido))}, p_decidido => ${jsonLit(objs(decis.map((d) => d.texto)))}, p_olhar => ${jsonLit(objs(olhar))},
    p_n_mensagens => ${m.total}, p_msg_de => ${m.msgDe ?? "null"}, p_msg_ate => ${m.msgAte ?? "null"}, p_modelo => ${lit(modelo)},
    p_decisoes => ${jsonLit(decis)})`);

  let nPerg = 0;
  for (const q of (Array.isArray(obj.perguntas) ? obj.perguntas : []).slice(0, 8)) {
    const id = Number(q.mensagem_id);
    if (!m.ids.has(id) || !q.topico) continue;
    await db.exec(`update wa.perguntas set topico = ${lit(sanitizar(String(q.topico)).slice(0, 120))} where mensagem_id = ${id} and chat_id = ${lit(chat.id)}::uuid`);
    nPerg++;
  }
  // Candidatas do dia que o resumo nao confirmou como pergunta real sem resposta saem da fila aberta.
  await db.exec(`update wa.perguntas q set status = 'ignorada' from wa.mensagens m
    where m.id = q.mensagem_id and q.chat_id = ${lit(chat.id)}::uuid and q.status = 'aberta' and q.topico is null
      and (m.enviada_em at time zone ${lit(TZ)})::date = ${lit(dia)}::date`);
  let nAprend = 0;
  if (aprender) {
    for (const a of (Array.isArray(obj.aprendizados) ? obj.aprendizados : []).slice(0, cfg.resumo.max_aprendizados_por_dia)) {
      const ap = prepararAprendizado(a, { temas, ids: m.ids });
      if (!ap) continue;
      await db.exec(`select wa.registrar_aprendizado(p_chat_id => ${lit(chat.id)}::uuid, p_titulo => ${lit(ap.titulo)},
        p_corpo => ${lit(ap.corpo)}, p_fontes => array[${ap.fontes.join(",")}]::bigint[],
        p_tags => array(select jsonb_array_elements_text(${jsonLit(ap.tags)})), p_confianca => ${ap.confianca}::smallint,
        p_tema => ${lit(ap.tema)})`);
      nAprend++;
    }
  }
  return { status: "gerado", mensagens: m.total, discutido: discutido.length, decisoes: decis.length, olhar: olhar.length, perguntas_topico: nPerg, aprendizados: nAprend, anti_ia: antiIa };
}

export async function resumoSemanal({ db, chat, domingo, cfg, custo }) {
  const ja = await db.rows(`select id from wa.resumos where chat_id = ${lit(chat.id)}::uuid and periodo = 'semana' and data_ref = ${lit(domingo)}::date`);
  if (ja.length) return { status: "ja_existe" };
  const dias = await db.rows(`select data_ref::text d, discutido, decidido, olhar, n_mensagens, msg_de, msg_ate from wa.resumos
    where chat_id = ${lit(chat.id)}::uuid and periodo = 'dia' and data_ref between (${lit(domingo)}::date - 6) and ${lit(domingo)}::date order by data_ref`);
  if (dias.length < 2) return { status: "poucos_dias", dias: dias.length };
  const prompt = `Consolide os resumos diarios de uma semana de um grupo de WhatsApp de trabalho em um resumo semanal para o dono do negocio.
${REGRAS_FORMA}
Devolva JSON com "discutido" (ate 6 topicos), "decidido" (ate 6 itens, lista de textos) e "olhar" (ate 6 itens que ainda pedem atencao).
Resumos diarios:
${dias.map((d) => `${d.d}\nDiscutido: ${textos(d.discutido)}\nDecidido: ${textos(d.decidido)}\nOlhar: ${textos(d.olhar)}`).join("\n\n")}`;
  const { obj, antiIa } = await gerarComValidacao(prompt, { modelo: cfg.resumo.modelo, custo });
  const total = dias.reduce((a, d) => a + Number(d.n_mensagens), 0);
  const de = Math.min(...dias.map((d) => Number(d.msg_de)).filter(Boolean));
  const ate = Math.max(...dias.map((d) => Number(d.msg_ate)).filter(Boolean));
  await db.exec(`select wa.registrar_resumo(p_chat_id => ${lit(chat.id)}::uuid, p_periodo => 'semana', p_data_ref => ${lit(domingo)}::date,
    p_discutido => ${jsonLit(objs(limparLista(obj.discutido, 6)))}, p_decidido => ${jsonLit(objs(limparLista(obj.decidido, 6)))}, p_olhar => ${jsonLit(objs(limparLista(obj.olhar, 6)))},
    p_n_mensagens => ${total}, p_msg_de => ${Number.isFinite(de) ? de : "null"}, p_msg_ate => ${Number.isFinite(ate) ? ate : "null"},
    p_modelo => ${lit(`${cfg.resumo.modelo}${antiIa ? "" : "+anti-ia-pendente"}`)})`);
  return { status: "gerado", dias: dias.length, mensagens: total, anti_ia: antiIa };
}

export const diaBrt = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
export const addDias = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
