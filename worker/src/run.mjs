import { TIMEZONE } from "./paths.mjs";
// Orquestracao: ingestao, resumos, tick. Saida so com contagens.
import fs from "node:fs";
import { criarLeitor } from "./reader.mjs";
import { criarDb, lit } from "./db.mjs";
import { carregarAllowlist, resolverChats, checarPermissao600 } from "./allowlist.mjs";
import { carregarConfig } from "./config.mjs";
import { compilarTermos, parseTermos } from "./sensitive.mjs";
import { DENY_TERMS_FILE } from "./paths.mjs";
import { carregarEstado, atualizarEstado, adquirirLock, liberarLock } from "./state.mjs";
import { sincronizarChats, ingerirChat, detectarPerguntas } from "./ingest.mjs";
import { resumoDiario, resumoSemanal, diaBrt, addDias } from "./inteligencia.mjs";
import { norm } from "./allowlist.mjs";
import { enviarTexto } from "./sender.mjs";
import { textos } from "./inteligencia.mjs";
import { jsonLit } from "./db.mjs";
import { carregarIcones, formatarResumoGrupo, formatarDigestDm } from "./formatar.mjs";
import { carregarExclusoes, resolverDms } from "./dm.mjs";
import { analisarPendencias, chatsParaAtualizar, pendenciasAbertas, soContatos } from "./pendencias.mjs";
import { criarLeitorContatos, sincronizarContatos } from "./contatos.mjs";
import { montarListaNaoContatos, nomeComNumero, nomeParaLista, atualizarNomes } from "./naocontatos.mjs";

export function contextoSensivel(config) {
  let termosRegex = null;
  if (fs.existsSync(DENY_TERMS_FILE)) {
    checarPermissao600(DENY_TERMS_FILE);
    termosRegex = compilarTermos(parseTermos(fs.readFileSync(DENY_TERMS_FILE, "utf8")));
  }
  return { termosRegex, termosEmTodas: !!config.termos_em_todas_as_mensagens };
}

const filtrar = (chats, grupo) => (grupo ? chats.filter((c) => norm(c.nome).includes(norm(grupo))) : chats);

export async function ingerir({ grupo = null, janelaHoras = null, log = console.log, deps = {} } = {}) {
  const cfg = deps.cfg || carregarConfig();
  if (janelaHoras) cfg.janela_horas = janelaHoras;
  const leitor = deps.leitor || criarLeitor();
  await leitor.schemaGuard();
  // Allowlist so do arquivo local; ausente = falha fechada (lanca antes de qualquer acesso ao banco).
  const allow = deps.allow || carregarAllowlist();
  const db = deps.db || criarDb(cfg.banco);
  const sessoes = await leitor.sessoes();
  const estado = deps.estado || carregarEstado();
  const grupos_ = resolverChats(allow, sessoes);
  // DMs (autorizadas pelo founder): so se a lista local de exclusao existir (falha fechada) e a config permitir.
  let dms = [];
  let agendaSalva = null;
  if (cfg.dm?.ativo) {
    const excl = deps.exclusoes || carregarExclusoes();
    let nomear = deps.nomear || null;
    if (!nomear) {
      try {
        const lc = criarLeitorContatos(); const agenda = await lc.jidsSalvos(); const push = await lc.pushnames();
        agendaSalva = agenda;
        nomear = (s) => nomeComNumero(s.jid, s.nome, push, agenda);
      } catch (e) { log(`nomes: agenda indisponivel (${e.message}); usando o nome do chat`); }
    }
    dms = resolverDms(sessoes, excl, { dias: cfg.dm.dias_atividade, conhecidos: new Set(Object.keys(estado.chats)), nomear });
  }
  const chats = filtrar([...grupos_, ...dms], grupo);
  if (!chats.length) { log("ingestao: nenhum chat liberado pela allowlist local; nada lido, nada gravado"); return { total: { lidas: 0, gravadas: 0, descartadas_sensivel: 0 }, grupos: [] }; }
  // Grava so as marcas d'agua de chats, sem pisar no que a fase de resumos escreve em paralelo.
  const salvar = deps.salvarEstado || ((est) => atualizarEstado((e) => { e.chats = { ...e.chats, ...est.chats }; }));
  const exec = { id: Number(await db.exec(`insert into wa.ingestao_execucoes (iniciou_em) values (now()) returning id`)) };
  const mapa = await sincronizarChats(db, chats);
  // Fonte do "contato salvo" para os agendados (pendencias, consumidor de respostas), que nao podem abrir a agenda do WhatsApp.
  if (agendaSalva) { try { log(`contatos: ${JSON.stringify(await sincronizarContatos(db, agendaSalva))}`); } catch (e) { log(`contatos: nao gravado (${e.message})`); } }
  const ctx = deps.ctx || contextoSensivel(cfg);
  const total = { lidas: 0, gravadas: 0, descartadas_sensivel: 0 };
  const grupos = [];
  const dmAgg = { chats: 0, lidas: 0, gravadas: 0, redigidas: 0 };
  let erro = null;
  try {
    for (const chat of chats) {
      const m = mapa.get(chat.jid);
      if (!m || m.modo === "off") { grupos.push({ grupo: chat.nome, ignorado: "modo off no banco" }); continue; }
      const c = await ingerirChat({ leitor, db, chat, chatId: m.id, estado, ctx, janelaHoras: cfg.janela_horas });
      const desde = new Date(Date.now() - (chat.backfill_dias ? chat.backfill_dias * 24 : cfg.janela_horas) * 3600e3).toISOString();
      const dm = chat.tipoChat === "direto";
      const p = dm ? { novas: 0, respondidas: 0 } : await detectarPerguntas(db, m.id, desde);
      salvar(estado);
      grupos.push({ grupo: dm ? "DM" : chat.nome, dm, ...c, perguntas_novas: p.novas, perguntas_respondidas: p.respondidas });
      total.lidas += c.lidas; total.gravadas += c.gravadas; total.descartadas_sensivel += c.descartadas_sensivel;
      if (dm) { dmAgg.chats++; dmAgg.lidas += c.lidas; dmAgg.gravadas += c.gravadas; dmAgg.redigidas += c.redigidas; }
      else log(`ingestao ${chat.nome.slice(0, 40)}: lidas=${c.lidas} novas_ou_mudadas=${c.gravadas} inalteradas=${c.inalteradas} redigidas=${c.redigidas} links=${c.links} eventos=${c.eventos}`);
    }
  } catch (e) { erro = e.message; throw e; }
  finally {
    if (dmAgg.chats) log(`ingestao DMs: conversas=${dmAgg.chats} lidas=${dmAgg.lidas} gravadas=${dmAgg.gravadas} redigidas=${dmAgg.redigidas}`);
    await db.exec(`update wa.ingestao_execucoes set terminou_em = now(), lidas = ${total.lidas}, gravadas = ${total.gravadas},
      descartadas_sensivel = ${total.descartadas_sensivel}, erro = ${lit(erro)} where id = ${Number(exec.id)}`);
  }
  return { total, grupos };
}

async function chatsParaResumo(db, cfg, grupo) {
  const rows = await db.rows(`select id, jid, nome, modo, tipo from wa.chats where modo = any(array[${cfg.resumo.modos.map(lit).join(",")}]::text[]) order by nome`);
  return filtrar(rows, grupo);
}

export async function resumir({ grupo = null, dia = null, log = console.log } = {}) {
  const cfg = carregarConfig();
  const db = criarDb(cfg.banco);
  const custo = { total: 0 };
  const alvo = dia || addDias(diaBrt(Date.now()), -1);
  const out = [];
  for (const chat of await chatsParaResumo(db, cfg, grupo)) {
    const r = await resumoDiario({ db, chat, dia: alvo, cfg, custo });
    out.push({ grupo: chat.nome, dia: alvo, ...r });
    log(`resumo dia ${alvo} ${chat.nome.slice(0, 40)}: ${JSON.stringify(r)}`);
  }
  return { custo_usd: Number(custo.total.toFixed(4)), resultados: out };
}

export async function resumirSemana({ grupo = null, domingo, log = console.log } = {}) {
  const cfg = carregarConfig();
  const db = criarDb(cfg.banco);
  const custo = { total: 0 };
  const out = [];
  for (const chat of await chatsParaResumo(db, cfg, grupo)) {
    const r = await resumoSemanal({ db, chat, domingo, cfg, custo });
    out.push({ grupo: chat.nome, ...r });
    log(`resumo semana ${domingo} ${chat.nome.slice(0, 40)}: ${JSON.stringify(r)}`);
  }
  return { custo_usd: Number(custo.total.toFixed(4)), resultados: out };
}

// Backfill de resumos diarios do passado, com teto de custo (D7).
export async function backfillResumos({ grupo = null, dias = 90, log = console.log } = {}) {
  const cfg = carregarConfig();
  const db = criarDb(cfg.banco);
  const custo = { total: 0 };
  const hoje = diaBrt(Date.now());
  const out = [];
  const chats = await chatsParaResumo(db, cfg, grupo);
  const allow = carregarAllowlist();
  const comBackfill = chats.filter((c) => allow.allow.some((r) => r.backfill_dias && norm(r.nome) && (norm(c.nome) === norm(r.nome) || (r.match === "contem" && norm(c.nome).includes(norm(r.nome))))));
  let parou = false;
  for (const chat of comBackfill) {
    const diasComMsg = await db.rows(`select distinct (enviada_em at time zone ${lit(TIMEZONE)})::date::text d from wa.mensagens
      where chat_id = ${lit(chat.id)}::uuid and texto is not null and enviada_em >= now() - interval '${Number(dias)} days' order by 1`);
    for (const { d } of diasComMsg) {
      if (d >= hoje) continue;
      if (custo.total >= cfg.resumo.teto_backfill_usd) { parou = true; break; }
      try {
        const r = await resumoDiario({ db, chat, dia: d, cfg, custo });
        out.push({ grupo: chat.nome, dia: d, status: r.status });
        if (r.status === "gerado") log(`backfill ${chat.nome.slice(0, 30)} ${d}: custo acumulado US$ ${custo.total.toFixed(3)}`);
      } catch (e) { out.push({ grupo: chat.nome, dia: d, status: `erro: ${e.message}` }); }
    }
    if (parou) break;
  }
  atualizarEstado((e) => { e.custo_usd[`backfill-${hoje}`] = (e.custo_usd[`backfill-${hoje}`] || 0) + custo.total; });
  return { custo_usd: Number(custo.total.toFixed(4)), teto_atingido: parou, resultados: out };
}

async function auditar(db, acao, resumoId, detalhe) {
  const motivo = detalhe.motivo || "";
  const ja = await db.rows(`select 1 from wa.auditoria where acao = ${lit(acao)} and alvo = ${lit(String(resumoId))} and detalhe->>'motivo' = ${lit(motivo)} limit 1`);
  if (ja.length) return false;
  await db.exec(`insert into wa.auditoria (ator, acao, alvo, detalhe) values ('worker', ${lit(acao)}, ${lit(String(resumoId))}, ${jsonLit(detalhe)})`);
  return true;
}

// Recheck before each outbound part. Only explicit JSON boolean false releases the switch.
async function enviarNotificacaoComTrava(db, options) {
  if (!options.dryRun && options.config.ENVIO_ATIVO === true) {
    try {
      const [row] = await db.rows("select valor from wa.config where chave = 'kill_switch_envio'");
      if (row?.valor !== false) return { enviado: false, motivo: "kill_switch_ligado" };
    } catch { return { enviado: false, motivo: "kill_switch_indisponivel" }; }
  }
  return enviarTexto(options);
}

const slug = (x) => String(x).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

// Envia (ou registra a tentativa) do resumo diario de CADA grupo, uma mensagem por grupo (dividida se passar do limite).
// Grava wa.auditoria: resumo_enviado (alvo = wa.resumos.id) ou resumo_nao_enviado com o motivo.
// reenviar + sufixo: reenvia um resumo ja enviado (teste visual) com chave nova; audita como resumo_teste_visual.
export async function notificarResumos({ dia, dryRun = true, log = console.log, deps = {}, grupo = null, reenviar = false, sufixo = null } = {}) {
  const cfg = deps.cfg || carregarConfig();
  const db = deps.db || criarDb(cfg.banco);
  const icones = deps.icones || carregarIcones();
  const alvo = dia || addDias(diaBrt(Date.now()), -1);
  const filtroEnviado = reenviar ? "" : "and not exists (select 1 from wa.auditoria a where a.acao = 'resumo_enviado' and a.alvo = r.id::text)";
  let rs = await db.rows(`select r.id, r.chat_id, c.nome, r.discutido, r.decidido, r.olhar from wa.resumos r join wa.chats c on c.id = r.chat_id
    where r.periodo = 'dia' and r.data_ref = ${lit(alvo)}::date and c.modo = any(array[${cfg.resumo.modos.map(lit).join(",")}]::text[]) ${filtroEnviado} order by c.nome`);
  if (grupo) rs = rs.filter((r) => norm(r.nome).includes(norm(grupo)));
  if (!rs.length) { log(`notificar ${alvo}: nada pendente`); return { pendentes: 0 }; }
  const destino = cfg.notificacao.grupo;
  let enviados = 0; let naoEnviados = 0; let ultimoMotivo = null; let partesTotal = 0;
  for (const r of rs) {
    const links = icones && (await db.rows(`select url_norm, titulo from wa.links where chat_id = ${lit(r.chat_id)}::uuid
      and (compartilhado_em at time zone ${lit(TIMEZONE)})::date = ${lit(alvo)}::date order by vezes desc, compartilhado_em limit 5`));
    const partes = formatarResumoGrupo({
      nome: r.nome, dia: alvo, icones,
      discutido: textos(r.discutido).split("; ").filter(Boolean), decidido: textos(r.decidido).split("; ").filter(Boolean), olhar: textos(r.olhar).split("; ").filter(Boolean), links,
    });
    partesTotal += partes.length;
    let ok = true; let motivo = "enviado"; let ultimaChave = null;
    for (let i = 0; i < partes.length; i++) {
      const chave = `whatsapp-inteligencia:resumo:v2:${alvo}:${slug(destino)}:${slug(r.nome).slice(0, 40)}:p${i + 1}${sufixo ? `:${slug(sufixo)}` : ""}`;
      ultimaChave = chave;
      let res;
      try { res = await enviarNotificacaoComTrava(db, { texto: partes[i], chave, grupo: destino, config: cfg, dryRun, exec: deps.exec, permitirEmoji: true }); }
      catch (e) { res = { enviado: false, motivo: `erro no envio: ${e.message}`.slice(0, 160) }; }
      if (!res.enviado) { ok = false; motivo = res.motivo; break; }
      if (i < partes.length - 1 && !deps.exec) await pausa(2000);
    }
    const acao = ok ? (reenviar ? "resumo_teste_visual" : "resumo_enviado") : "resumo_nao_enviado";
    await auditar(db, acao, r.id, { motivo, destino, chave: ultimaChave, partes: partes.length, caracteres: partes.reduce((a, p) => a + p.length, 0) });
    if (ok) enviados++; else { naoEnviados++; ultimoMotivo = motivo; }
    if (ok && !deps.exec && !dryRun) await pausa(2000);
  }
  log(`notificar ${alvo}: resumos=${rs.length} mensagens=${partesTotal} enviados=${enviados} nao_enviados=${naoEnviados} motivo=${ultimoMotivo || "ok"}`);
  return { pendentes: rs.length, enviado: naoEnviados === 0, motivo: ultimoMotivo, enviados, naoEnviados, mensagens: partesTotal };
}

// Digest "Quem espera sua resposta". Conteudo de DM so sai para destino_dm; vazio = nada sai (fica no portal).
export async function notificarDigestDm({ dia, dryRun = true, log = console.log, deps = {} } = {}) {
  const cfg = deps.cfg || carregarConfig();
  const db = deps.db || criarDb(cfg.banco);
  const alvo = dia || diaBrt(Date.now());
  const todas = await pendenciasAbertas(db);
  // Regra do founder: so contato salvo entra no digest (cfg.dm.somente_contatos). Os demais ficam na lista unica de nao contatos.
  let agenda = deps.salvos || new Map(); let push = deps.pushnames || new Map();
  if (!deps.salvos) { try { const lc = deps.leitorContatos || criarLeitorContatos(); agenda = await lc.jidsSalvos(); push = await lc.pushnames(); } catch (e) { log(`digest DM: agenda indisponivel (${e.message}); usando nomes gravados`); } }
  // Nunca mostrar codigo: nome salvo, depois pushname, depois nome do chat, senao "sem nome" + numero.
  const nomeadas = todas.map((p) => ({ ...p, contato_nome: nomeComNumero(p.jid, p.contato_nome, push, agenda) }));
  const pend = cfg.dm.somente_contatos === false ? nomeadas : soContatos(nomeadas);
  const ocultas = todas.length - pend.length;
  if (!pend.length) { log(`digest DM ${alvo}: sem pendencias de contatos (nao contatos ocultos=${ocultas})`); return { pendencias: 0, mensagens: 0, enviado: false, ocultas }; }
  const partes = formatarDigestDm({ dia: alvo, pendencias: pend, porMensagem: cfg.dm.digest_max_por_mensagem });
  const destino = cfg.notificacao.destino_dm;
  const alvoAud = `digest-dm:${alvo}`;
  if (!destino) {
    await auditar(db, "resumo_nao_enviado", alvoAud, { motivo: "destino_dm vazio", mensagens: partes.length, pendencias: pend.length });
    log(`digest DM ${alvo}: pendencias=${pend.length} mensagens=${partes.length} nao enviado (destino_dm vazio; fica no portal)`);
    return { pendencias: pend.length, mensagens: partes.length, enviado: false, motivo: "destino_dm vazio" };
  }
  let ok = true; let motivo = "enviado";
  for (let i = 0; i < partes.length; i++) {
    const chave = `whatsapp-inteligencia:digest-dm:${alvo}:${slug(destino)}:p${i + 1}`;
    let res;
    try { res = await enviarNotificacaoComTrava(db, { texto: partes[i], chave, grupo: destino, config: cfg, dryRun, exec: deps.exec, permitirEmoji: true }); }
    catch (e) { res = { enviado: false, motivo: `erro no envio: ${e.message}`.slice(0, 160) }; }
    if (!res.enviado) { ok = false; motivo = res.motivo; break; }
    if (i < partes.length - 1 && !deps.exec) await pausa(2000);
  }
  await auditar(db, ok ? "resumo_enviado" : "resumo_nao_enviado", alvoAud, { motivo, destino: "destino_dm", mensagens: partes.length, pendencias: pend.length });
  log(`digest DM ${alvo}: pendencias=${pend.length} nao_contatos_ocultos=${ocultas} mensagens=${partes.length} enviado=${ok} motivo=${ok ? "ok" : motivo}`);
  return { pendencias: pend.length, ocultas, mensagens: partes.length, enviado: ok, motivo };
}

export async function pendenciasDm({ log = console.log, deps = {} } = {}) {
  const cfg = deps.cfg || carregarConfig();
  const db = deps.db || criarDb(cfg.banco);
  const custo = { total: 0 };
  // Marca contato=true/false em wa.chats a partir da agenda do WhatsApp. Se a agenda falhar, as marcas anteriores ficam.
  try {
    const salvos = deps.salvos || await (deps.leitorContatos || criarLeitorContatos()).jidsSalvos();
    log(`contatos: ${JSON.stringify(await sincronizarContatos(db, salvos))}`);
    const push = deps.pushnames || await (deps.leitorContatos || criarLeitorContatos()).pushnames();
    log(`nomes de DMs atualizados: ${await atualizarNomes(db, salvos, push)}`);
  } catch (e) { log(`contatos: nao atualizado (${e.message})`); }
  const vistas = { ...(deps.vistas || carregarEstado().pendencias_vistas || {}) };
  const r = await analisarPendencias({ db, cfg, custo, log, chamar: deps.chamar, vistas });
  if (!deps.vistas) atualizarEstado((e) => { e.pendencias_vistas = { ...(e.pendencias_vistas || {}), ...vistas }; });
  log(`pendencias DM: ${JSON.stringify(r)} custo claude -p US$ ${custo.total.toFixed(3)}`);
  return { ...r, custo_usd: Number(custo.total.toFixed(4)) };
}

// Rodada incremental, pensada para o agendador (a cada 15 min): olha so contatos salvos (wa.chats.contato, gravado pela
// ingestao) com mensagem nova sem pendencia registrada, mais as conversas com pendencia aberta (para fechar quando o dono
// respondeu). Nunca abre a agenda do WhatsApp, nunca envia nada. Teto de conversas ao modelo por rodada (cfg.dm.atualizar_max_conversas).
export async function pendenciasAtualizar({ dryRun = false, log = console.log, deps = {} } = {}) {
  const cfg = deps.cfg || carregarConfig();
  const db = deps.db || criarDb(cfg.banco);
  const custo = { total: 0 };
  const ids = await chatsParaAtualizar(db, { dias: cfg.dm.pendencia_dias });
  const vistas = { ...(deps.vistas || carregarEstado().pendencias_vistas || {}) };
  const r = await analisarPendencias({ db, cfg, custo, log, chamar: deps.chamar, vistas, chatIds: ids, somenteContatos: cfg.dm.somente_contatos !== false, maxLlm: cfg.dm.atualizar_max_conversas, dryRun });
  if (!dryRun && !deps.vistas) atualizarEstado((e) => { e.pendencias_vistas = { ...(e.pendencias_vistas || {}), ...vistas }; });
  const hoje = diaBrt(Date.now());
  if (!dryRun && !deps.vistas && custo.total) atualizarEstado((e) => { e.custo_usd[hoje] = (e.custo_usd[hoje] || 0) + custo.total; });
  const saida = { dry_run: dryRun, candidatas: ids.length, ...r, custo_usd: Number(custo.total.toFixed(4)) };
  log(`pendencias-atualizar: ${JSON.stringify(saida)}`);
  return saida;
}

// Lista unica (dry-run, nunca envia) das pendencias abertas de quem NAO e contato salvo. Contato calculado ao vivo pela agenda.
export async function listaNaoContatos({ dia, deps = {}, agoraMs = Date.now() } = {}) {
  const cfg = deps.cfg || carregarConfig();
  const db = deps.db || criarDb(cfg.banco);
  const leitor = deps.leitorContatos || criarLeitorContatos();
  const salvos = deps.salvos || await leitor.jidsSalvos();
  const pushnames = deps.pushnames || await leitor.pushnames();
  const exclusoes = deps.exclusoes || carregarExclusoes();
  const todas = (await pendenciasAbertas(db)).map((p) => ({ ...p, contato: salvos.has(p.jid) }));
  const r = montarListaNaoContatos({ pendencias: todas, pushnames, agenda: salvos, exclusoes, dia: dia || diaBrt(agoraMs), agoraMs });
  const resolvidas = todas.filter((p) => nomeParaLista(p.jid, p.contato_nome, pushnames, salvos) !== "sem nome").length;
  return { ...r, nomesResolvidos: resolvidas, nomesSem: todas.length - resolvidas, abertas: todas.length, contatos: todas.filter((p) => p.contato).length, semNome: r.itens.filter((i) => i.nome === "sem nome").length };
}

// Um ciclo do LaunchAgent. Duas fases com locks proprios:
// 1) ingestao (rapida): sempre primeiro; 2) resumos e notificacao (lenta, claude -p): so uma por vez.
// Um tick longo de resumos nunca bloqueia a ingestao do tick seguinte, e duas fases iguais nunca rodam juntas.
// Locks que ESTE processo de tick segurou; o watchdog libera so esses (nunca o lock de outro processo).
const locksDoTick = new Set();
export const liberarLocksDoTick = () => { for (const n of locksDoTick) liberarLock(n); locksDoTick.clear(); };

export async function tick({ log = console.log } = {}) {
  const cfg = carregarConfig();
  if (adquirirLock("ingestao", 30 * 60 * 1000)) {
    locksDoTick.add("ingestao");
    try { await ingerir({ log }); } finally { liberarLock("ingestao"); locksDoTick.delete("ingestao"); }
  } else log("tick: ingestao em andamento em outro processo, pulando");

  if (!adquirirLock("resumos", 3 * 3600 * 1000)) { log("tick: resumos em andamento em outro processo, pulando"); return; }
  locksDoTick.add("resumos");
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map(p => [p.type, p.value]));
    const agora = new Date(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`);
    const hoje = agora.toISOString().slice(0, 10);
    const minutos = agora.getUTCHours() * 60 + agora.getUTCMinutes();
    let estado = carregarEstado();
    if (minutos >= cfg.ritmo.resumo_hora * 60 + cfg.ritmo.resumo_minuto && estado.resumos.diario !== hoje) {
      const r = await resumir({ log });
      estado = atualizarEstado((e) => { e.resumos.diario = hoje; e.custo_usd[hoje] = (e.custo_usd[hoje] || 0) + r.custo_usd; });
    }
    if (estado.resumos.diario === hoje && estado.resumos.notificado !== hoje) {
      const n = await notificarResumos({ dryRun: false, log });
      if (n.enviado || n.pendentes === 0) estado = atualizarEstado((e) => { e.resumos.notificado = hoje; });
    }
    if (cfg.dm?.ativo) {
      try {
        const p = await pendenciasDm({ log });
        atualizarEstado((e) => { e.custo_usd[hoje] = (e.custo_usd[hoje] || 0) + p.custo_usd; });
        const jaDigest = carregarEstado().resumos.digest_dm === hoje;
        if (minutos >= cfg.ritmo.resumo_hora * 60 + cfg.ritmo.resumo_minuto && !jaDigest) {
          const d = await notificarDigestDm({ dryRun: false, log });
          if (d.enviado || d.pendencias === 0 || d.motivo === "destino_dm vazio") atualizarEstado((e) => { e.resumos.digest_dm = hoje; });
        }
      } catch (e) { log(`tick: pendencias DM falhou (${e.message})`); }
    }
    if (agora.getUTCDay() === cfg.resumo.semanal_dia_semana && agora.getUTCHours() >= cfg.resumo.semanal_hora && estado.resumos.semanal !== hoje) {
      const r = await resumirSemana({ domingo: hoje, log });
      atualizarEstado((e) => { e.resumos.semanal = hoje; e.custo_usd[hoje] = (e.custo_usd[hoje] || 0) + r.custo_usd; });
    }
  } finally { liberarLock("resumos"); locksDoTick.delete("resumos"); }
}
