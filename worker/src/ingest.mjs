// Ingestao real: leitor ro -> filtro sensivel -> upsert idempotente no schema wa.
import { processar } from "./processar.mjs";
import { isoParaApple } from "./reader.mjs";
import { lit, jsonLit } from "./db.mjs";

const LOTE = 500;

// Cria o chat no banco se nao existir (modo da allowlist). Nunca altera modo de chat existente:
// o portal e a segunda camada e manda no que ja existe. Uma consulta para todos os existentes.
export async function sincronizarChats(db, chats) {
  const mapa = new Map();
  if (!chats.length) return mapa;
  const existentes = new Map();
  for (let i = 0; i < chats.length; i += 200) {
    const jids = chats.slice(i, i + 200).map((c) => lit(c.jid)).join(",");
    for (const r of await db.rows(`select id, jid, modo, nome from wa.chats where jid = any(array[${jids}]::text[])`)) existentes.set(r.jid, r);
  }
  for (const c of chats) {
    const ex = existentes.get(c.jid);
    if (ex) {
      if (ex.nome !== c.nome) await db.exec(`update wa.chats set nome = ${lit(c.nome)} where id = ${lit(ex.id)}::uuid`);
      mapa.set(c.jid, { id: ex.id, modo: ex.modo });
      continue;
    }
    const id = await db.exec(`insert into wa.chats (jid, tipo, nome, categoria, modo, liberado_em)
      values (${lit(c.jid)}, ${lit(c.tipoChat || "grupo")}, ${lit(c.nome)}, null, ${lit(c.modo)}, now()) returning id`);
    mapa.set(c.jid, { id, modo: c.modo });
    // wa.chats.liberado_por e uuid (so aceita usuario do portal). A origem da liberacao fica explicita na auditoria.
    await db.exec(`insert into wa.auditoria (ator, acao, alvo, detalhe) values ('allowlist-local', 'libera_chat_allowlist_local', ${lit(id)}, ${jsonLit({ modo: c.modo, tipo: c.tipoChat || "grupo", origem: c.tipoChat === "direto" ? "whatsapp-dm-excluir.json (DMs ativas)" : "whatsapp-allowlist.json" })})`);
  }
  return mapa;
}

function paraItem(r) {
  return {
    local_pk: r.local_pk, stanza_id: r.stanza_id, autor_jid: r.autor_jid, autor_nome: r.autor, autor_push_name: r.push,
    do_dono: r.do_dono, enviada_em: r.enviada_em, tipo: r.tipo, texto: r.texto,
    redigida: r.redigida, apagada: r.apagada, responde_a_stanza: r.responde_a_stanza,
    tem_midia: r.tem_midia, midia_meta: r.tem_midia ? { tipo: r.tipo } : null, hash: r.hash,
  };
}

export async function ingerirChat({ leitor, db, chat, chatId, estado, ctx, janelaHoras, agora = Date.now(), aoLote = () => {} }) {
  const c = { lidas: 0, inalteradas: 0, gravadas: 0, eventos: 0, redigidas: 0, apagadas: 0, links: 0, descartadas_sensivel: 0, maxPk: 0 };
  const salvo = estado.chats[chat.jid];
  let afterPk; let desde;
  if (salvo) {
    afterPk = salvo.lastPk;
    desde = isoParaApple(agora - janelaHoras * 3600e3);
  } else {
    // Primeira carga: so o que e novo daqui para frente + janela (72 h, ou backfill_dias do chat).
    afterPk = await leitor.maxPk(chat.pk);
    desde = isoParaApple(agora - (chat.backfill_dias ? chat.backfill_dias * 24 : janelaHoras) * 3600e3);
  }
  const dm = chat.tipoChat === "direto";
  const ctxChat = { ...ctx, direct: dm };
  let cursor = 0;
  let maxPk = afterPk;
  for (;;) {
    const rows = await leitor.mensagens(chat.pk, { afterPk, desdeApple: desde, cursor });
    if (!rows.length) break;
    const itens = [];
    const comLinks = new Map();
    for (const row of rows) {
      cursor = row.pk;
      if (row.pk > maxPk) maxPk = row.pk;
      c.lidas++;
      const r = processar({ ...row, fromMe: row.fromMe }, ctxChat);
      if (r.kind === "evento") { c.eventos++; continue; }
      if (r.redigida) { c.redigidas++; c.descartadas_sensivel++; }
      if (r.apagada) c.apagadas++;
      if (!r.enviada_em) continue;
      itens.push(paraItem({ ...r, push: row.push, autor_jid: row.autorJid || null, responde_a_stanza: row.paiStanza || null }));
      if (r.links.length) comLinks.set(r.local_pk, r.links);
    }
    // Reprocessar a janela de 72 h so grava o que e novo ou mudou (hash diferente).
    const aGravar = await somenteMudados(db, chatId, itens);
    c.inalteradas += itens.length - aGravar.length;
    for (let i = 0; i < aGravar.length; i += LOTE) {
      const fatia = aGravar.slice(i, i + LOTE);
      await db.exec(`select wa.upsert_mensagens(${lit(chatId)}::uuid, ${jsonLit(fatia)})`);
      c.gravadas += fatia.length;
    }
    if (!dm && comLinks.size) {
      const mudados = new Set(aGravar.map((x) => x.local_pk));
      const so = new Map([...comLinks].filter(([pk]) => mudados.has(pk)));
      if (so.size) c.links += await gravarLinks(db, chatId, so);
    }
    aoLote(c);
    if (rows.length < 5000) break;
  }
  estado.chats[chat.jid] = { lastPk: maxPk, ultimaExecucao: new Date(agora).toISOString() };
  c.maxPk = maxPk;
  return c;
}

async function somenteMudados(db, chatId, itens) {
  if (!itens.length) return itens;
  const atuais = new Map();
  for (let i = 0; i < itens.length; i += 1000) {
    const pks = itens.slice(i, i + 1000).map((x) => x.local_pk).join(",");
    for (const r of await db.rows(`select local_pk, hash from wa.mensagens where chat_id = ${lit(chatId)}::uuid and local_pk = any(array[${pks}]::bigint[])`)) atuais.set(Number(r.local_pk), r.hash);
  }
  return itens.filter((x) => atuais.get(x.local_pk) !== x.hash);
}

async function gravarLinks(db, chatId, comLinks) {
  const pks = [...comLinks.keys()];
  const ids = new Map();
  for (let i = 0; i < pks.length; i += 1000) {
    const r = await db.rows(`select local_pk, id from wa.mensagens where chat_id = ${lit(chatId)}::uuid and local_pk = any(array[${pks.slice(i, i + 1000).join(",")}]::bigint[])`);
    for (const x of r) ids.set(Number(x.local_pk), x.id);
  }
  const itens = [];
  for (const [pk, links] of comLinks) {
    const mid = ids.get(pk);
    if (!mid) continue;
    for (const l of links) itens.push({ mid, url: l.url, norm: l.urlNorm, dominio: l.dominio, titulo: l.titulo || null });
  }
  for (let i = 0; i < itens.length; i += LOTE) {
    await db.exec(`select wa.registrar_link(p_chat_id => ${lit(chatId)}::uuid, p_mensagem_id => (x->>'mid')::bigint,
      p_url => x->>'url', p_url_norm => x->>'norm', p_dominio => x->>'dominio', p_titulo => x->>'titulo')
      from jsonb_array_elements(${jsonLit(itens.slice(i, i + LOTE))}) x`);
  }
  return itens.length;
}

// Perguntas candidatas por heuristica (contem "?"), respondidas via citacao.
export async function detectarPerguntas(db, chatId, desdeIso) {
  const ins = await db.exec(`with n as (
      insert into wa.perguntas (chat_id, mensagem_id, autor_id, texto_norm, status, dirigida_ao_dono)
      select m.chat_id, m.id, m.autor_id, left(lower(regexp_replace(m.texto, '\\s+', ' ', 'g')), 1000), 'aberta', coalesce(p.do_dono, false)
      from wa.mensagens m left join wa.mensagens p on p.id = m.responde_a
      where m.chat_id = ${lit(chatId)}::uuid and m.enviada_em >= ${lit(desdeIso)}::timestamptz and not m.do_dono
        and m.texto is not null and m.texto like '%?%' and length(m.texto) between 15 and 600
      on conflict (mensagem_id) do nothing returning 1) select count(*) from n`);
  const resp = await db.exec(`with u as (
      update wa.perguntas q set status = 'respondida', respondida_por_msg = r.id
      from wa.mensagens r where r.responde_a = q.mensagem_id and q.chat_id = ${lit(chatId)}::uuid and q.status = 'aberta' returning 1)
      select count(*) from u`);
  return { novas: Number(ins), respondidas: Number(resp) };
}
