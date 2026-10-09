import test from "node:test";
import assert from "node:assert/strict";
import { enviarResumo, chaveIdempotencia } from "../src/sender.mjs";
import { CONFIG_PADRAO as BASE_CONFIG } from "../src/config.mjs";

const CONFIG_PADRAO = { ...BASE_CONFIG, notificacao: { ...BASE_CONFIG.notificacao, grupo: "Grupo Teste" } };
import { formatarResumo, textoLimpo, sanitizar } from "../src/textguard.mjs";

const never = () => { throw new Error("gateway nao deve ser chamado"); };

test("dry-run nao chama o gateway", async () => {
  const r = await enviarResumo({ texto: "ok", dia: "2026-10-07", config: CONFIG_PADRAO, dryRun: true, exec: never });
  assert.equal(r.enviado, false);
  assert.equal(r.destino, "Grupo Teste");
});

test("trava ENVIO_ATIVO desligada bloqueia mesmo sem dry-run", async () => {
  const r = await enviarResumo({ texto: "ok", dia: "2026-10-07", config: CONFIG_PADRAO, dryRun: false, exec: never });
  assert.match(r.motivo, /ENVIO_ATIVO/);
});

test("gateway desconectado bloqueia; conectado envia", async () => {
  const cfg = { ...CONFIG_PADRAO, ENVIO_ATIVO: true };
  const chamadas = [];
  const off = async (b, a) => { chamadas.push(a[0]); return { stdout: "whatsapp: disconnected" }; };
  assert.equal((await enviarResumo({ texto: "ok", dia: "d", config: cfg, dryRun: false, exec: off })).enviado, false);
  assert.deepEqual(chamadas, ["channel"]);
  const on = async (b, a) => { chamadas.push(a[0]); return { stdout: a[0] === "channel" ? "whatsapp: connected" : "{}" }; };
  const r = await enviarResumo({ texto: "ok", dia: "2026-10-07", config: cfg, dryRun: false, exec: on });
  assert.equal(r.enviado, true);
  assert.equal(r.chave, "whatsapp-inteligencia:resumo:2026-10-07:grupo-teste");
});

test("texto com travessao ou emoji e recusado e sanitizado", async () => {
  const sujo = "a \u2014 b";
  assert.equal(textoLimpo(sujo), false);
  assert.equal(textoLimpo(sanitizar(sujo)), true);
  const r = await enviarResumo({ texto: sujo, dia: "d", config: CONFIG_PADRAO, dryRun: true });
  assert.match(r.motivo, /travessao/);
  assert.equal(textoLimpo(formatarResumo("2026-10-07", [{ grupo: "G", discutido: ["x \u2013 y"], decidido: [], olhar: ["z"] }])), true);
  assert.equal(chaveIdempotencia("A B", "d"), "whatsapp-inteligencia:resumo:d:a-b");
});

test("status JSON do gateway: connected libera, disconnected bloqueia", async () => {
  const cfg = { ...CONFIG_PADRAO, ENVIO_ATIVO: true };
  const mk = (status) => async (b, a) => ({ stdout: a[0] === "channel" ? JSON.stringify({ service: "running", whatsapp: status }, null, 2) : "{}" });
  assert.equal((await enviarResumo({ texto: "ok", dia: "d", config: cfg, dryRun: false, exec: mk("disconnected") })).enviado, false);
  assert.equal((await enviarResumo({ texto: "ok", dia: "d", config: cfg, dryRun: false, exec: mk("connected") })).enviado, true);
});
