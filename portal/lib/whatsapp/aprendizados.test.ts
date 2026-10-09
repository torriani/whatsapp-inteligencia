import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  agruparPorTema, casaBusca, contarPor, filtrarAprendizados, lerParametrosAprendizados, lerTemasConfig,
  SEM_TEMA, statusDecisao, temasParaTexto, textoParaTemas,
} from "./aprendizados";
import { carregarAprendizadosPorTema, decidirAprendizado, salvarTemasAprendizado } from "./dados";
import type { Aprendizado } from "./tipos";

const G1 = "11111111-1111-4111-8111-111111111111";
const G2 = "22222222-2222-4222-8222-222222222222";

function ap(id: number, extra: Partial<Aprendizado> = {}): Aprendizado {
  return {
    id, chat_id: G1, chat_nome: "Grupo A", titulo: `Titulo ${id}`, corpo: `Corpo ${id}`, tags: null, fontes: [1], confianca: 3,
    status: "candidato", criado_em: `2026-10-0${id}T10:00:00Z`, atualizado_em: "2026-10-08T10:00:00Z", tema: "Agentes", motivo_descarte: null, ...extra,
  };
}

const TEMAS = [{ nome: "Agentes", descricao: "" }, { nome: "Vendas", descricao: "vender mais" }];

test("parâmetros: visão, tema, grupo e busca com limites", () => {
  assert.deepEqual(lerParametrosAprendizados({}), { visao: "temas", tema: "", grupo: "", q: "" });
  assert.equal(lerParametrosAprendizados({ visao: "resumos" }).visao, "resumos");
  assert.equal(lerParametrosAprendizados({ visao: "x" }).visao, "temas");
  assert.equal(lerParametrosAprendizados({ q: " AIOX " }).q, "AIOX");
  assert.equal(lerParametrosAprendizados({ q: "a".repeat(500) }).q.length, 80);
});

test("busca ignora acento e caixa, exige todas as palavras e olha tema e tags", () => {
  const a = ap(1, { corpo: "O AIOX organiza agentes por Orquestração", tags: ["Segundo-Cérebro"], tema: "Empresa agêntica" });
  assert.ok(casaBusca(a, "aiox"));
  assert.ok(casaBusca(a, "orquestracao AIOX"));
  assert.ok(casaBusca(a, "segundo cerebro".replace(" ", "-")));
  assert.ok(casaBusca(a, "agentica"));
  assert.equal(casaBusca(a, "aiox vendas"), false);
  assert.ok(casaBusca(a, "   "));
});

test("filtrar: tema, grupo, busca, sem descartados, mais recente primeiro", () => {
  const lista = [
    ap(1), ap(2, { tema: "Vendas" }), ap(3, { chat_id: G2, chat_nome: "Grupo B" }), ap(4, { status: "descartado" }), ap(5, { tema: null, corpo: "fala do AIOX" }),
  ];
  assert.deepEqual(filtrarAprendizados(lista, { tema: "", grupo: "", q: "" }).map((a) => a.id), [5, 3, 2, 1]);
  assert.deepEqual(filtrarAprendizados(lista, { tema: "Vendas", grupo: "", q: "" }).map((a) => a.id), [2]);
  assert.deepEqual(filtrarAprendizados(lista, { tema: "", grupo: G2, q: "" }).map((a) => a.id), [3]);
  assert.deepEqual(filtrarAprendizados(lista, { tema: SEM_TEMA, grupo: "", q: "" }).map((a) => a.id), [5]);
  assert.deepEqual(filtrarAprendizados(lista, { tema: "", grupo: "", q: "aiox" }).map((a) => a.id), [5]);
});

test("agrupar segue a ordem da lista de temas, extras e sem tema ao fim, e omite temas vazios", () => {
  const itens = [ap(1, { tema: "Vendas" }), ap(2, { tema: "Antigo" }), ap(3, { tema: null }), ap(4, { tema: "Vendas" })];
  const g = agruparPorTema(itens, TEMAS);
  assert.deepEqual(g.map((x) => [x.tema, x.itens.length]), [["Vendas", 2], ["Antigo", 1], [SEM_TEMA, 1]]);
  assert.deepEqual(contarPor(["Vendas", null, "Vendas"]), new Map([["Vendas", 2], [SEM_TEMA, 1]]));
});

test("editor de temas: ida e volta e validações", () => {
  assert.equal(temasParaTexto(TEMAS), "Agentes\nVendas: vender mais");
  const ok = textoParaTemas("Agentes\n\nVendas: vender mais, anunciar");
  assert.ok(ok.ok && ok.temas.length === 2 && ok.temas[1].descricao === "vender mais, anunciar");
  assert.equal(textoParaTemas("").ok, false);
  assert.equal(textoParaTemas("A\na").ok, false);
  assert.equal(textoParaTemas("Sem tema").ok, false);
  assert.equal(textoParaTemas("A: b \u2014 c").ok, false);
  assert.equal(textoParaTemas("x".repeat(61)).ok, false);
  assert.equal(textoParaTemas(Array.from({ length: 31 }, (_, i) => `T${i}`).join("\n")).ok, false);
});

test("config: formato inesperado vira lista vazia e aceita texto simples", () => {
  assert.deepEqual(lerTemasConfig(null), []);
  assert.deepEqual(lerTemasConfig(["A", { nome: "B", descricao: "d" }, { nome: "a" }, {}]), [{ nome: "A", descricao: "" }, { nome: "B", descricao: "d" }]);
  assert.equal(statusDecisao("aprovado"), "aprovado");
  assert.equal(statusDecisao("candidato"), null);
});

type Chamada = { alvo: string; passos: [string, unknown[]][] };
function falso(respostas: Record<string, { data: unknown; error: unknown }>, chamadas: Chamada[] = []) {
  const client = {
    schema: () => ({
      from: (alvo: string) => {
        const c: Chamada = { alvo, passos: [] };
        chamadas.push(c);
        const proxy: unknown = new Proxy({}, {
          get(_t, prop: string) {
            if (prop === "then") return (res: (v: unknown) => void) => res(respostas[alvo] ?? { data: [], error: null });
            return (...args: unknown[]) => { c.passos.push([prop, args]); return proxy; };
          },
        });
        return proxy;
      },
    }),
  };
  return client as unknown as SupabaseClient;
}

test("carregar: lê view sem descartados, temas da config e grupos com aprendizado", async () => {
  const chamadas: Chamada[] = [];
  const r = await carregarAprendizadosPorTema(falso({
    v_aprendizados: { data: [ap(1), ap(2, { chat_id: G2, chat_nome: "Grupo B" })], error: null },
    config: { data: { valor: [{ nome: "Agentes", descricao: "x" }] }, error: null },
  }, chamadas));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.dados.temas, [{ nome: "Agentes", descricao: "x" }]);
  assert.deepEqual(r.dados.grupos.map((g) => g.nome), ["Grupo A", "Grupo B"]);
  const v = chamadas.find((c) => c.alvo === "v_aprendizados")!;
  assert.ok(v.passos.some(([n, a]) => n === "neq" && a[0] === "status" && a[1] === "descartado"));
  assert.ok(v.passos.some(([n, a]) => n === "order" && a[0] === "criado_em"));
  const c = chamadas.find((x) => x.alvo === "config")!;
  assert.ok(c.passos.some(([n, a]) => n === "eq" && a[0] === "chave" && a[1] === "aprendizado_temas"));
});

test("carregar: erro do banco vira Resultado de erro", async () => {
  const r = await carregarAprendizadosPorTema(falso({ v_aprendizados: { data: null, error: { message: "falhou" } } }));
  assert.equal(r.ok, false);
});

test("decidir: só muda status, nunca em descartado, e recusa id inválido", async () => {
  const chamadas: Chamada[] = [];
  const ok = await decidirAprendizado(falso({ aprendizados: { data: [{ id: 3 }], error: null } }, chamadas), 3, "aprovado");
  assert.ok(ok.ok);
  const p = chamadas[0].passos;
  assert.deepEqual(p.find(([n]) => n === "update")![1][0], { status: "aprovado" });
  assert.ok(p.some(([n, a]) => n === "neq" && a[0] === "status" && a[1] === "descartado"));
  assert.equal((await decidirAprendizado(falso({ aprendizados: { data: [], error: null } }), 3, "descartado")).ok, false);
  assert.equal((await decidirAprendizado(falso({}), 0, "aprovado")).ok, false);
});

test("salvar temas: update só do valor da chave certa", async () => {
  const chamadas: Chamada[] = [];
  const r = await salvarTemasAprendizado(falso({ config: { data: [{ chave: "aprendizado_temas" }], error: null } }, chamadas), TEMAS);
  assert.ok(r.ok);
  const p = chamadas[0].passos;
  assert.deepEqual(p.find(([n]) => n === "update")![1][0], { valor: TEMAS });
  assert.ok(p.some(([n, a]) => n === "eq" && a[0] === "chave" && a[1] === "aprendizado_temas"));
  assert.equal((await salvarTemasAprendizado(falso({ config: { data: [], error: null } }), TEMAS)).ok, false);
});
