import test from "node:test";
import assert from "node:assert/strict";
import { processarRespostas, sha256, JID_DM } from "../src/respostas.mjs";
import { CONFIG_PADRAO } from "../src/config.mjs";

const TEXTO = "Resposta fictícia do dono.";
const JID = "5500000000000@s.whatsapp.net";
const cfg = { ...CONFIG_PADRAO, respostas: { gateway_aceita_to: true } };
const item = (o = {}) => ({ fila_id: 1, destino_jid: JID, texto: TEXTO, texto_hash: sha256(TEXTO), chat_id: "c", pendencia_id: 2, idempotency_key: "wa-resp:1:abc", ...o });

// db falso: registra tudo o que e executado e devolve a linha reivindicada.
const SEM_LINHA = Symbol("sem linha");
function dbFalso(linha, kill = false) {
  const execs = []; const consultas = [];
  return {
    execs, consultas,
    exec: async (sql) => { execs.push(sql); return ""; },
    rows: async (sql) => {
      consultas.push(sql);
      if (/kill_switch_envio/.test(sql)) return kill === SEM_LINHA ? [] : [{ valor: kill }];
      return /reivindicar_envio_resposta/.test(sql) ? (linha ? [linha] : []) : [];
    },
  };
}
const gw = (chamadas, { conectado = true, stdout = '{"sent":true,"duplicate":false,"messageId":"M1"}', falha = null } = {}) => async (b, a) => {
  chamadas.push(a);
  if (a[0] === "channel") return { stdout: conectado ? "whatsapp: connected" : "whatsapp: disconnected" };
  if (falha) throw Object.assign(new Error("x"), { code: falha });
  return { stdout };
};
const agenda = (...jids) => async () => new Set(jids);
const nunca = async () => { throw new Error("gateway nao deve ser chamado"); };

test("dry-run nao reivindica, nao envia e nao toca no gateway", async () => {
  const db = dbFalso(item());
  const r = await processarRespostas({ db, config: cfg, agenda: agenda(JID), exec: nunca, dryRun: true });
  assert.equal(r.enviado, false);
  assert.ok(db.consultas.every((q) => !/reivindicar/.test(q)));
  assert.deepEqual(db.execs, []);
});

test("sem suporte a --to configurado nada e reivindicado", async () => {
  const db = dbFalso(item());
  const r = await processarRespostas({ db, config: CONFIG_PADRAO, agenda: agenda(JID), exec: nunca, dryRun: false });
  assert.match(r.motivo, /--to/);
  assert.equal(db.consultas.length, 0);
});

test("gateway desconectado: nao reivindica", async () => {
  const db = dbFalso(item()); const ch = [];
  const r = await processarRespostas({ db, config: cfg, agenda: agenda(JID), exec: gw(ch, { conectado: false }), dryRun: false });
  assert.equal(r.enviado, false);
  assert.ok(db.consultas.every((q) => !/reivindicar/.test(q)));
});

test("fila vazia: so channel status, nenhum send", async () => {
  const db = dbFalso(null); const ch = [];
  const r = await processarRespostas({ db, config: cfg, agenda: agenda(JID), exec: gw(ch), dryRun: false });
  assert.equal(r.enviado, false);
  assert.deepEqual(ch.map((a) => a[0]), ["channel"]);
});

test("envio ok: send --to com a chave de idempotencia, conclui no banco, sem texto no retorno", async () => {
  const db = dbFalso(item()); const ch = [];
  const r = await processarRespostas({ db, config: cfg, agenda: agenda(JID), exec: gw(ch), dryRun: false });
  assert.equal(r.enviado, true);
  const send = ch.find((a) => a[0] === "send");
  assert.deepEqual([send[0], send[1], send[2]], ["send", "--to", JID]);
  assert.equal(send[send.indexOf("--idempotency-key") + 1], "wa-resp:1:abc");
  assert.ok(!send.includes("--group"));
  assert.match(db.execs[0], /concluir_envio_resposta\(1, true/);
  assert.ok(!JSON.stringify(r).includes("fictícia"));
  assert.ok(!db.execs.join().includes("fictícia"));
});

test("gateway so usa channel status e send (nada de ler mensagens ou grupos)", async () => {
  const db = dbFalso(item()); const ch = [];
  await processarRespostas({ db, config: cfg, agenda: agenda(JID), exec: gw(ch), dryRun: false });
  assert.deepEqual([...new Set(ch.map((a) => a[0]))].sort(), ["channel", "send"]);
});

test("hash divergente: nao envia, marca falha", async () => {
  const db = dbFalso(item({ texto: TEXTO + " alterado" })); const ch = [];
  const r = await processarRespostas({ db, config: cfg, agenda: agenda(JID), exec: gw(ch), dryRun: false });
  assert.equal(r.motivo, "hash_divergente");
  assert.ok(!ch.some((a) => a[0] === "send"));
  assert.match(db.execs[0], /false.*hash_divergente/s);
});

test("destino fora da agenda local ou jid de grupo: nao envia", async () => {
  for (const [linha, salvos, esperado] of [
    [item(), agenda("outro@s.whatsapp.net"), "fora_da_agenda_local"],
    [item({ destino_jid: "123-456@g.us" }), agenda("123-456@g.us"), "destino_invalido"],
  ]) {
    const db = dbFalso(linha); const ch = [];
    const r = await processarRespostas({ db, config: cfg, agenda: salvos, exec: gw(ch), dryRun: false });
    assert.equal(r.motivo, esperado);
    assert.ok(!ch.some((a) => a[0] === "send"));
  }
  assert.ok(JID_DM.test(JID) && JID_DM.test("123@lid") && !JID_DM.test("x@g.us"));
});

test("agenda local indisponivel: falha fechada ANTES do claim (nada fica 'enviando')", async () => {
  const db = dbFalso(item()); const ch = [];
  const r = await processarRespostas({ db, config: cfg, agenda: async () => { throw new Error("vazia"); }, exec: gw(ch), dryRun: false });
  assert.equal(r.motivo, "agenda_local_indisponivel");
  assert.ok(db.consultas.every((q) => !/reivindicar/.test(q)));
  assert.ok(!ch.some((a) => a[0] === "send"));
});

test("agenda travada (nunca responde): estoura o timeout, nao reivindica e nao envia", async () => {
  const db = dbFalso(item()); const ch = [];
  const r = await processarRespostas({ db, config: cfg, agenda: () => new Promise(() => {}), exec: gw(ch), dryRun: false, timeoutAgendaMs: 50 });
  assert.equal(r.motivo, "agenda_local_indisponivel");
  assert.ok(db.consultas.every((q) => !/reivindicar/.test(q)));
  assert.ok(!ch.some((a) => a[0] === "send"));
});

test("linhas 'enviando' orfas ha mais de 5 min vao para falhou/interrompido_verificar pelo RPC oficial", async () => {
  const db = dbFalso(null);
  const rows = db.rows;
  db.rows = async (sql) => (/status = 'enviando'/.test(sql) ? [{ id: 383 }] : rows(sql));
  await processarRespostas({ db, config: cfg, agenda: agenda(JID), exec: gw([]), dryRun: false });
  const c = db.execs.find((q) => /concluir_envio_resposta\(383, false/.test(q));
  assert.ok(c && /interrompido_verificar/.test(c));
});

test("erro do gateway (timeout, exit != 0) depois do send: interrompido_verificar, sem retentar", async () => {
  for (const falha of ["ETIMEDOUT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", 1]) {
    const db = dbFalso(item()); const ch = [];
    const r = await processarRespostas({ db, config: cfg, agenda: agenda(JID), exec: gw(ch, { falha }), dryRun: false });
    assert.equal(r.motivo, "interrompido_verificar");
    assert.equal(ch.filter((a) => a[0] === "send").length, 1);
    assert.match(db.execs[0], /false.*interrompido_verificar/s);
  }
});

test("gateway recusou antes de enviar (RECUSADO:): erro claro e reaprovavel, nao interrompido_verificar", async () => {
  for (const stderr of ["RECUSADO: Envio por --to desligado neste gateway.\n", "RECUSADO: Destino --to deve ser um JID de contato individual."]) {
    const db = dbFalso(item()); const ch = [];
    const exec = async (b, a) => { ch.push(a); if (a[0] === "channel") return { stdout: "whatsapp: connected" }; throw Object.assign(new Error("Command failed"), { code: 1, stderr }); };
    const r = await processarRespostas({ db, config: cfg, agenda: agenda(JID), exec, dryRun: false });
    assert.match(r.motivo, /^gateway_recusou: /);
    assert.match(db.execs[0], /false.*gateway_recusou/s);
    assert.ok(!db.execs[0].includes("interrompido_verificar"));
    assert.equal(ch.filter((a) => a[0] === "send").length, 1);
  }
});

test("exit != 0 sem marca RECUSADO (pendente, 502, daemon caiu) segue interrompido_verificar", async () => {
  for (const stderr of ["Envio incerto: a chave ficou pendente. Verificar no WhatsApp.", "Daemon indisponível: x", "", "xRECUSADO: no meio"]) {
    const db = dbFalso(item());
    const exec = async (b, a) => { if (a[0] === "channel") return { stdout: "whatsapp: connected" }; throw Object.assign(new Error("Command failed"), { code: 1, stderr }); };
    const r = await processarRespostas({ db, config: cfg, agenda: agenda(JID), exec, dryRun: false });
    assert.equal(r.motivo, "interrompido_verificar");
  }
});

test("duplicado no ledger do gateway conta como enviado (idempotencia)", async () => {
  const db = dbFalso(item()); const ch = [];
  const r = await processarRespostas({ db, config: cfg, agenda: agenda(JID), exec: gw(ch, { stdout: '{"sent":false,"duplicate":true,"messageId":"M1"}' }), dryRun: false });
  assert.equal(r.enviado, true);
  assert.equal(r.duplicado, true);
});

test("resposta do gateway fora do padrao: falha, nao conclui como enviado", async () => {
  const db = dbFalso(item()); const ch = [];
  const r = await processarRespostas({ db, config: cfg, agenda: agenda(JID), exec: gw(ch, { stdout: "ok" }), dryRun: false });
  assert.equal(r.motivo, "interrompido_verificar");
  assert.match(db.execs[0], /false.*interrompido_verificar/s);
});

test("enviou mas o banco falhou ao registrar: nao marca falha nem reenvia", async () => {
  const db = dbFalso(item()); const ch = [];
  db.exec = async () => { throw new Error("banco fora"); };
  await assert.rejects(processarRespostas({ db, config: cfg, agenda: agenda(JID), exec: gw(ch), dryRun: false }), /envio feito/);
  assert.equal(ch.filter((a) => a[0] === "send").length, 1);
});

test("falhas antes do envio continuam reaprovaveis (codigo proprio, nao interrompido_verificar)", async () => {
  for (const [linha, salvos, esperado] of [
    [item({ texto: TEXTO + "x" }), agenda(JID), "hash_divergente"],
    [item(), agenda("outro@s.whatsapp.net"), "fora_da_agenda_local"],
  ]) {
    const db = dbFalso(linha);
    const r = await processarRespostas({ db, config: cfg, agenda: salvos, exec: gw([]), dryRun: false });
    assert.equal(r.motivo, esperado);
    assert.ok(!db.execs[0].includes("interrompido_verificar"));
  }
});

test("kill switch recheck antes do send: so false libera (fail-closed)", async () => {
  for (const [kill, esperado] of [[true, "kill_switch_ligado"], ["true", "kill_switch_ligado"], ["false", "kill_switch_ligado"], [null, "kill_switch_ligado"], [0, "kill_switch_ligado"], [SEM_LINHA, "kill_switch_ligado"]]) {
    const db = dbFalso(item(), kill); const ch = [];
    const r = await processarRespostas({ db, config: cfg, agenda: agenda(JID), exec: gw(ch), dryRun: false });
    assert.equal(r.motivo, esperado);
    assert.ok(!ch.some((a) => a[0] === "send"));
    assert.match(db.execs[0], /false.*kill_switch_ligado/s);
  }
});

test("kill switch ilegivel: nao envia", async () => {
  const db = dbFalso(item()); const ch = [];
  const rows = db.rows;
  db.rows = async (sql) => { if (/kill_switch_envio/.test(sql)) throw new Error("x"); return rows(sql); };
  const r = await processarRespostas({ db, config: cfg, agenda: agenda(JID), exec: gw(ch), dryRun: false });
  assert.equal(r.motivo, "kill_switch_indisponivel");
  assert.ok(!ch.some((a) => a[0] === "send"));
});

test("hash no retorno tem 8 hex", async () => {
  const db = dbFalso(item()); const ch = [];
  const r = await processarRespostas({ db, config: cfg, agenda: agenda(JID), exec: gw(ch), dryRun: false });
  assert.equal(r.hash.length, 8);
});

test("lock do consumidor: pid morto ou lock vencido se recupera sozinho; pid vivo e recente bloqueia", async () => {
  const fs = await import("node:fs"); const path = await import("node:path");
  const { STATE_DIR } = await import("../src/paths.mjs");
  const { adquirirLock, liberarLock } = await import("../src/state.mjs");
  const f = path.join(STATE_DIR, "teste-lock.lock");
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(f, "999999 2026-01-01T00:00:00Z\n");
  assert.equal(adquirirLock("teste-lock", 180000), true);   // pid morto
  assert.equal(adquirirLock("teste-lock", 180000), false);  // pid vivo (este), recente
  const velho = new Date(Date.now() - 600000); fs.utimesSync(f, velho, velho);
  assert.equal(adquirirLock("teste-lock", 180000), true);   // vivo mas vencido
  liberarLock("teste-lock");
});

test("contatos vem de wa.chats.contato (sem abrir a agenda): so jids marcados; vazio falha fechado", async () => {
  const { jidsContatosDoBanco } = await import("../src/respostas.mjs");
  const consultas = [];
  const dbOk = { rows: async (sql) => { consultas.push(sql); return [{ jid: JID }]; } };
  const set = await jidsContatosDoBanco(dbOk);
  assert.ok(set.has(JID));
  assert.match(consultas[0], /wa\.chats/);
  assert.match(consultas[0], /contato = true/);
  await assert.rejects(jidsContatosDoBanco({ rows: async () => [] }), /nenhum contato/);
  // integrado: jid fora do conjunto nao envia; vazio vira agenda_local_indisponivel antes do claim
  const ch = [];
  const db = dbFalso(item());
  const r = await processarRespostas({ db, config: cfg, agenda: () => jidsContatosDoBanco({ rows: async () => [] }), exec: gw(ch), dryRun: false });
  assert.equal(r.motivo, "agenda_local_indisponivel");
  assert.ok(!db.consultas.some((q) => /reivindicar_envio_resposta/.test(q)));
});
