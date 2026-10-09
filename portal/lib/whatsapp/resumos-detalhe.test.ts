import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ordenarLinhasResumos } from "./dados";
import {
  NOME_NAO_IDENTIFICADO,
  carregarDigestDetalhe,
  carregarResumoDetalhe,
  derivarEnvioDetalhe,
  idDetalheDigest,
  lerIdDetalhe,
  nomeExibivel,
} from "./resumos-detalhe";

function falso(respostas: Record<string, { data: unknown; error: unknown }>) {
  const construtor = (alvo: string) => {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") {
            const r = respostas[alvo] ?? { data: [], error: null };
            return (res: (v: unknown) => void) => res(r);
          }
          return () => proxy;
        },
      },
    );
    return proxy;
  };
  return { schema: () => ({ from: (t: string) => construtor(t) }) } as unknown as SupabaseClient;
}

test("lista: data decrescente, empate pelo mais recém-gerado", () => {
  const l = [
    { resumo: { data_ref: "2026-10-05", gerado_em: "2026-10-06T10:00:00Z" }, k: "a" },
    { resumo: { data_ref: "2026-10-07", gerado_em: "2026-10-08T08:00:00Z" }, k: "b" },
    { resumo: { data_ref: "2026-10-07", gerado_em: "2026-10-08T09:00:00Z" }, k: "c" },
  ];
  assert.deepEqual(ordenarLinhasResumos(l).map((x) => x.k), ["c", "b", "a"]);
});

test("id de detalhe: resumo numérico, digest por data, resto inválido", () => {
  assert.deepEqual(lerIdDetalhe("12"), { tipo: "resumo", id: 12 });
  assert.deepEqual(lerIdDetalhe(idDetalheDigest("2026-10-07")), { tipo: "digest-dm", data: "2026-10-07" });
  for (const ruim of ["0", "-1", "1; drop", "digest-dm-2026-13-45", "digest-dm:2026-10-07", "abc"]) assert.equal(lerIdDetalhe(ruim), null, ruim);
});

test("nome exibível nunca devolve JID, e-mail ou número cru", () => {
  assert.equal(nomeExibivel("5511999999999@s.whatsapp.net", "+55 11 99999-9999"), NOME_NAO_IDENTIFICADO);
  assert.equal(nomeExibivel(null, "Maria Silva"), "Maria Silva");
  assert.equal(nomeExibivel("  João ", "Outro"), "João");
});

test("envio: enviado, não enviado com motivo e sem registro", () => {
  const aud = [
    { alvo: "7", quando: "2026-10-07T10:00:00Z", acao: "resumo_nao_enviado", detalhe: { motivo: "Sessão desconectada" } },
    { alvo: "7", quando: "2026-10-07T11:00:00Z", acao: "resumo_enviado", detalhe: null },
    { alvo: "8", quando: "2026-10-07T10:00:00Z", acao: "resumo_nao_enviado", detalhe: "Falha no envio" },
  ];
  assert.deepEqual(derivarEnvioDetalhe(7, aud, { ativo: true }), { status: "enviado", enviado: true, quando: "2026-10-07T11:00:00Z", motivo: null });
  const nao = derivarEnvioDetalhe(8, aud, { ativo: true });
  assert.equal(nao.enviado, false);
  assert.equal(nao.motivo, "Falha no envio");
  const sem = derivarEnvioDetalhe(9, aud, { ativo: false });
  assert.equal(sem.status, "destino-inativo");
  assert.equal(sem.quando, null);
});

test("detalhe do resumo: lê o texto estruturado, filtra links do dia e bloqueia DM", async () => {
  const resumo = { id: 3, chat_id: "g1", periodo: "dia", data_ref: "2026-10-07", discutido: ["a"], decidido: [], olhar: [], n_mensagens: 4, gerado_em: "2026-10-08T00:00:00Z" };
  const r = await carregarResumoDetalhe(
    falso({
      resumos: { data: resumo, error: null },
      chats: { data: { id: "g1", nome: "Grupo X", tipo: "grupo" }, error: null },
      notificacao_destino: { data: { ativo: true }, error: null },
      v_links: {
        data: [
          { id: 1, url: "https://a.com", compartilhado_em: "2026-10-07T15:00:00Z" },
          { id: 2, url: "https://b.com", compartilhado_em: "2026-10-05T15:00:00Z" },
        ],
        error: null,
      },
    }),
    3,
  );
  assert.ok(r.ok && r.dados);
  assert.equal(r.dados.chatNome, "Grupo X");
  assert.deepEqual(r.dados.resumo.discutido, ["a"]);
  assert.deepEqual(r.dados.links.map((l) => l.id), [1]);
  assert.equal(r.dados.envio.enviado, false);

  const dm = await carregarResumoDetalhe(falso({ resumos: { data: resumo, error: null }, chats: { data: { id: "g1", nome: "Fulano", tipo: "direto" }, error: null } }), 3);
  assert.ok(dm.ok);
  assert.equal(dm.dados, null);
  const nenhum = await carregarResumoDetalhe(falso({ resumos: { data: null, error: null } }), 99);
  assert.ok(nenhum.ok);
  assert.equal(nenhum.dados, null);
});

test("detalhe do digest: pendências só da data, com nome resolvido e urgência primeiro", async () => {
  const r = await carregarDigestDetalhe(
    falso({
      auditoria: { data: [{ alvo: "digest-dm:2026-10-07", quando: "2026-10-07T21:00:00Z", acao: "resumo_nao_enviado", detalhe: { motivo: "Destino inativo" } }], error: null },
      v_pendencias: {
        data: [
          { id: 1, contato_nome: null, chat_nome: "5511988887777@s.whatsapp.net", urgencia: "baixa", espera_desde: "2026-10-06T10:00:00Z", gerado_em: "2026-10-07T15:00:00Z" },
          { id: 2, contato_nome: "Ana", chat_nome: "x", urgencia: "alta", espera_desde: "2026-10-06T11:00:00Z", gerado_em: "2026-10-07T15:00:00Z" },
          { id: 3, contato_nome: "Fora", chat_nome: "y", urgencia: "alta", espera_desde: "2026-10-01T11:00:00Z", gerado_em: "2026-10-03T15:00:00Z" },
        ],
        error: null,
      },
    }),
    "2026-10-07",
  );
  assert.ok(r.ok);
  assert.deepEqual(r.dados.pendencias.map((p) => [p.id, p.nomeExibido]), [[2, "Ana"], [1, NOME_NAO_IDENTIFICADO]]);
  assert.equal(r.dados.digest?.motivo, "Destino inativo");
});
