import test from "node:test";
import assert from "node:assert/strict";
import { analisarPendencias, chatsParaAtualizar } from "../src/pendencias.mjs";
import { pendenciasAtualizar } from "../src/run.mjs";
import { CONFIG_PADRAO } from "../src/config.mjs";

const AGORA = Date.parse("2026-10-08T15:00:00Z");
const h = (horasAtras) => new Date(AGORA - horasAtras * 3600e3).toISOString();
const m = (chat, id, fund, horasAtras, texto) => ({ chat_id: chat, id, do_dono: fund, enviada_em: h(horasAtras), tipo: 0, texto, redigida: false, apagada: false });
const cfg = { ...CONFIG_PADRAO, dm: { ...CONFIG_PADRAO.dm, lote_llm: 6 } };

function dbPend({ chats, msgs, abertas = [] }) {
  const log = [];
  return {
    log,
    async exec(sql) { log.push(sql); return "1"; },
    async rows(sql) {
      log.push(sql);
      if (/from wa\.chats where tipo = 'direto'/.test(sql)) return chats;
      if (/row_number\(\)/.test(sql)) return msgs;
      if (/select chat_id, mensagem_id, status from wa\.pendencias_resposta/.test(sql)) return abertas;
      return [];
    },
  };
}
const resp = (n) => async () => ({ custo: 0.01, texto: JSON.stringify({ itens: Array.from({ length: n }, (_, i) => ({ i, pendente: true, pedido: "quer o link", urgencia: "media", tipo_resposta: "enviar link" })) }) });
const registros = (db) => db.log.filter((q) => /registrar_pendencia/.test(q)).length;

test("somente contatos: nao contato (ou null) nao gera pendencia nova", async () => {
  const chats = [{ id: "c1", nome: "Ana", contato: true }, { id: "c2", nome: "Bia", contato: false }, { id: "c3", nome: "Caio", contato: null }];
  const msgs = [m("c1", 1, false, 1, "pode me mandar o link?"), m("c2", 2, false, 1, "pode me mandar o link?"), m("c3", 3, false, 1, "pode me mandar o link?")];
  const db = dbPend({ chats, msgs });
  const r = await analisarPendencias({ db, cfg, custo: { total: 0 }, chamar: resp(1), agoraMs: AGORA, somenteContatos: true });
  assert.equal(r.pendentes, 1);
  assert.equal(r.nao_contato, 2);
  assert.equal(registros(db), 1);
});

test("teto por rodada: so maxLlm conversas vao ao modelo, o resto fica adiado", async () => {
  const chats = ["c1", "c2", "c3"].map((id) => ({ id, nome: id, contato: true }));
  const msgs = chats.map((c, i) => m(c.id, i + 1, false, 1, "pode me mandar o link?"));
  let enviadas = 0;
  const chamar = async (prompt) => { enviadas = (prompt.match(/^### \d+/gm) || []).length; return resp(enviadas)(); };
  const r = await analisarPendencias({ db: dbPend({ chats, msgs }), cfg, custo: { total: 0 }, chamar, agoraMs: AGORA, somenteContatos: true, maxLlm: 2 });
  assert.equal(enviadas, 2);
  assert.equal(r.pendentes, 2);
  assert.equal(r.adiadas, 1);
});

test("fecha pendencia quando o dono respondeu, mesmo de nao contato", async () => {
  const chats = [{ id: "c1", nome: "Ana", contato: false }];
  const msgs = [m("c1", 9, true, 1, "mandei"), m("c1", 8, false, 2, "pode me mandar o link?")];
  const db = dbPend({ chats, msgs, abertas: [{ chat_id: "c1", mensagem_id: 8, status: "aberta" }] });
  const r = await analisarPendencias({ db, cfg, custo: { total: 0 }, chamar: resp(0), agoraMs: AGORA, somenteContatos: true });
  assert.equal(r.fechadas, 1);
  assert.ok(db.log.some((q) => /fechar_pendencias/.test(q)));
});

test("idempotente: pendencia ja registrada para a ultima mensagem nao chama o modelo nem regrava", async () => {
  const chats = [{ id: "c1", nome: "Ana", contato: true }];
  const msgs = [m("c1", 8, false, 2, "pode me mandar o link?")];
  const db = dbPend({ chats, msgs, abertas: [{ chat_id: "c1", mensagem_id: 8, status: "aberta" }] });
  let chamadas = 0;
  const r = await analisarPendencias({ db, cfg, custo: { total: 0 }, chamar: async () => { chamadas++; return resp(1)(); }, agoraMs: AGORA, somenteContatos: true });
  assert.equal(chamadas, 0);
  assert.equal(r.ja_existentes, 1);
  assert.equal(registros(db), 0);
});

test("dry-run: nao grava, nao fecha e nao chama o modelo; conta candidatas", async () => {
  const chats = [{ id: "c1", nome: "Ana", contato: true }, { id: "c2", nome: "Bia", contato: true }, { id: "c3", nome: "Caio", contato: true }];
  const msgs = [m("c1", 1, false, 1, "pode me mandar o link?"), { ...m("c2", 2, false, 1, null), tipo: 3 }, m("c3", 4, true, 1, "mandei"), m("c3", 3, false, 2, "oi?")];
  const db = dbPend({ chats, msgs, abertas: [{ chat_id: "c3", mensagem_id: 3, status: "aberta" }] });
  let chamadas = 0;
  const r = await analisarPendencias({ db, cfg, custo: { total: 0 }, chamar: async () => { chamadas++; return resp(1)(); }, agoraMs: AGORA, somenteContatos: true, dryRun: true });
  assert.equal(chamadas, 0);
  assert.equal(r.candidatas_llm, 1);
  assert.equal(r.audio, 1);
  assert.equal(r.fechadas, 1);
  assert.ok(!db.log.some((q) => /registrar_pendencia|fechar_pendencias/.test(q)));
});

test("chatsParaAtualizar: SQL so de contato salvo com mensagem nova, ou pendencia aberta; nada de agenda", async () => {
  let sql = "";
  const ids = await chatsParaAtualizar({ rows: async (q) => { sql = q; return [{ id: "a" }, { id: "b" }]; } }, { dias: 14 });
  assert.deepEqual(ids, ["a", "b"]);
  assert.match(sql, /c\.contato = true/);
  assert.match(sql, /status = 'aberta'/);
  assert.match(sql, /not m\.do_dono/);
});

test("pendenciasAtualizar: sem candidatas nao consulta mensagens nem modelo", async () => {
  const consultas = [];
  const db = { exec: async () => "", rows: async (q) => { consultas.push(q); return []; } };
  const logs = [];
  const r = await pendenciasAtualizar({ dryRun: false, log: (x) => logs.push(x), deps: { cfg, db, vistas: {}, chamar: async () => { throw new Error("nao deve chamar"); } } });
  assert.equal(r.candidatas, 0);
  assert.equal(r.chats, 0);
  assert.ok(!consultas.some((q) => /row_number/.test(q)));
});

test("plist das pendencias: 15 min, ProcessType, logs no diretorio do worker, sem leitura de agenda", async () => {
  const { gerarPlistPendencias } = await import("../src/launchagent.mjs");
  const x = gerarPlistPendencias({ appDir: "/app", node: "/bin/node" });
  assert.match(x, /<string>pendencias-atualizar<\/string>/);
  assert.match(x, /<key>StartInterval<\/key><integer>900<\/integer>/);
  assert.match(x, /<key>ProcessType<\/key><string>Background<\/string>/);
  const { STATE_DIR } = await import("../src/paths.mjs");
  assert.ok(x.includes(`${STATE_DIR}/pendencias.log`));
  assert.ok(!/ContactsV2/.test(x));
});
