import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  LIMITE_MENSAGENS,
  agruparDominios,
  atualizarStatusPendencia,
  aprovarRespostaPendencia,
  cancelarRespostaPendencia,
  carregarEnvioRespostasAtivo,
  carregarKillSwitchLigado,
  carregarTextosAprovados,
  liberarReaprovacaoResposta,
  definirEnvioRespostasAtivo,
  erroDeRpc,
  validarTextoResposta,
  carregarChatsLiberados,
  carregarPendencias,
  dataDoAlvoDigestDm,
  motivoDoDetalhe,
  extrairDigestsDm,
  ordenarPendencias,
  statusPendenciaFinal,
  carregarAprendizados,
  carregarChat,
  carregarConfiguracoes,
  carregarLinks,
  carregarResumosEnviados,
  definirFavoritoLink,
  carregarVisaoGeral,
  derivarStatusEnvio,
  listarMensagens,
  sanitizarBusca,
} from "./dados";

type Chamada = { alvo: string; passos: [string, unknown[]][] };

/** Cliente falso: grava a cadeia de chamadas e devolve a resposta registrada por alvo. */
function falso(respostas: Record<string, { data: unknown; error: unknown }>, chamadas: Chamada[] = []) {
  function construtor(alvo: string) {
    const c: Chamada = { alvo, passos: [] };
    chamadas.push(c);
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") {
            const r = respostas[alvo] ?? { data: [], error: null };
            return (res: (v: unknown) => void) => res(r);
          }
          return (...args: unknown[]) => {
            c.passos.push([prop, args]);
            return proxy;
          };
        },
      },
    );
    return proxy;
  }
  const client = {
    schema(s: string) {
      assert.equal(s, "wa");
      return {
        from: (t: string) => construtor(t),
        rpc: (fn: string, args: unknown) => {
          const c: Chamada = { alvo: `rpc:${fn}`, passos: [["args", [args]]] };
          chamadas.push(c);
          return Promise.resolve(respostas[`rpc:${fn}`] ?? { data: [], error: null });
        },
      };
    },
  };
  return client as unknown as SupabaseClient;
}

const CHAT = {
  id: "11111111-1111-4111-8111-111111111111",
  jid: "x@g.us",
  tipo: "grupo",
  nome: "Grupo Fictício A",
  categoria: null,
  modo: "inteligencia",
  ultima_msg_em: "2026-10-07T14:00:00Z",
  liberado_em: "2026-10-01T00:00:00Z",
  retencao_dias: null,
  n_mensagens: 10,
  n_mensagens_24h: 4,
  n_links: 2,
  n_perguntas_abertas: 1,
  n_aprendizados: 1,
  resumo_id: 7,
  resumo_data_ref: "2026-10-06",
  resumo_discutido: ["tema um"],
  resumo_decidido: [],
  resumo_olhar: ["ponto de atenção"],
  resumo_n_mensagens: 8,
  resumo_gerado_em: "2026-10-07T03:00:00Z",
};

test("visão geral filtra chats liberados e traz a última ingestão", async () => {
  const chamadas: Chamada[] = [];
  const c = falso(
    {
      v_chats_resumo: { data: [CHAT], error: null },
      ingestao_execucoes: { data: [{ id: 1, iniciou_em: "2026-10-07T14:50:00Z", terminou_em: "2026-10-07T14:51:00Z", lidas: 5, gravadas: 5, descartadas_sensivel: 0, erro: null }], error: null },
    },
    chamadas,
  );
  const r = await carregarVisaoGeral(c);
  assert.ok(r.ok);
  assert.equal(r.dados.chats.length, 1);
  assert.equal(r.dados.ultimaIngestao?.lidas, 5);
  const passosChats = chamadas.find((x) => x.alvo === "v_chats_resumo")!.passos;
  assert.ok(passosChats.some(([n, a]) => n === "neq" && a[0] === "modo" && a[1] === "off"));
});

test("visão geral vazia: sem chats e sem ingestão", async () => {
  const r = await carregarVisaoGeral(falso({}));
  assert.ok(r.ok);
  assert.deepEqual(r.dados.chats, []);
  assert.equal(r.dados.ultimaIngestao, null);
});

test("erro de schema não exposto vira Resultado de erro, sem lançar", async () => {
  const r = await carregarVisaoGeral(falso({ v_chats_resumo: { data: null, error: { code: "PGRST106", message: "Invalid schema: wa" } } }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.erro, /não está exposto/);
});

test("chat desligado (off) é tratado como inexistente", async () => {
  const off = falso({ v_chats_resumo: { data: { ...CHAT, modo: "off" }, error: null } });
  const r = await carregarChat(off, CHAT.id);
  assert.ok(r.ok);
  assert.equal(r.dados, null);
});

test("listarMensagens usa a RPC com argumentos nomeados e gera cursor quando a página está cheia", async () => {
  const chamadas: Chamada[] = [];
  const linhas = Array.from({ length: LIMITE_MENSAGENS }, (_, i) => ({
    id: 1000 - i,
    chat_id: CHAT.id,
    enviada_em: new Date(Date.UTC(2026, 9, 7, 12, 0, 0) - i * 60000).toISOString(),
    autor_id: null, autor_nome: "Pessoa Fictícia", do_dono: false, tipo: 0, texto: `msg ${i}`,
    redigida: false, apagada: false, tem_midia: false, midia_meta: null, transcrito: false, responde_a: null,
  }));
  const c = falso({ "rpc:listar_mensagens": { data: linhas, error: null } }, chamadas);
  const r = await listarMensagens(c, { chatId: CHAT.id, busca: "  termo " });
  assert.ok(r.ok);
  assert.equal(r.dados.mensagens.length, LIMITE_MENSAGENS);
  assert.equal(r.dados.proximo?.antesId, linhas[linhas.length - 1].id);
  const args = chamadas[0].passos[0][1][0] as Record<string, unknown>;
  assert.equal(args.p_busca, "termo");
  assert.equal(args.p_chat_id, CHAT.id);
  assert.equal(args.p_limite, LIMITE_MENSAGENS);
});

test("listarMensagens corta no piso do período e encerra a paginação", async () => {
  const linhas = [
    { id: 3, enviada_em: "2026-10-05T12:00:00Z" },
    { id: 2, enviada_em: "2026-10-04T12:00:00Z" },
    { id: 1, enviada_em: "2026-09-30T12:00:00Z" },
  ].map((m) => ({ ...m, chat_id: CHAT.id, autor_id: null, autor_nome: null, do_dono: false, tipo: 0, texto: "x", redigida: false, apagada: false, tem_midia: false, midia_meta: null, transcrito: false, responde_a: null }));
  const c = falso({ "rpc:listar_mensagens": { data: linhas, error: null } });
  const r = await listarMensagens(c, { chatId: CHAT.id, desde: "2026-10-01T03:00:00.000Z" });
  assert.ok(r.ok);
  assert.deepEqual(r.dados.mensagens.map((m) => m.id), [3, 2]);
  assert.equal(r.dados.proximo, null);
});

test("links: aplica filtros e sinaliza truncamento", async () => {
  const chamadas: Chamada[] = [];
  const links = Array.from({ length: 501 }, (_, i) => ({ id: i, dominio: "exemplo.com", vezes: 1 }));
  const c = falso({ v_links: { data: links, error: null } }, chamadas);
  const r = await carregarLinks(c, { chatId: CHAT.id, dominio: "exemplo.com", busca: "a,b)(*" });
  assert.ok(r.ok);
  assert.equal(r.dados.links.length, 500);
  assert.equal(r.dados.truncado, true);
  const passos = chamadas[0].passos;
  assert.ok(passos.some(([n, a]) => n === "eq" && a[0] === "chat_id"));
  assert.ok(passos.some(([n, a]) => n === "eq" && a[0] === "dominio"));
  const ou = passos.find(([n]) => n === "or")!;
  assert.doesNotMatch(String(ou[1][0]), /\(|\)|,b/);
});

test("sanitizarBusca e agruparDominios", () => {
  assert.equal(sanitizarBusca(' a,b(c)*"d" '), "a b c d");
  assert.deepEqual(
    agruparDominios([{ dominio: "a.com", vezes: 3 }, { dominio: "b.com", vezes: 1 }, { dominio: "b.com", vezes: 1 }]),
    [{ dominio: "a.com", total: 3 }, { dominio: "b.com", total: 2 }],
  );
});

test("aprendizados são agrupados por chat", async () => {
  const outro = { ...CHAT, id: "22222222-2222-4222-8222-222222222222", nome: "Grupo Fictício B" };
  const c = falso({
    v_chats_resumo: { data: [CHAT, outro], error: null },
    resumos: { data: [{ id: 1, chat_id: outro.id, periodo: "semana", data_ref: "2026-10-05", discutido: ["x"], decidido: [], olhar: [], n_mensagens: 3, gerado_em: "2026-10-06T00:00:00Z" }], error: null },
    decisoes: { data: [{ id: 1, chat_id: CHAT.id, resumo_id: null, texto: "decisão fictícia", decidida_em: null, responsavel: null }], error: null },
    perguntas: { data: [], error: null },
    v_aprendizados: { data: [{ id: 1, chat_id: CHAT.id, chat_nome: CHAT.nome, titulo: "t", corpo: "c", tags: null, fontes: [1], confianca: 3, status: "candidato", criado_em: "", atualizado_em: "" }], error: null },
  });
  const r = await carregarAprendizados(c);
  assert.ok(r.ok);
  const a = r.dados.find((x) => x.chat.id === CHAT.id)!;
  const b = r.dados.find((x) => x.chat.id === outro.id)!;
  assert.equal(a.aprendizados.length, 1);
  assert.equal(a.decisoes.length, 1);
  assert.equal(a.resumoSemana, null);
  assert.equal(b.aprendizados.length, 0);
  assert.equal(b.resumoSemana?.periodo, "semana");
});

test("status de envio do resumo", () => {
  assert.deepEqual(derivarStatusEnvio(5, [{ alvo: "5", quando: "2026-10-07T10:00:00Z" }], { ativo: true }), { status: "enviado", enviadoEm: "2026-10-07T10:00:00Z" });
  assert.equal(derivarStatusEnvio(5, [], { ativo: false }).status, "destino-inativo");
  assert.equal(derivarStatusEnvio(5, [], null).status, "destino-inativo");
  assert.equal(derivarStatusEnvio(5, [{ alvo: "6", quando: "x" }], { ativo: true }).status, "aguardando");
});

test("resumos enviados e configurações vazios não quebram", async () => {
  const r = await carregarResumosEnviados(falso({ notificacao_destino: { data: null, error: null } }));
  assert.ok(r.ok);
  assert.deepEqual(r.dados.linhas, []);
  const cfg = await carregarConfiguracoes(falso({ notificacao_destino: { data: { jid: null, nome: null, ativo: false, atualizado_em: "2026-10-07T00:00:00Z" }, error: null } }));
  assert.ok(cfg.ok);
  assert.equal(cfg.dados.destino?.ativo, false);
});

test("pendências: ordena por urgência e, dentro dela, pela espera mais antiga", () => {
  const l = [
    { id: 1, urgencia: "baixa", espera_desde: "2026-10-01T00:00:00Z" },
    { id: 2, urgencia: "alta", espera_desde: "2026-10-06T00:00:00Z" },
    { id: 3, urgencia: "alta", espera_desde: "2026-10-05T00:00:00Z" },
    { id: 4, urgencia: "media", espera_desde: "2026-10-02T00:00:00Z" },
  ] as const;
  assert.deepEqual(ordenarPendencias([...l]).map((x) => x.id), [3, 2, 4, 1]);
});

test("pendências: lê só abertas de wa.v_pendencias e devolve ordenado", async () => {
  const chamadas: Chamada[] = [];
  const c = falso({ v_pendencias: { data: [{ id: 1, urgencia: "baixa", espera_desde: "2026-10-01T00:00:00Z" }, { id: 2, urgencia: "alta", espera_desde: "2026-10-02T00:00:00Z" }], error: null } }, chamadas);
  const r = await carregarPendencias(c);
  assert.ok(r.ok);
  assert.deepEqual(r.dados.map((x) => x.id), [2, 1]);
  assert.ok(chamadas[0].passos.some(([n, a]) => n === "eq" && a[0] === "status" && a[1] === "aberta"));
});

test("pendências: atualizar status só aceita respondida ou descartada e só fecha aberta", async () => {
  assert.equal(statusPendenciaFinal("aberta"), null);
  assert.equal(statusPendenciaFinal("apagada"), null);
  assert.equal(statusPendenciaFinal("descartada"), "descartada");
  const chamadas: Chamada[] = [];
  const ok = await atualizarStatusPendencia(falso({ pendencias_resposta: { data: [{ id: 9 }], error: null } }, chamadas), 9, "respondida");
  assert.ok(ok.ok);
  const passos = chamadas[0].passos;
  assert.deepEqual(passos.find(([n]) => n === "update")![1][0], { status: "respondida" });
  assert.ok(passos.some(([n, a]) => n === "eq" && a[0] === "status" && a[1] === "aberta"));
  const negado = await atualizarStatusPendencia(falso({ pendencias_resposta: { data: [], error: null } }), 9, "descartada");
  assert.equal(negado.ok, false);
  const invalido = await atualizarStatusPendencia(falso({}), -1, "descartada");
  assert.equal(invalido.ok, false);
});

test("chats: filtro de tipo separa DMs de grupos", async () => {
  const g: Chamada[] = [];
  await carregarChatsLiberados(falso({}, g), "grupos");
  assert.ok(g[0].passos.some(([n, a]) => n === "in" && a[0] === "tipo" && (a[1] as string[]).join() === "grupo,comunidade"));
  const d: Chamada[] = [];
  await carregarChatsLiberados(falso({}, d), "direto");
  assert.ok(d[0].passos.some(([n, a]) => n === "eq" && a[0] === "tipo" && a[1] === "direto"));
});

test("links: exclui chats diretos da busca global", async () => {
  const chamadas: Chamada[] = [];
  const dm = "33333333-3333-4333-8333-333333333333";
  const c = falso({ chats: { data: [{ id: dm }], error: null }, v_links: { data: [], error: null } }, chamadas);
  const r = await carregarLinks(c, { busca: "x" });
  assert.ok(r.ok);
  const links = chamadas.find((x) => x.alvo === "v_links")!;
  assert.ok(links.passos.some(([n, a]) => n === "not" && a[0] === "chat_id" && a[1] === "in" && String(a[2]).includes(dm)));
});

test("digest-dm: status real, motivo e fora dos resumos de grupo", async () => {
  assert.equal(dataDoAlvoDigestDm("digest-dm:2026-10-06"), "2026-10-06");
  assert.equal(dataDoAlvoDigestDm("12"), null);
  assert.equal(dataDoAlvoDigestDm("digest-dm:lixo"), null);
  assert.equal(dataDoAlvoDigestDm(null), null);
  assert.equal(motivoDoDetalhe({ motivo: "destino inativo" }), "destino inativo");
  assert.equal(motivoDoDetalhe("falhou"), "falhou");
  assert.equal(motivoDoDetalhe(null), null);
  const aud = [
    { alvo: "digest-dm:2026-10-05", quando: "2026-10-05T11:00:00Z", acao: "resumo_enviado", detalhe: null },
    { alvo: "digest-dm:2026-10-06", quando: "2026-10-06T11:00:00Z", acao: "resumo_enviado", detalhe: null },
    { alvo: "digest-dm:2026-10-06", quando: "2026-10-06T12:00:00Z", acao: "resumo_nao_enviado", detalhe: { motivo: "destino inativo" } },
    { alvo: "5", quando: "2026-10-06T09:00:00Z", acao: "resumo_enviado", detalhe: null },
  ];
  assert.deepEqual(extrairDigestsDm(aud), [
    { data: "2026-10-06", enviado: false, em: "2026-10-06T12:00:00Z", motivo: "destino inativo" },
    { data: "2026-10-05", enviado: true, em: "2026-10-05T11:00:00Z", motivo: null },
  ]);
  assert.equal(derivarStatusEnvio(5, aud, { ativo: true }).enviadoEm, "2026-10-06T09:00:00Z");
  const resposta = {
    auditoria: { data: aud.map((a, i) => ({ id: i, ator: "worker", ...a })), error: null },
    notificacao_destino: { data: null, error: null },
    chats: { data: [{ id: "g1", nome: "Grupo", tipo: "grupo" }, { id: "d1", nome: "Fulano", tipo: "direto" }], error: null },
    resumos: { data: [{ id: 5, chat_id: "g1", periodo: "dia" }, { id: 6, chat_id: "d1", periodo: "dia" }], error: null },
  };
  const r = await carregarResumosEnviados(falso(resposta));
  assert.ok(r.ok);
  assert.equal(r.dados.digestsDm.length, 2);
  assert.deepEqual(r.dados.linhas.map((l) => l.resumo.id), [5]);
});

test("links: favoritos filtram por favorito e ordenam pelo favoritado mais recente", async () => {
  const chamadas: Chamada[] = [];
  const c = falso({ v_links: { data: [{ id: 2, favorito: true, favoritado_em: "2026-10-08T10:00:00Z" }], error: null } }, chamadas);
  const r = await carregarLinks(c, { favoritos: true, busca: "x" });
  assert.ok(r.ok);
  const passos = chamadas.find((x) => x.alvo === "v_links")!.passos;
  assert.ok(passos.some(([n, a]) => n === "eq" && a[0] === "favorito" && a[1] === true));
  assert.ok(passos.some(([n, a]) => n === "order" && a[0] === "favoritado_em" && (a[1] as { ascending: boolean }).ascending === false));
  assert.ok(!passos.some(([n, a]) => n === "order" && a[0] === "compartilhado_em"));
  assert.ok(passos.some(([n]) => n === "or"), "a busca continua valendo");
});

test("links: sem favoritos mantém a ordem por data de compartilhamento", async () => {
  const chamadas: Chamada[] = [];
  await carregarLinks(falso({}, chamadas), { chatId: CHAT.id });
  const passos = chamadas.find((x) => x.alvo === "v_links")!.passos;
  assert.ok(passos.some(([n, a]) => n === "order" && a[0] === "compartilhado_em"));
  assert.ok(!passos.some(([n, a]) => n === "eq" && a[0] === "favorito"));
});

test("links: definirFavoritoLink grava só favorito e rejeita id inválido ou sem permissão", async () => {
  assert.equal((await definirFavoritoLink(falso({}), 0, true)).ok, false);
  assert.equal((await definirFavoritoLink(falso({}), 1.5, true)).ok, false);
  const chamadas: Chamada[] = [];
  const ok = await definirFavoritoLink(falso({ links: { data: [{ id: 7 }], error: null } }, chamadas), 7, true);
  assert.ok(ok.ok);
  const up = chamadas.find((x) => x.alvo === "links")!.passos.find(([n]) => n === "update")!;
  assert.deepEqual(up[1][0], { favorito: true });
  const negado = await definirFavoritoLink(falso({ links: { data: [], error: null } }), 7, false);
  assert.equal(negado.ok, false);
});

test("resposta: texto é só aparado, vazio e longo demais são recusados", () => {
  assert.deepEqual(validarTextoResposta("  Oi, tudo bem?  "), { ok: true, texto: "Oi, tudo bem?" });
  assert.equal(validarTextoResposta("   ").ok, false);
  assert.equal(validarTextoResposta(null).ok, false);
  assert.equal(validarTextoResposta("a".repeat(4001)).ok, false);
});

test("resposta: aprovar chama a RPC com o texto exato e repassa erro do banco", async () => {
  const chamadas: Chamada[] = [];
  const ok = await aprovarRespostaPendencia(falso({ "rpc:aprovar_resposta_pendencia": { data: 7, error: null } }, chamadas), 3, " Texto fictício ");
  assert.ok(ok.ok && ok.dados === 7);
  assert.deepEqual(chamadas[0].passos[0][1][0], { p_pendencia_id: 3, p_texto: "Texto fictício" });
  const neg = await aprovarRespostaPendencia(
    falso({ "rpc:aprovar_resposta_pendencia": { data: null, error: { message: "wa.aprovar_resposta_pendencia: envio de respostas desligado", code: "P0001" } } }),
    3, "x",
  );
  assert.ok(!neg.ok && neg.erro === "envio de respostas desligado");
  assert.equal((await aprovarRespostaPendencia(falso({}), 0, "x")).ok, false);
  const vazio: Chamada[] = [];
  assert.equal((await aprovarRespostaPendencia(falso({}, vazio), 3, "  ")).ok, false);
  assert.equal(vazio.length, 0, "texto vazio não chega ao banco");
});

test("resposta: erro desconhecido do banco não vaza mensagem crua", () => {
  assert.ok(!erroDeRpc({ message: "relation wa.x contém dado secreto", code: "XX000" }).includes("secreto"));
});

test("resposta: cancelar devolve false quando já foi iniciado", async () => {
  const r = await cancelarRespostaPendencia(falso({ "rpc:cancelar_resposta_pendencia": { data: false, error: null } }), 5);
  assert.ok(r.ok && r.dados === false);
  assert.equal((await cancelarRespostaPendencia(falso({}), -1)).ok, false);
});

test("resposta: chave de envio é desligada por padrão e só true liga", async () => {
  assert.deepEqual(await carregarEnvioRespostasAtivo(falso({ config: { data: [], error: null } })), { ok: true, dados: false });
  assert.deepEqual(await carregarEnvioRespostasAtivo(falso({ config: { data: [{ valor: "true" }], error: null } })), { ok: true, dados: false });
  assert.deepEqual(await carregarEnvioRespostasAtivo(falso({ config: { data: [{ valor: true }], error: null } })), { ok: true, dados: true });
  const chamadas: Chamada[] = [];
  const u = await definirEnvioRespostasAtivo(falso({ config: { data: [{ chave: "ENVIO_RESPOSTAS_ATIVO" }], error: null } }, chamadas), true);
  assert.ok(u.ok);
  assert.deepEqual(chamadas[0].passos.find(([n]) => n === "update")![1][0], { valor: true });
});

test("resposta: kill switch falha fechada (só false libera)", async () => {
  const lido = (valor: unknown) => carregarKillSwitchLigado(falso({ config: { data: [{ valor }], error: null } }));
  assert.deepEqual(await lido(false), { ok: true, dados: false });
  for (const v of [true, "false", "true", null, 0]) assert.deepEqual(await lido(v), { ok: true, dados: true });
  assert.deepEqual(await carregarKillSwitchLigado(falso({ config: { data: [], error: null } })), { ok: true, dados: true });
});

test("resposta: textos aprovados vêm por id e ids inválidos são ignorados", async () => {
  const chamadas: Chamada[] = [];
  const r = await carregarTextosAprovados(falso({ fila_envio: { data: [{ id: 4, texto: "Texto fictício" }], error: null } }, chamadas), [4, -1, 1.5]);
  assert.deepEqual(r, { ok: true, dados: { 4: "Texto fictício" } });
  assert.deepEqual(chamadas[0].passos.find(([n]) => n === "in")![1], ["id", [4]]);
  const vazio: Chamada[] = [];
  assert.deepEqual(await carregarTextosAprovados(falso({}, vazio), []), { ok: true, dados: {} });
  assert.equal(vazio.length, 0);
});

test("resposta: liberar reaprovação chama a função do banco e valida o id", async () => {
  const chamadas: Chamada[] = [];
  const r = await liberarReaprovacaoResposta(falso({ "rpc:liberar_reaprovacao": { data: true, error: null } }, chamadas), 9);
  assert.ok(r.ok && r.dados === true);
  assert.deepEqual(chamadas[0].passos[0][1], [{ p_fila_id: 9 }]);
  assert.equal((await liberarReaprovacaoResposta(falso({}), 0)).ok, false);
});
