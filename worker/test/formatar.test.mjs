import test from "node:test";
import assert from "node:assert/strict";
import { formatarResumoGrupo, formatarDigestDm, iconeDoGrupo, limparItem, nomeCurto, esperaTexto, LIMITE_MENSAGEM } from "../src/formatar.mjs";
import { temTravessao } from "../src/textguard.mjs";

const icones = { padrao: "\u{1F4AC}", regras: [{ contem: "alfa", emoji: "\u{1F916}", links: true }, { contem: "beta", emoji: "\u{1F393}" }] };

test("icone por tema, com padrao e flag de links", () => {
  assert.deepEqual(iconeDoGrupo("Grupo Alfa Premium", icones), { emoji: "\u{1F916}", links: true });
  assert.deepEqual(iconeDoGrupo("Time Beta", icones), { emoji: "\u{1F393}", links: false });
  assert.deepEqual(iconeDoGrupo("Qualquer", icones), { emoji: "\u{1F4AC}", links: false });
});

test("resumo de grupo: cabecalho, secoes em negrito, links, sem markup nem travessao nos itens", () => {
  const [m, ...resto] = formatarResumoGrupo({
    nome: "\u{1F916} Grupo Alfa | Comunidade", dia: "2026-10-06", icones,
    discutido: ["Tema *um* com _marcas_", "Tema dois \u2014 com travessao"],
    decidido: ["Decisao \u{1F680} tomada"], olhar: ["Responder a duvida"],
    links: Array.from({ length: 8 }, (_, i) => ({ url_norm: `https://www.exemplo${i}.com/p?id=${i}` })),
  });
  assert.equal(resto.length, 0);
  assert.ok(m.startsWith("\u{1F916} *Grupo Alfa* · 06/10"));
  for (const t of ["*O que foi discutido*", "*O que foi decidido*", "*O que você precisa olhar*", "*Links do dia*"]) assert.ok(m.includes(t), t);
  assert.ok(m.includes("- Tema um com marcas"));
  assert.ok(!temTravessao(m));
  assert.ok(!m.includes("\u{1F680}"));
  assert.equal(m.split("\n").filter((l) => l.startsWith("- exemplo")).length, 5);
  assert.ok(m.includes("- exemplo0.com/p?id=0"));
});

test("grupo sem flag de links nao mostra Links do dia", () => {
  const [m] = formatarResumoGrupo({ nome: "Time Beta", dia: "2026-10-06", icones, discutido: ["x"], links: [{ url_norm: "https://a.com" }] });
  assert.ok(!m.includes("Links do dia"));
});

test("mensagem longa e dividida em partes dentro do limite, com cabecalho em todas", () => {
  const itens = Array.from({ length: 6 }, (_, i) => `Item ${i} ${"palavra ".repeat(20)}`);
  const partes = formatarResumoGrupo({ nome: "Grupo Alfa", dia: "2026-10-06", icones, discutido: itens, decidido: itens, olhar: itens, limite: 600 });
  assert.ok(partes.length > 1);
  partes.forEach((p, i) => { assert.ok(p.length <= 600, `${p.length}`); assert.ok(p.includes(`(${i + 1}/${partes.length})`)); assert.ok(p.includes("*Grupo Alfa*")); });
  const normal = formatarResumoGrupo({ nome: "Grupo Alfa", dia: "2026-10-06", icones, discutido: itens, decidido: itens, olhar: itens });
  normal.forEach((p) => assert.ok(p.length <= LIMITE_MENSAGEM));
});

test("limparItem e nomeCurto", () => {
  assert.equal(limparItem("  - *a* _b_ ~c~ `d` \u{1F600} e"), "a b c d e");
  assert.ok(limparItem("x".repeat(500), 50).length <= 50);
  assert.equal(nomeCurto("\u{1F680} SIA - Sociedade | Comunidade longa"), "SIA - Sociedade");
});

test("digest de DM: ordem preservada, ate 10 por mensagem, marcadores de urgencia", () => {
  const p = Array.from({ length: 12 }, (_, i) => ({
    contato_nome: `Contato ${i}`, espera_desde: new Date(Date.now() - (i + 1) * 3600e3).toISOString(),
    pedido: `Quer confirmar o horario ${i}`, urgencia: i < 2 ? "alta" : i < 5 ? "media" : "baixa", tipo_resposta: "Confirmar horário", audio_sem_transcricao: i === 11,
  }));
  const partes = formatarDigestDm({ dia: "2026-10-07", pendencias: p, porMensagem: 10 });
  assert.equal(partes.length, 2);
  assert.ok(partes[0].startsWith("\u{1F4EC} *Quem espera sua resposta* · 07/10 (1/2)"));
  assert.equal((partes[0].match(/\u{1F534}|\u{1F7E1}|\u{1F7E2}/gu) || []).length, 10);
  assert.ok(partes[0].indexOf("Contato 0") < partes[0].indexOf("Contato 1"));
  assert.ok(partes[1].includes("áudio sem transcrição"));
  partes.forEach((x) => { assert.ok(!temTravessao(x)); assert.ok(x.length < LIMITE_MENSAGEM * 2); });
});

test("espera em horas e dias", () => {
  const agora = Date.parse("2026-10-07T12:00:00Z");
  assert.equal(esperaTexto("2026-10-07T09:00:00Z", agora), "3 h");
  assert.equal(esperaTexto("2026-10-04T12:00:00Z", agora), "3 dias");
});
