import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dollar, lit, jsonLit } from "../src/db.mjs";
import { extrairJson } from "../src/llm.mjs";
import { validarAntiIa, diaBrt, addDias } from "../src/inteligencia.mjs";

test("dollar quoting nao colide com o conteudo", () => {
  const q = dollar("texto com $$ e $x$ e ' aspas");
  assert.match(q, /^\$q[0-9a-f]{12}\$.*\$q[0-9a-f]{12}\$$/s);
  assert.equal(lit(null), "null");
  assert.ok(jsonLit({ a: "x$y" }).endsWith("::jsonb"));
});

test("extrairJson tolera cerca de codigo e texto ao redor", () => {
  assert.deepEqual(extrairJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extrairJson('Segue: {"a":{"b":2}} fim'), { a: { b: 2 } });
  assert.throws(() => extrairJson("sem json"));
});

test("validador de forma reprova travessao e usa o script externo", () => {
  assert.equal(validarAntiIa("a \u2014 b").ok, false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wai-test-"));
  const ok = path.join(dir, "ok.sh"); const ruim = path.join(dir, "ruim.sh");
  fs.writeFileSync(ok, "exit 0\n"); fs.writeFileSync(ruim, "exit 1\n");
  assert.equal(validarAntiIa("texto simples", ok).ok, true);
  assert.equal(validarAntiIa("texto simples", ruim).ok, false);
  fs.unlinkSync(ok); fs.unlinkSync(ruim); fs.rmdirSync(dir);
});

test("datas BRT", () => {
  assert.equal(diaBrt(Date.parse("2026-10-07T02:30:00Z")), "2026-10-06");
  assert.equal(addDias("2026-10-01", -1), "2026-09-30");
});
