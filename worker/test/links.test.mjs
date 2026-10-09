import test from "node:test";
import assert from "node:assert/strict";
import { extractLinks, normalizeUrl } from "../src/links.mjs";

test("extrai, normaliza e tira rastreio", () => {
  const l = extractLinks("veja https://www.Exemplo.com/a?utm_source=x&id=2#topo, e (https://outro.org/p).", "Ana");
  assert.equal(l.length, 2);
  assert.equal(l[0].urlNorm, "https://www.exemplo.com/a?id=2");
  assert.equal(l[0].dominio, "exemplo.com");
  assert.equal(l[0].autor, "Ana");
  assert.equal(l[1].url, "https://outro.org/p");
});

test("dedupe dentro da mensagem e www sem protocolo", () => {
  const l = extractLinks("www.site.com/x https://site.com/x?fbclid=1 https://www.site.com/x");
  assert.equal(l.length, 2);
});

test("sem link", () => {
  assert.deepEqual(extractLinks("oi tudo bem? versão 1.2"), []);
  assert.deepEqual(extractLinks(null), []);
  assert.equal(normalizeUrl("http://semponto"), null);
});
