import assert from "node:assert/strict";
import test from "node:test";
import {
  TEXTO_REDIGIDO,
  calcularSaude,
  dataDoDia,
  dominioExibivel,
  exibirMensagem,
  formatarData,
  haQuantoTempo,
  mensagemErroAmigavel,
  normalizarItens,
  urlSegura,
} from "./formato";

const AGORA = new Date("2026-10-07T15:00:00Z");

test("mensagem redigida exibe o aviso de sensibilidade e nunca o texto", () => {
  const e = exibirMensagem({ texto: "segredo", redigida: true, apagada: false, tem_midia: false, transcrito: false });
  assert.equal(e.tipo, "redigida");
  assert.equal(e.texto, "conteúdo omitido por filtro de sensibilidade");
  assert.equal(e.texto, TEXTO_REDIGIDO);
});

test("mensagem apagada, mídia e texto comum", () => {
  assert.equal(exibirMensagem({ texto: null, redigida: false, apagada: true, tem_midia: false, transcrito: false }).tipo, "apagada");
  assert.equal(exibirMensagem({ texto: null, redigida: false, apagada: false, tem_midia: true, transcrito: false }).tipo, "midia");
  assert.deepEqual(exibirMensagem({ texto: " olá ", redigida: false, apagada: false, tem_midia: false, transcrito: false }), { tipo: "texto", texto: "olá" });
});

test("saúde: sem execuções, saudável, atrasada, parada e erro", () => {
  assert.equal(calcularSaude(null, AGORA).status, "sem-dados");
  const base = { iniciou_em: "2026-10-07T14:50:00Z", terminou_em: "2026-10-07T14:52:00Z", erro: null };
  assert.equal(calcularSaude(base, AGORA).status, "saudavel");
  const atrasada = calcularSaude({ ...base, terminou_em: "2026-10-07T12:00:00Z" }, AGORA);
  assert.equal(atrasada.status, "atrasada");
  assert.equal(atrasada.rotulo, "Atrasada");
  const parada = calcularSaude({ ...base, terminou_em: "2026-10-06T12:00:00Z" }, AGORA);
  assert.equal(parada.rotulo, "Parada");
  assert.equal(calcularSaude({ ...base, erro: "falha" }, AGORA).status, "erro");
});

test("normalizarItens aceita texto e objetos e ignora lixo", () => {
  assert.deepEqual(normalizarItens(["a", " ", { texto: "b" }, { topico: "c" }, { x: 1 }, 5, null]), ["a", "b", "c"]);
  assert.deepEqual(normalizarItens(null), []);
  assert.deepEqual(normalizarItens({ texto: "x" }), []);
});

test("datas: pura não desloca fuso e dia no fuso de Brasília", () => {
  assert.equal(formatarData("2026-10-07"), "07/10/2026");
  assert.equal(dataDoDia("2026-10-08T02:00:00Z"), "2026-10-07");
  assert.equal(formatarData(null), "sem registro");
});

test("haQuantoTempo", () => {
  assert.equal(haQuantoTempo("2026-10-07T14:40:00Z", AGORA), "há 20 min");
  assert.equal(haQuantoTempo("2026-10-07T10:00:00Z", AGORA), "há 5 h");
  assert.equal(haQuantoTempo("2026-10-05T10:00:00Z", AGORA), "há 2 dias");
  assert.equal(haQuantoTempo(null, AGORA), "sem registro");
});

test("erro do schema não exposto vira mensagem amigável", () => {
  assert.match(mensagemErroAmigavel({ code: "PGRST106", message: "Invalid schema: wa" }), /não está exposto/);
  assert.match(mensagemErroAmigavel({ code: "42501", message: "permission denied" }), /permissão/);
  assert.match(mensagemErroAmigavel({ message: "boom" }), /Não foi possível/);
});

test("urlSegura só aceita http e https", () => {
  assert.equal(urlSegura("https://exemplo.com/a"), "https://exemplo.com/a");
  assert.equal(urlSegura("javascript:alert(1)"), null);
  assert.equal(urlSegura("nao é url"), null);
  assert.equal(dominioExibivel("www.exemplo.com"), "exemplo.com");
});
