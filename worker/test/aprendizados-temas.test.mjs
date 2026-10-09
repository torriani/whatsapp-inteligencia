import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizarTemas, regrasAprendizado, encurtar, prepararAprendizado, LIMITE_CORPO } from "../src/temas.mjs";
import { montarPrompt, validarDecisao, contagens, fiel, sqlAtualizar, gravarBackup, planejar } from "../src/aprendizados-reclassificar.mjs";

const temas = normalizarTemas([{ nome: "Agentes", descricao: "criar agentes melhores" }, { nome: "Vendas", descricao: "vender mais" }, { nome: "agentes" }, "Copy", { nome: " " }]);

test("normalizarTemas aceita objeto ou texto, tira vazio e duplicado", () => {
  assert.deepEqual(temas.map((t) => t.nome), ["Agentes", "Vendas", "Copy"]);
  assert.deepEqual(normalizarTemas(null), []);
});

test("as regras do extrator vem da lista e mandam descartar suporte e limitar a 200", () => {
  const r = regrasAprendizado(temas);
  assert.match(r, /- Agentes: criar agentes melhores/);
  assert.match(r, /suporte/);
  assert.match(r, /200 caracteres/);
  assert.equal(regrasAprendizado([{ nome: "Outro", descricao: "" }]).includes("Agentes"), false);
});

test("encurtar respeita 200, corta em fim de frase e nao inventa", () => {
  assert.equal(encurtar("Curto."), "Curto.");
  const longo = `${"Primeira frase com algum conteudo. "}${"x".repeat(250)}`;
  assert.equal(encurtar(longo), "Primeira frase com algum conteudo.");
  assert.equal(encurtar("y".repeat(250)), null);
  assert.ok(!/[\u2013\u2014]/.test(encurtar("a \u2014 b")));
});

test("prepararAprendizado exige tema da lista, fonte valida e corpo curto", () => {
  const ids = new Set([1, 2]);
  const ok = prepararAprendizado({ titulo: "T", corpo: "Texto.", tema: "agentes", fontes: [1, 9], confianca: 9, tags: ["a"] }, { temas, ids });
  assert.equal(ok.tema, "Agentes");
  assert.deepEqual(ok.fontes, [1]);
  assert.equal(ok.confianca, 5);
  assert.equal(prepararAprendizado({ titulo: "T", corpo: "Texto.", tema: "Suporte", fontes: [1] }, { temas, ids }), null);
  assert.equal(prepararAprendizado({ titulo: "T", corpo: "Texto.", tema: "Copy", fontes: [9] }, { temas, ids }), null);
  assert.ok(ok.corpo.length <= LIMITE_CORPO);
});

const item = { id: 1, chat_nome: "G", titulo: "Roteador reduz tokens", corpo: "Uma camada entre usuario e modelo filtra a memoria e reduz o consumo de tokens." };

test("validarDecisao: descartar, manter, tema invalido, infiel", () => {
  assert.deepEqual(validarDecisao({ id: 1, decisao: "suporte" }, item, temas), { id: 1, status: "descartado", tema: null, corpo: item.corpo, motivo_descarte: "suporte" });
  const m = validarDecisao({ id: 1, decisao: "manter", tema: "Agentes", corpo: "Uma camada entre usuario e modelo reduz o consumo de tokens." }, item, temas);
  assert.equal(m.status, "candidato");
  assert.equal(m.tema, "Agentes");
  assert.equal(validarDecisao({ id: 1, decisao: "manter", tema: "Nada", corpo: "x" }, item, temas), null);
  assert.equal(validarDecisao({ id: 2, decisao: "suporte" }, item, temas), null);
  assert.equal(validarDecisao({ id: 1, decisao: "talvez" }, item, temas), null);
  // reescrita infiel cai para o proprio texto original
  const inf = validarDecisao({ id: 1, decisao: "manter", tema: "Agentes", corpo: "Blockchain quantica revoluciona orquestracao financeira global" }, item, temas);
  assert.equal(inf.corpo, item.corpo);
  assert.equal(fiel("camada modelo tokens", item.corpo), true);
});

test("contagens separa mantidos por tema e descartados por motivo", () => {
  const c = contagens([1, 2, 3, 4], [
    { status: "candidato", tema: "Agentes" }, { status: "candidato", tema: "Agentes" },
    { status: "descartado", motivo_descarte: "suporte" },
  ]);
  assert.deepEqual(c, { antes: 4, mantidos: 2, por_tema: { Agentes: 2 }, descartados: { suporte: 1, fora_do_tema: 0 }, nao_processados: 1 });
});

test("prompt de reclassificacao usa a lista de temas e proibe inventar", () => {
  const p = montarPrompt(temas, [item]);
  assert.match(p, /- Vendas: vender mais/);
  assert.match(p, /Nao invente/);
  assert.match(p, /#1 \(G\) Roteador/);
});

test("planejar usa o llm injetado e refaz em grupos menores o que falhar", async () => {
  const db = { rows: async () => [item, { ...item, id: 2 }] };
  let chamadas = 0;
  const llm = async (prompt) => {
    chamadas++;
    if (chamadas === 1) return { texto: "nao e json", custo: 0.1 };
    const ids = [...prompt.matchAll(/^#(\d+) /gm)].map((m) => Number(m[1]));
    return { texto: JSON.stringify({ itens: ids.map((id) => ({ id, decisao: "fora_do_tema" })) }), custo: 0.1 };
  };
  const r = await planejar({ db, temas, llm });
  assert.equal(r.plano.length, 2);
  assert.ok(chamadas >= 2);
});

test("sqlAtualizar roda em transacao, sem delete, so as 4 colunas", () => {
  const sql = sqlAtualizar([{ id: 1, tema: "Agentes", corpo: "x", status: "candidato", motivo_descarte: null }]);
  assert.match(sql, /^begin;/);
  assert.match(sql, /commit;$/);
  assert.doesNotMatch(sql, /delete|drop|truncate/i);
  assert.match(sql, /set tema = x\.tema, corpo = x\.corpo, status = x\.status, motivo_descarte = x\.motivo_descarte/);
});

test("backup grava JSON 600", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bk-"));
  const f = gravarBackup([{ id: 1 }], dir);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), [{ id: 1 }]);
  assert.equal(fs.statSync(f).mode & 0o077, 0);
});
