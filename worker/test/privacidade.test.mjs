// Pontos que decidem privacidade, com dados ficticios e banco/leitor falsos.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { criarLeitor } from "../src/reader.mjs";
import { criarDb } from "../src/db.mjs";
import { ingerir, notificarResumos } from "../src/run.mjs";
import { sincronizarChats } from "../src/ingest.mjs";
import { parseJsonSeguro, JsonInvalidoError } from "../src/safejson.mjs";
import { CONFIG_PADRAO } from "../src/config.mjs";
import { ESPERADO } from "../src/schema-guard.mjs";

const SEGREDO = "SEGREDO-FICTICIO-12345";

// ---------- reader ----------
function bancoFicticio() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wai-db-"));
  const file = path.join(dir, "ChatStorage.sqlite");
  const ddl = Object.entries(ESPERADO).map(([t, cols]) => `create table ${t} (${cols.map((c) => (c === "Z_PK" ? "Z_PK integer primary key" : c)).join(", ")});`).join("\n");
  execFileSync("sqlite3", [file, `${ddl}
    insert into ZWACHATSESSION (Z_PK, ZCONTACTJID, ZPARTNERNAME, ZSESSIONTYPE, ZREMOVED) values (1, '1@g.us', 'Grupo Teste', 1, 0);
    insert into ZWAMESSAGE (Z_PK, ZCHATSESSION, ZMESSAGEDATE, ZTEXT, ZMESSAGETYPE) values (10, 1, 780000000, 'oi', 0);`]);
  return { dir, file };
}
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const limpar = ({ dir, file }) => { fs.unlinkSync(file); fs.rmdirSync(dir); };

test("leitor: schema guard passa e a leitura nao consegue escrever no banco", async () => {
  const b = bancoFicticio();
  const antes = sha(b.file);
  const leitor = criarLeitor(b.file);
  assert.equal(await leitor.schemaGuard(), true);
  assert.equal((await leitor.mensagens(1)).length, 1);
  await assert.rejects(() => leitor.sql("insert into ZWAMESSAGE (Z_PK, ZCHATSESSION) values (11, 1)"));
  await assert.rejects(() => leitor.sql("delete from ZWAMESSAGE"));
  assert.equal(sha(b.file), antes);
  assert.equal(execFileSync("sqlite3", [b.file, "select count(*) from ZWAMESSAGE"]).toString().trim(), "1");
  limpar(b);
});

test("leitor: todo comando usa -readonly, mode=ro e so SQL de leitura", async () => {
  const chamadas = [];
  const exec = async (bin, args) => {
    chamadas.push({ bin, args });
    const t = /pragma_table_info\('(\w+)'\)/.exec(args.at(-1))?.[1];
    return { stdout: JSON.stringify(t ? ESPERADO[t].map((name) => ({ name })) : /max\(Z_PK\)/.test(args.at(-1)) ? [{ m: 0 }] : []) };
  };
  const leitor = criarLeitor("/tmp/x y/ChatStorage.sqlite", { exec });
  await leitor.schemaGuard(); await leitor.sessoes(); await leitor.maxPk(1); await leitor.mensagens(1, { desdeApple: 5 }); await leitor.mensagensApos(1, 0);
  assert.ok(chamadas.length > 5);
  for (const c of chamadas) {
    assert.equal(c.bin, "sqlite3");
    assert.ok(c.args.includes("-readonly"));
    assert.match(c.args.find((a) => a.startsWith("file:")), /\?mode=ro$/);
    assert.match(c.args.at(-1).trim(), /^(select|pragma)\b/i);
    assert.doesNotMatch(c.args.at(-1), /\b(insert|update|delete|drop|alter|create|replace|attach|vacuum)\b/i);
  }
});

test("leitor: parametro nao numerico e recusado (sem injecao)", async () => {
  const leitor = criarLeitor("/tmp/x.sqlite", { exec: async () => ({ stdout: "[]" }) });
  await assert.rejects(() => leitor.maxPk("1; drop table x"), /invalido/);
});

// ---------- db ----------
function spawnFalso({ stdout = "", stderr = "", code = 0, capturar }) {
  return (bin, args, opts) => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
    p.stdin = { end(sql) { capturar?.({ bin, args, opts, sql }); setImmediate(() => { if (stdout) p.stdout.emit("data", stdout); if (stderr) p.stderr.emit("data", stderr); p.emit("close", code); }); } };
    return p;
  };
}

test("db: erro devolve so o SQLSTATE, sem trecho da consulta nem segredo", async () => {
  const stderr = `ERROR:  22P02\nLINE 1: select ${SEGREDO}\nDETAIL: valor ${SEGREDO}`;
  const db = criarDb({ ref: "abc", host: "fixture.invalid" }, { spawn: spawnFalso({ stderr, code: 3 }), senha: "senha-ficticia-db", bin: "/fake/psql" });
  await assert.rejects(() => db.exec("select 1"), (e) => /22P02/.test(e.message) && !e.message.includes(SEGREDO) && !e.message.includes("senha-ficticia-db"));
});

test("db: senha so no ambiente do processo, nunca nos argumentos; JSON ruim nao vaza", async () => {
  let visto;
  const ok = criarDb({ ref: "abc", host: "fixture.invalid" }, { spawn: spawnFalso({ stdout: "[]", capturar: (c) => (visto = c) }), senha: "senha-ficticia-db", bin: "/fake/psql" });
  assert.deepEqual(await ok.rows("select 1"), []);
  assert.ok(!visto.args.join(" ").includes("senha-ficticia-db"));
  assert.equal(visto.opts.env.PGPASSWORD, "senha-ficticia-db");
  assert.ok(visto.args.includes("VERBOSITY=sqlstate"));
  const ruim = criarDb({ ref: "abc", host: "fixture.invalid" }, { spawn: spawnFalso({ stdout: `{"texto": "${SEGREDO}" oops` }), senha: "x", bin: "/fake/psql" });
  await assert.rejects(() => ruim.rows("select 1"), (e) => e instanceof JsonInvalidoError && !e.message.includes(SEGREDO) && /tamanho \d+/.test(e.message));
});

test("safejson: so tipo, posicao e tamanho", () => {
  assert.throws(() => parseJsonSeguro(`{"a": "${SEGREDO}",}`, "teste"), (e) => !e.message.includes(SEGREDO) && /SyntaxError/.test(e.message) && /tamanho 3\d/.test(e.message));
  assert.deepEqual(parseJsonSeguro("[1]"), [1]);
});

// ---------- ingestao ----------
function dbFalso({ modo = "registrar", existia = true } = {}) {
  const log = [];
  return {
    log,
    async exec(sql) { log.push(sql); return "1"; },
    async rows(sql) {
      log.push(sql);
      if (/from wa\.chats where jid = any/.test(sql)) return existia ? [{ id: "00000000-0000-0000-0000-000000000001", jid: "1@g.us", modo, nome: "Grupo Alfa" }] : [];
      if (/select local_pk, id from wa\.mensagens/.test(sql)) return [{ local_pk: 100, id: 1 }];
      return [];
    },
  };
}
const sessoes = [
  { pk: 1, jid: "1@g.us", nome: "Grupo Alfa", tipo: 1, removido: false },
  { pk: 2, jid: "2@g.us", nome: "Grupo Fora Da Lista", tipo: 1, removido: false },
  { pk: 3, jid: "5511999999999@s.whatsapp.net", nome: "Grupo Alfa", tipo: 0, removido: false },
];
const linha = (o) => ({ pk: 100, fromMe: 0, data: 780000000, stanza: "S", texto: "oi", tipo: 0, evento: 2, midia: null, pai: null, push: "Ana", autor: "Ana", autorJid: "1@s", paiStanza: null, titulo: null, ...o });
function leitorFalso(porChat) {
  const lidos = [];
  return {
    lidos,
    async schemaGuard() { return true; },
    async sessoes() { return sessoes; },
    async maxPk() { return 0; },
    async mensagens(pk) { lidos.push(pk); return porChat[pk] || []; },
  };
}
const ALLOW = { tipos_sessao_permitidos: [1], allow: [{ nome: "Grupo Alfa", match: "exato", modo: "registrar" }], deny_always: [] };
const depsBase = (extra) => ({ cfg: { ...CONFIG_PADRAO }, ctx: { termosRegex: null, termosEmTodas: false }, estado: { chats: {} }, salvarEstado() {}, allow: ALLOW, ...extra });

test("ingestao: chat fora da allowlist e DM nunca sao lidos nem gravados", async () => {
  const leitor = leitorFalso({ 1: [linha({ texto: "mensagem normal" })], 2: [linha({ texto: `fora ${SEGREDO}` })], 3: [linha({ texto: `dm ${SEGREDO}` })] });
  const db = dbFalso();
  const r = await ingerir({ log() {}, deps: depsBase({ leitor, db }) });
  assert.deepEqual(leitor.lidos, [1]);
  const sql = db.log.join("\n");
  assert.ok(!sql.includes(SEGREDO));
  assert.ok(!sql.includes("2@g.us") && !sql.includes("5511999999999") && !sql.includes("Fora Da Lista"));
  assert.equal(r.grupos.length, 1);
});

test("ingestao: mensagem redigida nunca grava texto", async () => {
  const leitor = leitorFalso({ 1: [linha({ texto: `a senha é ${SEGREDO}x9` }), linha({ pk: 101, stanza: "S2", texto: `token ghp_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6"} ${SEGREDO}` })] });
  const db = dbFalso();
  await ingerir({ log() {}, deps: depsBase({ leitor, db }) });
  const sql = db.log.join("\n");
  assert.ok(!sql.includes(SEGREDO));
  const lote = db.log.find((q) => q.includes("wa.upsert_mensagens"));
  assert.ok(lote);
  const blocos = [...lote.matchAll(/\$(q[0-9a-f]+)\$(.*?)\$\1\$/gs)].map((m) => m[2]);
  const json = JSON.parse(blocos.find((b) => b.startsWith("[")));
  assert.equal(json.length, 2);
  assert.ok(json.every((m) => m.redigida === true && m.texto === null));
});

test("ingestao: chat com modo off no banco nao e lido", async () => {
  const leitor = leitorFalso({ 1: [linha({})] });
  const db = dbFalso({ modo: "off" });
  const r = await ingerir({ log() {}, deps: depsBase({ leitor, db }) });
  assert.deepEqual(leitor.lidos, []);
  assert.ok(!db.log.some((q) => q.includes("wa.upsert_mensagens")));
  assert.equal(r.grupos[0].ignorado, "modo off no banco");
});

test("ingestao: allowlist vazia falha fechada, sem tocar no banco", async () => {
  const leitor = leitorFalso({ 1: [linha({})] });
  const db = dbFalso();
  await ingerir({ log() {}, deps: depsBase({ leitor, db, allow: { allow: [] } }) });
  assert.deepEqual(leitor.lidos, []);
  assert.equal(db.log.length, 0);
});

test("ingestao: eventos de sistema nao sao gravados", async () => {
  const leitor = leitorFalso({ 1: [linha({ tipo: 6, texto: null }), linha({ pk: 101, stanza: "S2" })] });
  const db = dbFalso();
  const r = await ingerir({ log() {}, deps: depsBase({ leitor, db }) });
  assert.equal(r.grupos[0].eventos, 1);
  assert.equal(r.grupos[0].gravadas, 1);
});

test("chat novo registra a origem allowlist-local na auditoria; existente nao", async () => {
  const chat = { jid: "1@g.us", nome: "Grupo Alfa", modo: "registrar" };
  const novo = dbFalso({ existia: false });
  await sincronizarChats(novo, [chat]);
  assert.ok(novo.log.some((q) => q.includes("wa.auditoria") && q.includes("allowlist-local") && q.includes("libera_chat_allowlist_local")));
  const velho = dbFalso({ existia: true });
  await sincronizarChats(velho, [chat]);
  assert.ok(!velho.log.some((q) => q.includes("wa.auditoria")));
});

// ---------- notificacao ----------
test("notificarResumos em dry-run registra resumo_nao_enviado e nunca chama o gateway", async () => {
  const log = [];
  const db = {
    async rows(sql) {
      log.push(sql);
      if (/from wa\.resumos r join wa\.chats/.test(sql)) return [{ id: 42, nome: "Grupo Alfa", discutido: [{ texto: "tema" }], decidido: [], olhar: [] }];
      return [];
    },
    async exec(sql) { log.push(sql); return ""; },
  };
  const r = await notificarResumos({ dia: "2026-10-06", dryRun: true, log() {}, deps: { cfg: { ...CONFIG_PADRAO }, db, exec: () => { throw new Error("gateway nao deve ser chamado"); } } });
  assert.equal(r.enviado, false);
  const ins = log.find((q) => q.includes("insert into wa.auditoria"));
  assert.match(ins, /resumo_nao_enviado/);
  assert.match(ins, /'42'|\$q[0-9a-f]+\$42\$q/);
});
