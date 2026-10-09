import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { agregarAtividade, carregarDashboard, contarPorDia, faixaDeIdade, resumirPendencias, ultimosDias } from "./dashboard";

const AGORA = new Date("2026-10-08T15:00:00Z");

test("ultimosDias devolve n dias em ordem crescente terminando hoje", () => {
  const dias = ultimosDias(3, AGORA);
  assert.deepEqual(dias, ["2026-10-06", "2026-10-07", "2026-10-08"]);
});

test("contarPorDia usa o fuso do portal e ignora datas fora da janela", () => {
  const dias = ultimosDias(3, AGORA);
  const r = contarPorDia(["2026-10-08T01:00:00Z", "2026-10-08T14:00:00Z", "2026-10-07T12:00:00Z", "2026-09-01T12:00:00Z"], dias);
  // 01:00Z de 08/10 ainda é 07/10 em São Paulo
  assert.deepEqual(r.map((p) => p.total), [0, 2, 1]);
});

test("faixaDeIdade separa hoje, 1 a 3 dias e mais de 3", () => {
  assert.equal(faixaDeIdade("2026-10-08T10:00:00Z", AGORA), "hoje");
  assert.equal(faixaDeIdade("2026-10-07T10:00:00Z", AGORA), "um-a-tres");
  assert.equal(faixaDeIdade("2026-10-05T10:00:00Z", AGORA), "um-a-tres");
  assert.equal(faixaDeIdade("2026-10-04T10:00:00Z", AGORA), "mais-de-tres");
});

test("resumirPendencias conta por urgência e por idade", () => {
  const r = resumirPendencias(
    [
      { urgencia: "alta", espera_desde: "2026-10-08T10:00:00Z" },
      { urgencia: "alta", espera_desde: "2026-10-01T10:00:00Z" },
      { urgencia: "baixa", espera_desde: "2026-10-06T10:00:00Z" },
    ],
    AGORA,
  );
  assert.equal(r.total, 3);
  assert.deepEqual(r.porUrgencia, { alta: 2, media: 0, baixa: 1 });
  assert.deepEqual(r.porIdade, { hoje: 1, "um-a-tres": 1, "mais-de-tres": 1 });
});

test("DMs viram só contagem: não entram no ranking nem nas séries de grupos", () => {
  const chats = [
    { id: "g1", tipo: "grupo", nome: "Grupo A" },
    { id: "g2", tipo: "comunidade", nome: "Grupo B" },
    { id: "d1", tipo: "direto", nome: "Pessoa Fictícia" },
  ];
  const dias = ultimosDias(2, AGORA);
  const msg = (chat_id: string) => ({ chat_id, instante: "2026-10-08T14:00:00Z" });
  const r = agregarAtividade(chats, [msg("g1"), msg("g1"), msg("g2"), msg("d1"), msg("d1"), msg("d1")], [msg("g1"), msg("d1")], dias);
  assert.deepEqual(r.chatsAtivos, [
    { id: "g1", nome: "Grupo A", mensagens: 2 },
    { id: "g2", nome: "Grupo B", mensagens: 1 },
  ]);
  assert.equal(r.mensagensGrupos[1].total, 3);
  assert.equal(r.linksGrupos[1].total, 1);
  assert.deepEqual(r.diretos, { conversas: 1, mensagens: 3 });
  assert.ok(!JSON.stringify(r).includes("Pessoa Fictícia"));
});

function falso(respostas: Record<string, { data: unknown; error: unknown }>) {
  const construtor = (alvo: string) => {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") return (res: (v: unknown) => void) => res(respostas[alvo] ?? { data: [], error: null });
          return () => proxy;
        },
      },
    );
    return proxy;
  };
  return { schema: () => ({ from: (t: string) => construtor(t) }) } as unknown as SupabaseClient;
}

test("carregarDashboard agrega as views e devolve erro amigável sem lançar", async () => {
  const c = falso({
    v_chats_resumo: { data: [{ id: "g1", tipo: "grupo", nome: "Grupo A" }, { id: "d1", tipo: "direto", nome: "Pessoa" }], error: null },
    mensagens: { data: [{ chat_id: "g1", enviada_em: "2026-10-08T14:00:00Z" }, { chat_id: "d1", enviada_em: "2026-10-08T14:00:00Z" }], error: null },
    v_links: { data: [{ chat_id: "g1", compartilhado_em: "2026-10-08T14:00:00Z" }], error: null },
    v_pendencias: { data: [{ urgencia: "media", espera_desde: "2026-10-08T10:00:00Z", status: "aberta" }], error: null },
  });
  const r = await carregarDashboard(c, AGORA);
  assert.ok(r.ok);
  assert.equal(r.dados.dias.length, 14);
  assert.equal(r.dados.chatsAtivos[0].mensagens, 1);
  assert.deepEqual(r.dados.diretos, { conversas: 1, mensagens: 1 });
  assert.equal(r.dados.pendencias.porUrgencia.media, 1);
  assert.equal(r.dados.truncado, false);

  const erro = await carregarDashboard(falso({ v_chats_resumo: { data: null, error: { code: "PGRST106", message: "Invalid schema: wa" } } }), AGORA);
  assert.equal(erro.ok, false);
});
