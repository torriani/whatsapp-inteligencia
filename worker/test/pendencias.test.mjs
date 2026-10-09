import test from "node:test";
import assert from "node:assert/strict";
import { classificarThread, saudacaoIsolada, analisarPendencias } from "../src/pendencias.mjs";
import { notificarResumos, notificarDigestDm } from "../src/run.mjs";
import { CONFIG_PADRAO as BASE_CONFIG } from "../src/config.mjs";

const CONFIG_PADRAO = { ...BASE_CONFIG, notificacao: { ...BASE_CONFIG.notificacao, grupo: "Grupo Teste" } };
import { temTravessao } from "../src/textguard.mjs";

const AGORA = Date.parse("2026-10-07T15:00:00Z");
const h = (horasAtras) => new Date(AGORA - horasAtras * 3600e3).toISOString();
const m = (id, fund, horasAtras, texto, extra = {}) => ({ chat_id: "c1", id, do_dono: fund, enviada_em: h(horasAtras), tipo: 0, texto, redigida: false, apagada: false, ...extra });

test("thread: ultima util do dono nao e pendencia", () => {
  assert.equal(classificarThread([m(3, true, 1, "ok"), m(2, false, 2, "pode me mandar o link?")], { agoraMs: AGORA }).estado, "dono");
});

test("thread: pergunta do contato pendente; espera conta desde o inicio da sequencia sem resposta", () => {
  const c = classificarThread([m(5, false, 1, "pode me mandar o link?"), m(4, false, 3, "bom dia"), m(3, true, 30, "fechado")], { agoraMs: AGORA });
  assert.equal(c.estado, "pendente");
  assert.equal(c.ultimaId, 5);
  assert.equal(c.esperaDesde, h(3));
});

test("thread: figurinha, midia sem texto e apagada sao ignoradas; audio sem texto marca audio", () => {
  const s = classificarThread([m(4, false, 1, null, { tipo: 15 }), m(3, false, 2, null, { tipo: 1 }), m(2, false, 3, "preciso do contrato hoje", {}), m(1, true, 10, "ok")], { agoraMs: AGORA });
  assert.equal(s.estado, "pendente");
  assert.equal(s.ultimaId, 2);
  const a = classificarThread([m(2, false, 1, null, { tipo: 3 }), m(1, true, 10, "ok")], { agoraMs: AGORA });
  assert.equal(a.estado, "audio");
  const ap = classificarThread([m(2, false, 1, "texto apagado", { apagada: true }), m(1, true, 10, "ok")], { agoraMs: AGORA });
  assert.equal(ap.estado, "dono");
});

test("thread: saudacao isolada, mais de 14 dias, sensivel e vazio", () => {
  assert.equal(classificarThread([m(1, false, 1, "Bom dia!")], { agoraMs: AGORA }).estado, "saudacao");
  assert.equal(classificarThread([m(1, false, 24 * 15, "pode me ligar?")], { agoraMs: AGORA, maxDias: 14 }).estado, "antiga");
  assert.equal(classificarThread([m(1, false, 1, null, { redigida: true })], { agoraMs: AGORA }).estado, "sensivel");
  assert.equal(classificarThread([], { agoraMs: AGORA }).estado, "vazio");
  assert.equal(saudacaoIsolada("Tudo bem?"), true);
  assert.equal(saudacaoIsolada("Tudo bem? Preciso de uma ajuda com o pedido"), false);
});

function dbPend({ chats, msgs, existentes = [] }) {
  const log = [];
  return {
    log,
    async exec(sql) { log.push(sql); return "1"; },
    async rows(sql) {
      log.push(sql);
      if (/from wa\.chats where tipo = 'direto'/.test(sql)) return chats;
      if (/from wa\.mensagens m join wa\.chats c/.test(sql) || /row_number\(\)/.test(sql)) return msgs;
      if (/from wa\.pendencias_resposta/.test(sql)) return existentes;
      return [];
    },
  };
}
const cfg = { ...CONFIG_PADRAO, dm: { ...CONFIG_PADRAO.dm, lote_llm: 2 } };

test("analise: so candidatos vao ao modelo, em lotes; saida limpa; nunca ha texto de resposta", async () => {
  const chats = [{ id: "c1", nome: "Ana Teste" }, { id: "c2", nome: "Bia Teste" }, { id: "c3", nome: "Caio Teste" }, { id: "c4", nome: "Dora Teste" }];
  const msgs = [
    m(10, false, 2, "pode me confirmar o horario?"),
    { ...m(20, false, 5, "preciso da proposta"), chat_id: "c2" },
    { ...m(30, true, 1, "enviado"), chat_id: "c3" },
    { ...m(40, false, 1, null, { tipo: 3 }), chat_id: "c4" },
  ];
  const db = dbPend({ chats, msgs });
  const prompts = [];
  const chamar = async (prompt) => {
    prompts.push(prompt);
    return { custo: 0.02, texto: JSON.stringify({ itens: [
      { i: 0, pendente: true, pedido: "Quer confirmar o horario \u2014 da reuniao \u{1F600}", urgencia: "alta", tipo_resposta: "Confirmar horario" },
      { i: 1, pendente: false },
    ] }) };
  };
  const custo = { total: 0 };
  const r = await analisarPendencias({ db, cfg, custo, chamar, agoraMs: AGORA });
  assert.equal(prompts.length, 1);
  assert.equal(r.analisadas_llm, 2);
  assert.equal(r.pendentes, 1);
  assert.equal(r.audio, 1);
  assert.equal(r.sem_pendencia >= 1, true);
  assert.equal(custo.total, 0.02);
  const regs = db.log.filter((q) => q.includes("wa.registrar_pendencia"));
  assert.equal(regs.length, 2);
  const llm = regs.find((q) => q.includes("Confirmar horario"));
  assert.ok(llm && !temTravessao(llm) && !/\u{1F600}/u.test(llm));
  assert.ok(!db.log.some((q) => /sugestoes_resposta|texto_sugerido|texto_final/.test(q)));
});

test("analise: pendencia existente nao repete e resposta do dono fecha a aberta", async () => {
  const chats = [{ id: "c1", nome: "Ana Teste" }, { id: "c2", nome: "Bia Teste" }];
  const msgs = [m(10, false, 2, "pode me confirmar o horario?"), { ...m(30, true, 1, "respondido"), chat_id: "c2" }];
  const db = dbPend({ chats, msgs, existentes: [{ chat_id: "c1", mensagem_id: 10, status: "aberta" }, { chat_id: "c2", mensagem_id: 25, status: "aberta" }] });
  let chamadas = 0;
  const r = await analisarPendencias({ db, cfg, custo: { total: 0 }, chamar: async () => { chamadas++; return { custo: 0, texto: "{}" }; }, agoraMs: AGORA });
  assert.equal(chamadas, 0);
  assert.equal(r.ja_existentes, 1);
  assert.equal(r.fechadas, 1);
  assert.ok(db.log.some((q) => q.includes("wa.fechar_pendencias") && q.includes("30::bigint")));
});

// ---- envio de resumos e digest ----
const icones = { padrao: "\u{1F4AC}", regras: [{ contem: "alfa", emoji: "\u{1F916}", links: true }] };
function dbEnvio({ resumos = [], pend = [] } = {}) {
  const log = [];
  return {
    log,
    async exec(sql) { log.push(sql); return ""; },
    async rows(sql) {
      log.push(sql);
      if (/from wa\.config/.test(sql)) return [{ valor: false }];
      if (/from wa\.resumos r join wa\.chats/.test(sql)) return resumos;
      if (/from wa\.links/.test(sql)) return [{ url_norm: "https://exemplo.com/a" }];
      if (/from wa\.pendencias_resposta/.test(sql)) return pend;
      return [];
    },
  };
}
const execConectado = (chamadas) => async (bin, args) => { chamadas.push(args); return { stdout: args[0] === "channel" ? "whatsapp: connected" : "{}" }; };
const resumo = (id, nome) => ({ id, chat_id: `c${id}`, nome, discutido: [{ texto: "Tema" }], decidido: [{ texto: "Decisao" }], olhar: [{ texto: "Ver" }] });

test("resumos: uma mensagem por grupo, chave v2 estavel, auditoria resumo_enviado", async () => {
  const chamadas = []; const db = dbEnvio({ resumos: [resumo(1, "Grupo Alfa"), resumo(2, "Time Beta")] });
  const cfgOn = { ...CONFIG_PADRAO, ENVIO_ATIVO: true };
  const r = await notificarResumos({ dia: "2026-10-06", dryRun: false, log() {}, deps: { cfg: cfgOn, db, icones, exec: execConectado(chamadas) } });
  assert.equal(r.enviados, 2);
  const envios = chamadas.filter((a) => a[0] === "send");
  assert.equal(envios.length, 2);
  const chaves = envios.map((a) => a[a.indexOf("--idempotency-key") + 1]);
  assert.equal(new Set(chaves).size, 2);
  assert.ok(chaves.every((c) => c.startsWith("whatsapp-inteligencia:resumo:v2:2026-10-06:")));
  assert.ok(envios.every((a) => a[a.indexOf("--group") + 1] === CONFIG_PADRAO.notificacao.grupo));
  const aud = db.log.filter((q) => q.includes("insert into wa.auditoria"));
  assert.equal(aud.length, 2);
  assert.ok(aud.every((q) => q.includes("resumo_enviado")));
});

test("resumos: trava ENVIO_ATIVO desligada nao envia e audita resumo_nao_enviado", async () => {
  const chamadas = []; const db = dbEnvio({ resumos: [resumo(1, "Grupo Alfa")] });
  const r = await notificarResumos({ dia: "2026-10-06", dryRun: false, log() {}, deps: { cfg: { ...CONFIG_PADRAO, ENVIO_ATIVO: false }, db, icones, exec: execConectado(chamadas) } });
  assert.equal(chamadas.length, 0);
  assert.equal(r.naoEnviados, 1);
  assert.ok(db.log.some((q) => q.includes("insert into wa.auditoria") && q.includes("resumo_nao_enviado")));
});

test("reenvio visual usa chave nova e auditoria propria", async () => {
  const chamadas = []; const db = dbEnvio({ resumos: [resumo(1, "Grupo Alfa")] });
  await notificarResumos({ dia: "2026-10-06", dryRun: false, reenviar: true, sufixo: "visual", log() {}, deps: { cfg: { ...CONFIG_PADRAO, ENVIO_ATIVO: true }, db, icones, exec: execConectado(chamadas) } });
  const send = chamadas.find((a) => a[0] === "send");
  assert.ok(send[send.indexOf("--idempotency-key") + 1].endsWith(":visual"));
  assert.ok(db.log.some((q) => q.includes("resumo_teste_visual")));
  assert.ok(!db.log.some((q) => q.includes("not exists (select 1 from wa.auditoria")));
});

const pend = [{ jid: "5511900000001@s.whatsapp.net", contato: true, contato_nome: "Ana Teste", espera_desde: h(5), pedido: "Quer o link", urgencia: "alta", tipo_resposta: "Enviar link", audio_sem_transcricao: false }];

test("digest de DM: destino_dm vazio nunca envia, audita com o motivo", async () => {
  const chamadas = []; const db = dbEnvio({ pend });
  const r = await notificarDigestDm({ dia: "2026-10-07", dryRun: false, log() {}, deps: { cfg: { ...CONFIG_PADRAO, ENVIO_ATIVO: true }, db, exec: execConectado(chamadas) } });
  assert.equal(chamadas.length, 0);
  assert.equal(r.enviado, false);
  const aud = db.log.find((q) => q.includes("insert into wa.auditoria"));
  assert.ok(aud.includes("resumo_nao_enviado") && aud.includes("destino_dm vazio") && aud.includes("digest-dm:2026-10-07"));
});

test("digest de DM: com destino_dm envia so para ele, nunca para o grupo de notificacoes", async () => {
  const chamadas = []; const db = dbEnvio({ pend });
  const cfgDm = { ...CONFIG_PADRAO, ENVIO_ATIVO: true, notificacao: { ...CONFIG_PADRAO.notificacao, destino_dm: "Grupo Privado Ficticio" } };
  const r = await notificarDigestDm({ dia: "2026-10-07", dryRun: false, log() {}, deps: { cfg: cfgDm, db, exec: execConectado(chamadas) } });
  assert.equal(r.enviado, true);
  const envios = chamadas.filter((a) => a[0] === "send");
  assert.equal(envios.length, 1);
  assert.equal(envios[0][envios[0].indexOf("--group") + 1], "Grupo Privado Ficticio");
  assert.ok(!chamadas.some((a) => a.includes(CONFIG_PADRAO.notificacao.grupo)));
});

test("analise: conversa ja analisada sem pendencia nao volta ao modelo", async () => {
  const chats = [{ id: "c1", nome: "Ana Teste" }];
  const msgs = [m(10, false, 2, "pode me confirmar o horario?")];
  const vistas = {};
  let chamadas = 0;
  const chamar = async () => { chamadas++; return { custo: 0.01, texto: JSON.stringify({ itens: [{ i: 0, pendente: false }] }) }; };
  await analisarPendencias({ db: dbPend({ chats, msgs }), cfg, custo: { total: 0 }, chamar, agoraMs: AGORA, vistas });
  const r2 = await analisarPendencias({ db: dbPend({ chats, msgs }), cfg, custo: { total: 0 }, chamar, agoraMs: AGORA, vistas });
  assert.equal(chamadas, 1);
  assert.equal(r2.ja_analisadas, 1);
  // mensagem nova do contato volta a ser analisada
  await analisarPendencias({ db: dbPend({ chats, msgs: [m(11, false, 1, "e entao?"), ...msgs] }), cfg, custo: { total: 0 }, chamar, agoraMs: AGORA, vistas });
  assert.equal(chamadas, 2);
});

for (const value of [true, undefined, "false", "error"]) {
  test(`notificacoes bloqueiam kill switch ${value} sem gateway`, async () => {
    for (const notify of [notificarResumos, notificarDigestDm]) {
      const db = dbEnvio({resumos: [resumo(1,"Grupo Alfa")], pend});
      const original = db.rows.bind(db);
      db.rows = async sql => {
        if (/from wa\.config/.test(sql)) {
          if (value === "error") throw new Error("unavailable");
          return value === undefined ? [] : [{valor:value}];
        }
        return original(sql);
      };
      const r = await notify({dryRun:false, log(){}, deps:{db, icones, salvos:new Map(), pushnames:new Map(), cfg:{...CONFIG_PADRAO, ENVIO_ATIVO:true, notificacao:{...CONFIG_PADRAO.notificacao, destino_dm:"Destino Ficticio"}}, exec(){throw new Error("gateway must not be invoked");}}});
      assert.equal(r.enviado, false);
      assert.match(r.motivo, /kill_switch/);
    }
  });
}
