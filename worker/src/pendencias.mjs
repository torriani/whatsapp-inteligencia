// Pendencias de resposta em DMs: quem espera, o que quer, urgencia e TIPO de resposta (nunca o texto da resposta).
import { lit, jsonLit } from "./db.mjs";
import { chamarClaude, extrairJson } from "./llm.mjs";
import { limparItem } from "./formatar.mjs";

const SAUDACAO = /^(oi+|ola+|opa|e ai|eai|bom dia|boa tarde|boa noite|tudo bem|td bem|tudo certo|blz|beleza|valeu|obrigad[oa]s?|vlw|ok|okay|certo|show|top|combinado|fechado|perfeito|entendi|sim|nao|kkk+|haha+|rs+)$/;
const norm = (s) => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}?]+/gu, " ").trim();

// Tipos de mensagem do ChatStorage: 3 audio; 15 figurinha e 11 gif nunca contam. Demais sem texto (imagem, video, documento) tambem nao.
const TIPO_AUDIO = 3;

export function saudacaoIsolada(texto) {
  const n = norm(texto);
  return n.length <= 20 && !n.includes("?") ? SAUDACAO.test(n) : /^(tudo bem|td bem|como vai|e ai)\??$/.test(n);
}

// msgs: mais recentes primeiro [{ id, do_dono, enviada_em, tipo, texto, redigida, apagada }].
// Retorna { estado: "dono"|"pendente"|"audio"|"sensivel"|"saudacao"|"vazio"|"antiga", ... }
export function classificarThread(msgs, { agoraMs = Date.now(), maxDias = 14 } = {}) {
  const util = (m) => !m.apagada && (m.redigida || m.tipo === TIPO_AUDIO || (m.texto && m.texto.trim()));
  const ultima = msgs.find(util);
  if (!ultima) return { estado: "vazio" };
  if (ultima.do_dono) return { estado: "dono", ultimaId: ultima.id };
  if (agoraMs - Date.parse(ultima.enviada_em) > maxDias * 86400e3) return { estado: "antiga", ultimaId: ultima.id };
  // inicio da sequencia sem resposta: mensagens do contato desde a ultima do dono
  let desde = ultima.enviada_em;
  for (const m of msgs) { if (m.do_dono && util(m)) break; if (!m.apagada) desde = m.enviada_em; }
  const base = { ultimaId: ultima.id, ultimaEm: ultima.enviada_em, esperaDesde: desde };
  if (ultima.redigida) return { estado: "sensivel", ...base };
  if (ultima.tipo === TIPO_AUDIO && !(ultima.texto && ultima.texto.trim())) return { estado: "audio", ...base };
  if (saudacaoIsolada(ultima.texto)) return { estado: "saudacao", ...base };
  return { estado: "pendente", ...base };
}

function promptLote(itens, agoraMs) {
  const blocos = itens.map((it, i) => {
    const linhas = [...it.msgs].reverse().filter((m) => m.texto && !m.redigida).map((m) => `${m.do_dono ? "DONO" : "CONTATO"}: ${m.texto.replace(/\s+/g, " ").slice(0, 400)}`);
    const horas = Math.round((agoraMs - Date.parse(it.cls.esperaDesde)) / 3600e3);
    return `### ${i}\nEspera: ${horas} horas\n${linhas.join("\n")}`;
  });
  return `Voce analisa conversas individuais de WhatsApp do dono do negocio (DONO) e decide se a ULTIMA fala do CONTATO ainda espera resposta.
Regras: pendente so se houver pergunta ou pedido real; agradecimento, confirmacao ou fala de encerramento nao e pendencia.
Para cada conversa devolva: "pendente" (true ou false); "pedido" (UMA frase curta com o que o contato quer, sem citar a mensagem literalmente); "urgencia" ("alta", "media" ou "baixa", considerando o pedido e o tempo de espera); "tipo_resposta" (UMA linha com o TIPO de resposta, por exemplo confirmar horario, enviar link, pedir mais contexto, recusar com educacao, agradecer e encerrar). NAO escreva a resposta.
Portugues do Brasil com acentos, sem travessao, sem emoji.
Responda JSON: {"itens":[{"i":0,"pendente":true,"pedido":"...","urgencia":"media","tipo_resposta":"..."}]}

${blocos.join("\n\n")}`;
}

// vistas: { [chatId]: ultimaMensagemId } ja analisadas sem pendencia; evita pagar o modelo de novo a cada tick.
// Opcoes do modo incremental (pendencias-atualizar): chatIds restringe as conversas olhadas; somenteContatos so cria
// pendencia nova para wa.chats.contato = true (fechar continua valendo para qualquer um); maxLlm limita as conversas
// enviadas ao modelo por rodada (o resto fica para a proxima); dryRun nao grava nem chama o modelo, so conta.
export async function analisarPendencias({ db, cfg, custo, log = () => {}, agoraMs = Date.now(), chamar = chamarClaude, vistas = {}, chatIds = null, somenteContatos = false, maxLlm = Infinity, dryRun = false }) {
  const dmCfg = cfg.dm;
  const filtroChats = chatIds ? ` and id = any(array[${chatIds.map(lit).join(",")}]::uuid[])` : "";
  const filtroMsgs = chatIds ? ` and c.id = any(array[${chatIds.map(lit).join(",")}]::uuid[])` : "";
  const chats = chatIds && !chatIds.length ? [] : await db.rows(`select id, nome, contato from wa.chats where tipo = 'direto' and modo <> 'off'${filtroChats}`);
  const r = { chats: chats.length, pendentes: 0, audio: 0, sensiveis: 0, fechadas: 0, sem_pendencia: 0, analisadas_llm: 0, ja_existentes: 0, ja_analisadas: 0, nao_contato: 0, adiadas: 0, candidatas_llm: 0 };
  if (!chats.length) return r;

  const msgs = await db.rows(`select chat_id, id, do_dono, enviada_em, tipo, texto, redigida, apagada from (
      select m.*, row_number() over (partition by m.chat_id order by m.enviada_em desc, m.id desc) rn
      from wa.mensagens m join wa.chats c on c.id = m.chat_id
      where c.tipo = 'direto' and c.modo <> 'off'${filtroMsgs} and m.enviada_em > now() - interval '${Number(dmCfg.pendencia_dias) + 16} days') x
    where rn <= 14 order by chat_id, enviada_em desc, id desc`);
  const porChat = new Map();
  for (const m of msgs) { if (!porChat.has(m.chat_id)) porChat.set(m.chat_id, []); porChat.get(m.chat_id).push(m); }
  const abertas = await db.rows(`select chat_id, mensagem_id, status from wa.pendencias_resposta`);
  const existentes = new Set(abertas.map((a) => `${a.chat_id}:${a.mensagem_id}`));
  const abertasPorChat = new Set(abertas.filter((a) => a.status === "aberta").map((a) => a.chat_id));

  const paraLlm = [];
  for (const chat of chats) {
    const lista = porChat.get(chat.id) || [];
    const cls = classificarThread(lista, { agoraMs, maxDias: dmCfg.pendencia_dias });
    if (["dono", "antiga", "vazio", "saudacao"].includes(cls.estado)) {
      if (abertasPorChat.has(chat.id) && cls.ultimaId) {
        if (!dryRun) await db.exec(`select wa.fechar_pendencias(${lit(chat.id)}::uuid, ${cls.ultimaId}::bigint)`);
        r.fechadas++;
      } else r.sem_pendencia++;
      continue;
    }
    if (existentes.has(`${chat.id}:${cls.ultimaId}`)) { r.ja_existentes++; continue; }
    if (somenteContatos && chat.contato !== true) { r.nao_contato++; continue; }
    if (cls.estado === "audio" || cls.estado === "sensivel") {
      if (!dryRun) await registrar(db, chat, cls, { pedido: cls.estado === "audio" ? "Áudio sem transcrição" : "Mensagem sensível omitida, abra no WhatsApp", urgencia: "media", tipo: cls.estado === "audio" ? "Ouvir o áudio e responder" : "Ler no WhatsApp e responder", audio: cls.estado === "audio", modelo: "regra" });
      r[cls.estado === "audio" ? "audio" : "sensiveis"]++;
      continue;
    }
    if (vistas[chat.id] === cls.ultimaId) { r.ja_analisadas++; continue; }
    paraLlm.push({ chat, cls, msgs: lista });
  }

  r.candidatas_llm = paraLlm.length;
  r.adiadas = dryRun ? 0 : Math.max(0, paraLlm.length - maxLlm);
  if (dryRun) return r;
  paraLlm.splice(maxLlm);
  for (let i = 0; i < paraLlm.length; i += dmCfg.lote_llm) {
    const lote = paraLlm.slice(i, i + dmCfg.lote_llm);
    const resp = await chamar(promptLote(lote, agoraMs), { modelo: cfg.resumo.modelo });
    custo.total += resp.custo;
    const mapa = new Map((extrairJson(resp.texto).itens || []).map((x) => [Number(x.i), x]));
    r.analisadas_llm += lote.length;
    for (let k = 0; k < lote.length; k++) {
      const x = mapa.get(k);
      const { chat, cls } = lote[k];
      if (!x || x.pendente !== true) { r.sem_pendencia++; if (x) vistas[chat.id] = cls.ultimaId; continue; }
      const urg = ["alta", "media", "baixa"].includes(x.urgencia) ? x.urgencia : "media";
      await registrar(db, chat, cls, { pedido: limparItem(x.pedido, 200), urgencia: urg, tipo: limparItem(x.tipo_resposta, 120), audio: false, modelo: cfg.resumo.modelo });
      r.pendentes++;
    }
    log(`pendencias lote ${i / dmCfg.lote_llm + 1}: ${lote.length} conversas`);
  }
  return r;
}

async function registrar(db, chat, cls, { pedido, urgencia, tipo, audio, modelo }) {
  // Uma pendencia nova substitui as antigas do mesmo contato.
  await db.exec(`select wa.fechar_pendencias(${lit(chat.id)}::uuid, ${Number(cls.ultimaId) - 1}::bigint)`);
  await db.exec(`select wa.registrar_pendencia(p_chat_id => ${lit(chat.id)}::uuid, p_mensagem_id => ${Number(cls.ultimaId)}::bigint,
    p_contato_nome => ${lit(chat.nome)}, p_espera_desde => ${lit(cls.esperaDesde)}::timestamptz, p_pedido => ${lit(pedido)},
    p_urgencia => ${lit(urgencia)}, p_tipo_resposta => ${lit(tipo)}, p_audio_sem_transcricao => ${audio ? "true" : "false"}, p_modelo => ${lit(modelo)})`);
}

// Abertas, da ultima mensagem recebida mais recente para a mais antiga. `contato` vem de wa.chats (true, false ou null = nao avaliado).
export async function pendenciasAbertas(db) {
  return db.rows(`select p.contato_nome, p.espera_desde, m.enviada_em as ultima_em, p.pedido, p.urgencia, p.tipo_resposta, p.audio_sem_transcricao, c.contato, c.jid
    from wa.pendencias_resposta p join wa.chats c on c.id = p.chat_id join wa.mensagens m on m.id = p.mensagem_id
    where p.status = 'aberta' order by m.enviada_em desc, p.id desc`);
}

// Regra do founder: so contato salvo entra no digest. null (nao avaliado) conta como nao contato (falha fechada).
export const soContatos = (pendencias) => pendencias.filter((p) => p.contato === true);

// Conversas que merecem olhar agora: contato salvo com mensagem recebida mais nova que a ultima pendencia registrada, ou com
// pendencia aberta (para fechar quando o dono respondeu). Usa so wa.chats.contato, gravado pela ingestao; nunca a agenda.
export async function chatsParaAtualizar(db, { dias = 14 } = {}) {
  const rows = await db.rows(`select c.id from wa.chats c where c.tipo = 'direto' and c.modo <> 'off' and (
      (c.contato = true and exists (select 1 from wa.mensagens m where m.chat_id = c.id and not m.do_dono and not m.apagada
         and m.enviada_em > now() - interval '${Number(dias)} days'
         and m.id > coalesce((select max(p.mensagem_id) from wa.pendencias_resposta p where p.chat_id = c.id), 0)))
      or exists (select 1 from wa.pendencias_resposta p where p.chat_id = c.id and p.status = 'aberta'))`);
  return rows.map((x) => x.id);
}
