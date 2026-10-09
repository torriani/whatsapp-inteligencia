import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolverDms, carregarExclusoes, excluida, criarArquivoExclusao, EXCLUSAO_MODELO } from "../src/dm.mjs";
import { APPLE_EPOCH } from "../src/reader.mjs";
import { ingerir } from "../src/run.mjs";
import { CONFIG_PADRAO } from "../src/config.mjs";

const AGORA = Date.parse("2026-10-07T15:00:00Z");
const apple = (diasAtras) => AGORA / 1000 - APPLE_EPOCH - diasAtras * 86400;
const dmSess = (pk, nome, diasAtras, jid = `55119999900${pk}@s.whatsapp.net`) => ({ pk, jid, nome, tipo: 0, removido: false, ultima: apple(diasAtras) });
const SEGREDO = "SEGREDO-FICTICIO-DM-777";

test("DMs: so tipo 0 com jid de pessoa, atividade em 30 dias, sem excluidos", () => {
  const sess = [
    dmSess(1, "Ana Teste", 2), dmSess(2, "Bia Antiga", 45), dmSess(3, "Caio Excluido", 1), dmSess(4, "Dora Tel", 1, "5511988887777@s.whatsapp.net"),
    dmSess(5, "Edu Lid", 3, "123456789@lid"), dmSess(6, "", 1),
    { pk: 7, jid: "7@g.us", nome: "Grupo Alfa", tipo: 1, removido: false, ultima: apple(1) },
    { pk: 8, jid: "status@broadcast", nome: "Status", tipo: 3, removido: false, ultima: apple(1) },
    { ...dmSess(9, "Removido", 1), removido: true },
  ];
  const excl = { excluir: [{ nome: "caio excluído" }, { nome: "Caio Excluido" }, { telefone: "+55 (11) 98888-7777" }] };
  const r = resolverDms(sess, excl, { agoraMs: AGORA, dias: 30 });
  assert.deepEqual(r.map((c) => c.pk), [1, 5, 6]);
  assert.ok(r.every((c) => c.tipoChat === "direto" && c.modo === "registrar" && c.direct && c.backfill_dias === 30));
  assert.match(r.find((c) => c.pk === 6).nome, /^Contato \d{4}$/);
  // conversa ja conhecida segue mesmo sem atividade recente
  const r2 = resolverDms(sess, excl, { agoraMs: AGORA, dias: 30, conhecidos: new Set([sess[1].jid]) });
  assert.ok(r2.some((c) => c.pk === 2));
  assert.equal(excluida(sess[3], excl), true);
});

test("lista de exclusao: ausente falha fechada, 644 recusada, modelo vazio", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wai-dm-"));
  const f = path.join(dir, "excluir.json");
  assert.throws(() => carregarExclusoes(f), /ausente/);
  assert.equal(criarArquivoExclusao(f), true);
  assert.deepEqual(carregarExclusoes(f).excluir, EXCLUSAO_MODELO.excluir);
  fs.chmodSync(f, 0o644);
  assert.throws(() => carregarExclusoes(f), /Permissao insegura/);
  fs.chmodSync(f, 0o600); fs.unlinkSync(f); fs.rmdirSync(dir);
});

// ---- ingestao de DMs com leitor e banco falsos ----
function dbFalso() {
  const log = [];
  return {
    log,
    async exec(sql) { log.push(sql); return "1"; },
    async rows(sql) { log.push(sql); return []; },
  };
}
const linha = (o) => ({ pk: 100, fromMe: 0, data: 780000000, stanza: "S", texto: "oi", tipo: 0, evento: 2, midia: null, pai: null, push: "Ana", autor: "Ana", autorJid: null, paiStanza: null, titulo: null, ...o });
function leitorFalso(sessoes, porChat) {
  const lidos = [];
  return { lidos, async schemaGuard() { return true; }, async sessoes() { return sessoes; }, async maxPk() { return 0; }, async mensagens(pk) { lidos.push(pk); return porChat[pk] || []; } };
}
const deps = (extra) => ({ cfg: { ...CONFIG_PADRAO, dm: { ...CONFIG_PADRAO.dm, ativo: true } }, ctx: { termosRegex: null, termosEmTodas: false }, estado: { chats: {} }, salvarEstado() {}, allow: { allow: [] }, exclusoes: { excluir: [{ nome: "Contato Fora" }] }, ...extra });

test("ingestao de DM: filtro sensivel total, excluido nunca lido, sem links, sem perguntas, sem nome no log", async () => {
  const hoje = Date.now() / 1000 - APPLE_EPOCH;
  const sess = [
    { pk: 1, jid: "5511999990001@s.whatsapp.net", nome: "Contato Dentro", tipo: 0, removido: false, ultima: hoje },
    { pk: 2, jid: "5511999990002@s.whatsapp.net", nome: "Contato Fora", tipo: 0, removido: false, ultima: hoje },
  ];
  const leitor = leitorFalso(sess, {
    1: [linha({ texto: `preciso pagar a dívida ${SEGREDO}` }), linha({ pk: 101, stanza: "S2", texto: "veja https://exemplo.com/x ok? me responde" })],
    2: [linha({ texto: `fora ${SEGREDO}` })],
  });
  const db = dbFalso();
  const linhasLog = [];
  const r = await ingerir({ log: (l) => linhasLog.push(l), deps: deps({ leitor, db }) });
  assert.deepEqual(leitor.lidos, [1]);
  const sql = db.log.join("\n");
  assert.ok(!sql.includes(SEGREDO));
  assert.ok(sql.includes("'direto'") || /\$q[0-9a-f]+\$direto\$q/.test(sql));
  assert.ok(!sql.includes("wa.registrar_link"));
  assert.ok(!sql.includes("insert into wa.perguntas"));
  const lote = db.log.find((q) => q.includes("wa.upsert_mensagens"));
  const blocos = [...lote.matchAll(/\$(q[0-9a-f]+)\$(.*?)\$\1\$/gs)].map((m) => m[2]);
  const json = JSON.parse(blocos.find((b) => b.startsWith("[")));
  assert.equal(json.length, 2);
  assert.equal(json[0].redigida, true);
  assert.equal(json[0].texto, null);
  assert.equal(json[1].redigida, false);
  assert.ok(!linhasLog.join("\n").includes("Contato Dentro") && !linhasLog.join("\n").includes("Contato Fora"));
  assert.ok(linhasLog.some((l) => l.startsWith("ingestao DMs: conversas=1")));
  assert.equal(r.grupos[0].dm, true);
});

test("DMs desligadas na config: nada de DM e lido", async () => {
  const hoje = Date.now() / 1000 - APPLE_EPOCH;
  const leitor = leitorFalso([{ pk: 1, jid: "5511999990001@s.whatsapp.net", nome: "Contato Dentro", tipo: 0, removido: false, ultima: hoje }], { 1: [linha({})] });
  const db = dbFalso();
  await ingerir({ log() {}, deps: deps({ leitor, db, cfg: { ...CONFIG_PADRAO, dm: { ...CONFIG_PADRAO.dm, ativo: false } } }) });
  assert.deepEqual(leitor.lidos, []);
  assert.equal(db.log.length, 0);
});
