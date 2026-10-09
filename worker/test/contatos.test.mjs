import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { criarLeitorContatos, sincronizarContatos } from "../src/contatos.mjs";
import { nomeParaLista, nomeComNumero, numeroParaLista, montarListaNaoContatos, atualizarNomes } from "../src/naocontatos.mjs";
import { soContatos } from "../src/pendencias.mjs";
import { notificarDigestDm } from "../src/run.mjs";
import { resolverDms } from "../src/dm.mjs";
import { formatarDigestDm } from "../src/formatar.mjs";
import { CONFIG_PADRAO } from "../src/config.mjs";
import { temTravessao } from "../src/textguard.mjs";

const AGORA = Date.parse("2026-10-08T12:00:00Z");
const h = (horas) => new Date(AGORA - horas * 3600e3).toISOString();
const J = (d) => `${d}@s.whatsapp.net`;

// Bancos sqlite ficticios (mesmas tabelas e colunas do WhatsApp, dados inventados).
function criarSqlites() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wai-contatos-"));
  const agenda = path.join(dir, "ContactsV2.sqlite"); const chat = path.join(dir, "ChatStorage.sqlite");
  execFileSync("sqlite3", [agenda, `create table ZWAADDRESSBOOKCONTACT (Z_PK integer primary key, ZFULLNAME text, ZWHATSAPPID text, ZLID text, ZPHONENUMBER text);
    insert into ZWAADDRESSBOOKCONTACT (ZFULLNAME, ZWHATSAPPID, ZLID, ZPHONENUMBER) values ('Ana Salva', '5511900000001@s.whatsapp.net', '111111111111111@lid', '+5511900000001');`]);
  execFileSync("sqlite3", [chat, `create table ZWAPROFILEPUSHNAME (Z_PK integer primary key, ZJID text, ZPUSHNAME text);
    create table ZWACHATSESSION (Z_PK integer primary key, ZCONTACTJID text, ZPARTNERNAME text, ZSESSIONTYPE integer);
    insert into ZWACHATSESSION (ZCONTACTJID, ZPARTNERNAME, ZSESSIONTYPE) values ('222222222222222@lid', '+55 11 90000-0000', 0), ('5511900000002@s.whatsapp.net', 'Nome de Chat', 0);
    insert into ZWAPROFILEPUSHNAME (ZJID, ZPUSHNAME) values ('5511900000002@s.whatsapp.net', 'Beto Perfil'), ('5511900000003@s.whatsapp.net', '');`]);
  return { dir, agenda, chat };
}

test("agenda: contato salvo por jid de telefone ou lid; desconhecido nao; pushname lido", async () => {
  const { dir, agenda, chat } = criarSqlites();
  try {
    const l = criarLeitorContatos({ contactsDb: agenda, chatDb: chat });
    const salvos = await l.jidsSalvos();
    assert.equal(salvos.has(J("5511900000001")), true);
    assert.equal(salvos.has("111111111111111@lid"), true);
    assert.equal(salvos.has(J("5511900000002")), false);
    assert.equal(salvos.get(J("5511900000001")), "Ana Salva");
    const push = await l.pushnames();
    assert.equal(push.get(J("5511900000002")), "Beto Perfil");
    assert.equal(push.has(J("5511900000003")), false);
    assert.equal(push.get("222222222222222@lid"), "+55 11 90000-0000");
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test("agenda: schema diferente ou vazia falha fechada", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wai-contatos-"));
  try {
    const vazio = path.join(dir, "v.sqlite");
    execFileSync("sqlite3", [vazio, "create table ZWAADDRESSBOOKCONTACT (ZWHATSAPPID text, ZLID text, ZFULLNAME text);"]);
    await assert.rejects(criarLeitorContatos({ contactsDb: vazio }).jidsSalvos(), /vazia/);
    const outro = path.join(dir, "o.sqlite");
    execFileSync("sqlite3", [outro, "create table ZWAADDRESSBOOKCONTACT (ZOUTRA text);"]);
    await assert.rejects(criarLeitorContatos({ contactsDb: outro }).jidsSalvos(), /mudou/);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test("sincronizar marca contato true/false so em DMs, sem gravar telefone", async () => {
  const log = [];
  const db = { async rows() { return [{ id: "a", jid: J("5511900000001") }, { id: "b", jid: J("5511900000002") }]; }, async exec(q) { log.push(q); } };
  const r = await sincronizarContatos(db, new Map([[J("5511900000001"), "Ana"]]));
  assert.deepEqual(r, { contatos: 1, nao_contatos: 1 });
  assert.equal(log.length, 2);
  assert.ok(log[0].includes("contato = true") && log[1].includes("contato = false"));
  assert.ok(log.every((q) => !q.includes("5511900000001")));
});

test("nome: agenda, depois pushname, depois chat; codigo nunca e nome", () => {
  const push = new Map([[J("5511900000002"), "Beto Perfil"]]);
  const agenda = new Map([[J("5511900000001"), "Ana Salva"]]);
  assert.equal(nomeParaLista(J("5511900000001"), "‪+55 11 90000-0001‬", push, agenda), "Ana Salva");
  assert.equal(nomeParaLista(J("5511900000002"), "‪+55 11 90000-0002‬", push, agenda), "Beto Perfil");
  assert.equal(nomeParaLista(J("5511900000004"), "Dora Chat", push, agenda), "Dora Chat");
  assert.equal(nomeParaLista(J("5511900000005"), "‪+55 11 90000-0005‬", push, agenda), "sem nome");
  assert.equal(nomeParaLista(J("5511900000005"), "5511900000005@s.whatsapp.net", push, agenda), "sem nome");
  assert.equal(nomeParaLista(J("5511900000005"), "Contato 0005", push, agenda), "sem nome");
});

test("sem nome mostra o numero formatado; jid @lid so com numero vindo do nome exibido", () => {
  const vazio = new Map();
  assert.equal(nomeComNumero(J("5511900000005"), "", vazio), "sem nome +55 11 90000-0005");
  assert.equal(numeroParaLista(J("551193623942"), "", vazio), "+55 11 99362-3942", "formato antigo de 8 digitos");
  assert.equal(numeroParaLista(J("551193621234"), "", vazio), "+55 11 99362-1234");
  assert.equal(numeroParaLista("222222222222222@lid", "‪+55 11 90000‑0000‬", vazio), "+55 11 90000-0000");
  assert.equal(numeroParaLista("222222222222222@lid", "Fulano", vazio), "número oculto pelo WhatsApp");
  assert.equal(nomeComNumero("222222222222222@lid", "Fulano", vazio), "Fulano");
  assert.equal(nomeComNumero("222222222222222@lid", "", vazio), "sem nome");
  assert.equal(nomeParaLista(J("5511900000005"), "sem nome +55 11 90000-0005", vazio), "sem nome");
});

const pends = [
  { jid: J("5511900000001"), contato: true, contato_nome: "Ana Salva", ultima_em: h(30), espera_desde: h(40), pedido: "Quer o contrato", urgencia: "alta", tipo_resposta: "Enviar", audio_sem_transcricao: false },
  { jid: J("5511900000002"), contato: false, contato_nome: "Beto Perfil", ultima_em: h(5), espera_desde: h(6), pedido: "Pede horario", urgencia: "media", tipo_resposta: "Confirmar", audio_sem_transcricao: false },
  { jid: J("5511900000005"), contato: false, contato_nome: "‪+55 11 90000-0005‬", ultima_em: h(100), espera_desde: h(100), pedido: "", urgencia: "baixa", tipo_resposta: "Ouvir", audio_sem_transcricao: true },
  { jid: J("5511900000006"), contato: null, contato_nome: "Gabi", ultima_em: h(2), espera_desde: h(2), pedido: "Pede link", urgencia: "baixa", tipo_resposta: "Enviar link", audio_sem_transcricao: false },
];

test("lista de nao contatos: so nao contatos, mais recente primeiro, nome e numero, sem travessao", () => {
  const r = montarListaNaoContatos({ pendencias: pends, pushnames: new Map(), dia: "2026-10-08", agoraMs: AGORA });
  assert.equal(r.total, 3);
  assert.deepEqual(r.itens.map((i) => i.nome), ["Gabi", "Beto Perfil", "sem nome"]);
  assert.ok(r.texto.includes("*Beto Perfil* · +55 11 90000-0002".replace("0002", "0002")) || r.texto.includes("*Beto Perfil*"));
  assert.ok(r.texto.includes("+55 11 90000-0005"));
  assert.ok(r.texto.includes("áudio sem transcrição") && r.texto.includes("há 4 dias") && r.texto.includes("há 5 h"));
  assert.ok(!r.texto.includes("Ana Salva") && !temTravessao(r.texto) && !r.texto.includes("@"));
});

test("lista de nao contatos respeita a exclusao de DMs", () => {
  const r = montarListaNaoContatos({ pendencias: pends, pushnames: new Map(), exclusoes: { excluir: [{ telefone: "5511900000002" }] }, dia: "2026-10-08", agoraMs: AGORA });
  assert.deepEqual(r.itens.map((i) => i.nome), ["Gabi", "sem nome"]);
});

test("soContatos: null conta como nao contato", () => {
  assert.deepEqual(soContatos(pends).map((p) => p.contato_nome), ["Ana Salva"]);
});

test("digest: ordem por ultima mensagem (mais recente primeiro), 'ha X', urgencia visivel", () => {
  const partes = formatarDigestDm({ dia: "2026-10-08", pendencias: pends, agoraMs: AGORA });
  const t = partes.join("\n");
  assert.ok(t.indexOf("Gabi") < t.indexOf("Beto Perfil") && t.indexOf("Beto Perfil") < t.indexOf("Ana Salva"));
  assert.ok(t.includes("há 5 h") && t.includes("há 30 h") && t.includes("\u{1F534}"));
  assert.ok(!t.includes("· espera"));
});

function dbDigest(rows) {
  const log = [];
  return { log, async exec(q) { log.push(q); return ""; }, async rows(q) { log.push(q); return /from wa\.config/.test(q) ? [{valor:false}] : /from wa\.pendencias_resposta p join/.test(q) ? rows : []; } };
}
const cfgDigest = (extra = {}) => ({ ...CONFIG_PADRAO, ENVIO_ATIVO: true, notificacao: { ...CONFIG_PADRAO.notificacao, destino_dm: "Destino Ficticio" }, dm: { ...CONFIG_PADRAO.dm, ...extra } });
const execOk = (chamadas) => async (bin, args) => { chamadas.push(args); if (args[0] === "send") chamadas.push([fs.readFileSync(args[args.indexOf("--file") + 1], "utf8")]); return { stdout: args[0] === "channel" ? "whatsapp: connected" : "{}" }; };

test("digest ativo: so contatos, nome resolvido, nunca codigo", async () => {
  const chamadas = [];
  const rows = [...pends, { ...pends[0], jid: J("5511900000007"), contato: true, contato_nome: "‪+55 11 90000-0007‬", ultima_em: h(50) }];
  const salvos = new Map([[J("5511900000001"), "Ana Salva"], [J("5511900000007"), "Hugo Agenda"]]);
  const r = await notificarDigestDm({ dia: "2026-10-08", dryRun: false, log() {}, deps: { cfg: cfgDigest(), db: dbDigest(rows), exec: execOk(chamadas), salvos, pushnames: new Map() } });
  assert.equal(r.pendencias, 2);
  assert.equal(r.ocultas, 3);
  const texto = chamadas.filter((a) => a[0] !== "send" && a[0] !== "channel").flat().join("\n");
  assert.ok(texto.includes("Ana Salva") && texto.includes("Hugo Agenda"));
  assert.ok(!texto.includes("Beto Perfil") && !texto.includes("Gabi") && !texto.includes("@") && !texto.includes("5511900000007"));
});

test("digest com somente_contatos desligado inclui todos", async () => {
  const r = await notificarDigestDm({ dia: "2026-10-08", dryRun: true, log() {}, deps: { cfg: cfgDigest({ somente_contatos: false }), db: dbDigest(pends), exec: execOk([]), salvos: new Map(), pushnames: new Map() } });
  assert.equal(r.pendencias, 4);
});

test("config padrao liga o filtro de contatos", () => assert.equal(CONFIG_PADRAO.dm.somente_contatos, true));

test("atualizarNomes grava nome resolvido em chats e pendencias abertas, so quando muda", async () => {
  const log = [];
  const db = {
    async rows() { return [{ id: "a", jid: J("5511900000002"), nome: "‪+55 11 90000-0002‬" }, { id: "b", jid: J("5511900000004"), nome: "Dora Chat" }]; },
    async exec(q) { log.push(q); },
  };
  const n = await atualizarNomes(db, new Map(), new Map([[J("5511900000002"), "Beto Perfil"]]));
  assert.equal(n, 1);
  assert.ok(log[0].includes("Beto Perfil") && log[1].includes("update wa.pendencias_resposta"));
});

test("resolverDms usa nomear sem afetar a exclusao por nome original", () => {
  const sessoes = [
    { pk: 1, jid: J("5511900000002"), nome: "‪+55 11 90000-0002‬", tipo: 0, removido: false, ultima: (AGORA / 1000 - 978307200) },
    { pk: 2, jid: J("5511900000003"), nome: "Excluida", tipo: 0, removido: false, ultima: (AGORA / 1000 - 978307200) },
  ];
  const r = resolverDms(sessoes, { excluir: [{ nome: "Excluida" }] }, { agoraMs: AGORA, nomear: () => "Beto Perfil" });
  assert.deepEqual(r.map((x) => x.nome), ["Beto Perfil"]);
});
