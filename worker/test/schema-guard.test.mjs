import test from "node:test";
import assert from "node:assert/strict";
import { avaliarSchema, ESPERADO, SchemaGuardError } from "../src/schema-guard.mjs";

const completo = () => Object.fromEntries(Object.entries(ESPERADO).map(([t, c]) => [t, [...c, "COLUNA_EXTRA"]]));

test("schema completo passa (colunas extras toleradas)", () => {
  assert.equal(avaliarSchema(completo()), true);
});

test("coluna ausente aborta e nomeia", () => {
  const s = completo();
  s.ZWAMESSAGE = s.ZWAMESSAGE.filter((c) => c !== "ZSTANZAID");
  assert.throws(() => avaliarSchema(s), (e) => e instanceof SchemaGuardError && e.faltando.includes("ZWAMESSAGE.ZSTANZAID"));
});

test("tabela ausente aborta", () => {
  const s = completo();
  delete s.ZWACHATSESSION;
  assert.throws(() => avaliarSchema(s), SchemaGuardError);
});
