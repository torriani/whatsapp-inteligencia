import test from "node:test";
import assert from "node:assert/strict";
import { processar } from "../src/processar.mjs";

const row = (o) => ({ pk: 1, fromMe: 0, data: 780000000, stanza: "S1", texto: "oi", tipo: 0, evento: null, midia: null, pai: null, autor: "Ana", ...o });

test("sensivel vira so metadado", () => {
  const r = processar(row({ texto: "senha: abc12345" }));
  assert.equal(r.redigida, true);
  assert.equal(r.texto, null);
  assert.deepEqual(r.links, []);
});

test("texto com link, apagada e evento", () => {
  assert.equal(processar(row({ texto: "veja https://a.com/x" })).links.length, 1);
  assert.equal(processar(row({ tipo: 14, texto: null })).apagada, true);
  assert.equal(processar(row({ tipo: 10, texto: null })).kind, "evento");
  assert.equal(processar(row({ tipo: 6, evento: 15, texto: null })).kind, "evento");
  assert.equal(processar(row({ tipo: 0, evento: 2, texto: "oi" })).kind, "texto");
});
