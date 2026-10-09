import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acharBinario, dirsBusca, pathCompleto } from "../src/bin.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wai-state-"));
process.env.WAI_STATE_DIR = dir;
// Tudo que importa paths.mjs vem depois do override, para o teste nunca tocar no estado real.
const { gerarPlist } = await import("../src/launchagent.mjs");
const { CONFIG_PADRAO } = await import("../src/config.mjs");
const { adquirirLock, liberarLock, atualizarEstado, carregarEstado } = await import("../src/state.mjs");

test("acharBinario acha fora do PATH minimo do launchd", () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "wai-bin-"));
  const f = path.join(bin, "psql-ficticio");
  fs.writeFileSync(f, "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(acharBinario("psql-ficticio", bin), f);
  assert.equal(acharBinario("nao-existe-xyz", "/usr/bin:/bin"), null);
  assert.ok(dirsBusca("/usr/bin:/bin").includes(path.dirname(process.execPath)));
  assert.ok(pathCompleto().split(path.delimiter).includes(path.dirname(process.execPath)));
  fs.unlinkSync(f); fs.rmdirSync(bin);
});

test("plist leva PATH completo e nenhum segredo", () => {
  const x = gerarPlist({ appDir: "/app", config: CONFIG_PADRAO });
  assert.match(x, /<key>EnvironmentVariables<\/key>/);
  assert.match(x, new RegExp(`<key>PATH</key><string>${path.dirname(process.execPath)}:`));
  assert.doesNotMatch(x, /PASSWORD|PGPASSWORD|SERVICE_ROLE/i);
});

test("locks: dois ticks nunca rodam a mesma fase; fases diferentes nao se bloqueiam", () => {
  assert.equal(adquirirLock("ingestao"), true);
  assert.equal(adquirirLock("ingestao"), false);
  assert.equal(adquirirLock("resumos"), true);
  liberarLock("ingestao");
  assert.equal(adquirirLock("ingestao"), true);
  liberarLock("ingestao"); liberarLock("resumos");
});

test("lock de processo morto e retomado", () => {
  fs.writeFileSync(path.join(dir, "morto.lock"), "999999 2026-01-01T00:00:00Z\n");
  assert.equal(adquirirLock("morto"), true);
  liberarLock("morto");
});

test("atualizarEstado nao pisa em chaves de outra fase", () => {
  atualizarEstado((e) => { e.chats.a = { lastPk: 1 }; });
  atualizarEstado((e) => { e.resumos.diario = "2026-10-07"; });
  const e = carregarEstado();
  assert.equal(e.chats.a.lastPk, 1);
  assert.equal(e.resumos.diario, "2026-10-07");
});
