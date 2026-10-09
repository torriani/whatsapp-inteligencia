import assert from "node:assert/strict";
import test from "node:test";
import { fimDoDiaExclusivo, inicioDoDia, lerFiltroTipo, lerParametrosMensagens, montarQuery } from "./parametros";

test("limites do dia em horário de Brasília", () => {
  assert.equal(inicioDoDia("2026-10-07"), "2026-10-07T03:00:00.000Z");
  assert.equal(fimDoDiaExclusivo("2026-10-07"), "2026-10-08T03:00:00.000Z");
  assert.equal(inicioDoDia("2026-02-30"), null);
  assert.equal(inicioDoDia("lixo"), null);
});

test("parâmetros inválidos são descartados", () => {
  const p = lerParametrosMensagens({ q: "x", de: "abc", ate: "2026-13-01", antes_em: "lixo", antes_id: "5" });
  assert.equal(p.de, "");
  assert.equal(p.ate, "");
  assert.equal(p.antesEm, null);
  assert.equal(p.antesId, null);
  assert.equal(p.busca, "x");
});

test("cursor válido tem prioridade sobre o limite de data", () => {
  const p = lerParametrosMensagens({ ate: "2026-10-07", antes_em: "2026-10-06T12:00:00Z", antes_id: "10" });
  assert.equal(p.antesEm, "2026-10-06T12:00:00.000Z");
  assert.equal(p.antesId, 10);
  const q = lerParametrosMensagens({ ate: "2026-10-07", de: "2026-10-01" });
  assert.equal(q.antesEm, "2026-10-08T03:00:00.000Z");
  assert.equal(q.antesId, null);
  assert.equal(q.desde, "2026-10-01T03:00:00.000Z");
});

test("montarQuery ignora vazios", () => {
  assert.equal(montarQuery({ a: "1", b: "", c: null, d: 2 }), "?a=1&d=2");
  assert.equal(montarQuery({}), "");
});

test("filtro de tipo: DMs só com tipo=direto", () => {
  assert.equal(lerFiltroTipo({}), "grupos");
  assert.equal(lerFiltroTipo({ tipo: "direto" }), "direto");
  assert.equal(lerFiltroTipo({ tipo: ["direto", "x"] }), "direto");
  assert.equal(lerFiltroTipo({ tipo: "qualquer" }), "grupos");
});
