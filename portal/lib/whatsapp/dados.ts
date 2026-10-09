import type { SupabaseClient } from "@supabase/supabase-js";
import { mensagemErroAmigavel } from "./formato";
import type {
  Aprendizado,
  AuditoriaEnvioResumo,
  ChatResumo,
  Decisao,
  DestinoNotificacao,
  IngestaoExecucao,
  LinkCompartilhado,
  Mensagem,
  Pendencia,
  Pergunta,
  Resultado,
  Resumo,
  StatusPendencia,
  TemaAprendizado,
} from "./tipos";
import type { FiltroTipoChat } from "./parametros";
import { lerTemasConfig } from "./aprendizados";

/**
 * Leitura do schema wa. Sempre com o cliente do usuário logado (RLS = admin).
 * Nenhuma função lança: a tela decide o estado de erro a partir do Resultado.
 */

export const LIMITE_MENSAGENS = 50;
export const LIMITE_LINKS = 500;
/** Ação gravada em wa.auditoria quando um resumo é enviado ao grupo de notificações. */
export const ACAO_RESUMO_ENVIADO = "resumo_enviado";
/** Ação gravada quando o envio de um resumo (ou do digest de DMs) foi tentado e não saiu. */
export const ACAO_RESUMO_NAO_ENVIADO = "resumo_nao_enviado";

type Retorno<T> = { data: T | null; error: { message?: string; code?: string } | null };

function ler<T>(r: Retorno<T>, padrao: T): Resultado<T> {
  if (r.error) return { ok: false, erro: mensagemErroAmigavel(r.error) };
  return { ok: true, dados: r.data ?? padrao };
}

function wa(client: SupabaseClient) {
  return client.schema("wa");
}

const COLUNAS_RESUMO_CHAT = "*";

/**
 * `filtro` separa as mensagens diretas dos grupos: "grupos" traz grupo e comunidade,
 * "direto" só DMs, "todos" não filtra (usado apenas onde o tipo é exibido).
 */
export async function carregarChatsLiberados(client: SupabaseClient, filtro: FiltroTipoChat = "todos"): Promise<Resultado<ChatResumo[]>> {
  let q = wa(client).from("v_chats_resumo").select(COLUNAS_RESUMO_CHAT).neq("modo", "off");
  if (filtro === "direto") q = q.eq("tipo", "direto");
  else if (filtro === "grupos") q = q.in("tipo", ["grupo", "comunidade"]);
  const r = await q.order("nome");
  return ler<ChatResumo[]>(r as Retorno<ChatResumo[]>, []);
}

export type VisaoGeral = { chats: ChatResumo[]; ultimaIngestao: IngestaoExecucao | null };

export async function carregarVisaoGeral(client: SupabaseClient, filtro: FiltroTipoChat = "todos"): Promise<Resultado<VisaoGeral>> {
  const chats = await carregarChatsLiberados(client, filtro);
  if (!chats.ok) return chats;
  const ing = await wa(client).from("ingestao_execucoes").select("*").order("iniciou_em", { ascending: false, nullsFirst: false }).limit(1);
  const lida = ler<IngestaoExecucao[]>(ing as Retorno<IngestaoExecucao[]>, []);
  if (!lida.ok) return lida;
  return { ok: true, dados: { chats: chats.dados, ultimaIngestao: lida.dados[0] ?? null } };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuidValido(valor: string): boolean {
  return UUID.test(valor);
}

/** Retorna null quando o chat não existe ou não está liberado (a página responde 404). */
export async function carregarChat(client: SupabaseClient, chatId: string): Promise<Resultado<ChatResumo | null>> {
  const r = await wa(client).from("v_chats_resumo").select(COLUNAS_RESUMO_CHAT).eq("id", chatId).maybeSingle();
  const lida = ler<ChatResumo | null>(r as Retorno<ChatResumo | null>, null);
  if (!lida.ok) return lida;
  if (lida.dados && lida.dados.modo === "off") return { ok: true, dados: null };
  return lida;
}

export type FiltroMensagens = {
  chatId: string;
  busca?: string;
  /** Limite superior (exclusivo) em ISO: início da primeira página ou cursor. */
  antesEm?: string | null;
  antesId?: number | null;
  /** Limite inferior (inclusivo) em ISO. A RPC não filtra por piso: aplicamos aqui. */
  desde?: string | null;
};

export type PaginaMensagens = {
  mensagens: Mensagem[];
  proximo: { antesEm: string; antesId: number } | null;
};

export async function listarMensagens(client: SupabaseClient, f: FiltroMensagens): Promise<Resultado<PaginaMensagens>> {
  const r = await wa(client).rpc("listar_mensagens", {
    p_chat_id: f.chatId,
    p_antes_em: f.antesEm ?? null,
    p_antes_id: f.antesId ?? null,
    p_limite: LIMITE_MENSAGENS,
    p_busca: f.busca?.trim() ? f.busca.trim() : null,
    p_autor_id: null,
  });
  const lida = ler<Mensagem[]>(r as Retorno<Mensagem[]>, []);
  if (!lida.ok) return lida;
  const linhas = lida.dados;
  const piso = f.desde ? new Date(f.desde).getTime() : null;
  const dentro = piso === null ? linhas : linhas.filter((m) => new Date(m.enviada_em).getTime() >= piso);
  const cruzouPiso = dentro.length < linhas.length;
  const ultima = linhas[linhas.length - 1];
  const pagina = linhas.length === LIMITE_MENSAGENS && !cruzouPiso && ultima;
  return {
    ok: true,
    dados: {
      mensagens: dentro,
      proximo: pagina ? { antesEm: ultima.enviada_em, antesId: ultima.id } : null,
    },
  };
}

export type FiltroLinks = { chatId?: string; busca?: string; dominio?: string; favoritos?: boolean };
export type ListaLinks = { links: LinkCompartilhado[]; truncado: boolean };

/** Remove caracteres que quebram a sintaxe do filtro `or` do PostgREST. */
export function sanitizarBusca(texto: string): string {
  return texto.replace(/[,()*%\\:"']/g, " ").replace(/\s+/g, " ").trim();
}

export async function carregarLinks(client: SupabaseClient, f: FiltroLinks): Promise<Resultado<ListaLinks>> {
  let q = wa(client).from("v_links").select("*");
  // Favoritos: do favoritado mais recente ao mais antigo. Demais: do compartilhado mais recente ao mais antigo.
  q = f.favoritos
    ? q.eq("favorito", true).order("favoritado_em", { ascending: false })
    : q.order("compartilhado_em", { ascending: false });
  q = q.limit(LIMITE_LINKS + 1);
  // DMs nunca entram em links (nem na busca global): exclui os chats diretos.
  const dms = await wa(client).from("chats").select("id").eq("tipo", "direto");
  const dmIds = ler<{ id: string }[]>(dms as Retorno<{ id: string }[]>, []);
  if (!dmIds.ok) return dmIds;
  if (dmIds.dados.length > 0) q = q.not("chat_id", "in", `(${dmIds.dados.map((c) => c.id).join(",")})`);
  if (f.chatId) q = q.eq("chat_id", f.chatId);
  if (f.dominio) q = q.eq("dominio", f.dominio);
  const busca = f.busca ? sanitizarBusca(f.busca) : "";
  if (busca) {
    q = q.or(`url_norm.ilike.*${busca}*,titulo.ilike.*${busca}*,dominio.ilike.*${busca}*,autor_nome.ilike.*${busca}*`);
  }
  const r = await q;
  const lida = ler<LinkCompartilhado[]>(r as Retorno<LinkCompartilhado[]>, []);
  if (!lida.ok) return lida;
  const truncado = lida.dados.length > LIMITE_LINKS;
  return { ok: true, dados: { links: truncado ? lida.dados.slice(0, LIMITE_LINKS) : lida.dados, truncado } };
}

/**
 * Favorita ou desfavorita um link. Usa o cliente do usuário: a RLS (wa.is_admin) e o grant por
 * coluna (só `favorito`) do banco garantem que somente admin altera; favoritado_em é do trigger.
 */
export async function definirFavoritoLink(client: SupabaseClient, id: number, favorito: boolean): Promise<Resultado<null>> {
  if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, erro: "Link inválido." };
  const r = await wa(client).from("links").update({ favorito }).eq("id", id).select("id");
  const lida = ler<{ id: number }[]>(r as Retorno<{ id: number }[]>, []);
  if (!lida.ok) return lida;
  if (lida.dados.length === 0) return { ok: false, erro: "Link não encontrado ou você não tem permissão para alterá-lo." };
  return { ok: true, dados: null };
}

/** Domínios do conjunto de links, do mais frequente ao menos. */
export function agruparDominios(links: Pick<LinkCompartilhado, "dominio" | "vezes">[]): { dominio: string; total: number }[] {
  const mapa = new Map<string, number>();
  for (const l of links) mapa.set(l.dominio, (mapa.get(l.dominio) ?? 0) + Math.max(1, l.vezes));
  return [...mapa.entries()].map(([dominio, total]) => ({ dominio, total })).sort((a, b) => b.total - a.total || a.dominio.localeCompare(b.dominio));
}

export type AprendizadosPorChat = {
  chat: ChatResumo;
  resumoSemana: Resumo | null;
  decisoes: Decisao[];
  perguntas: Pergunta[];
  aprendizados: Aprendizado[];
};

export async function carregarAprendizados(client: SupabaseClient): Promise<Resultado<AprendizadosPorChat[]>> {
  const chats = await carregarChatsLiberados(client, "grupos");
  if (!chats.ok) return chats;
  const [semanas, decisoes, perguntas, aprendizados] = await Promise.all([
    wa(client).from("resumos").select("*").eq("periodo", "semana").order("data_ref", { ascending: false }).limit(200),
    wa(client).from("decisoes").select("*").order("criada_em", { ascending: false }).limit(300),
    wa(client).from("perguntas").select("*").eq("status", "aberta").order("detectada_em", { ascending: false }).limit(300),
    wa(client).from("v_aprendizados").select("*").neq("status", "descartado").order("atualizado_em", { ascending: false }).limit(300),
  ]);
  const s = ler<Resumo[]>(semanas as Retorno<Resumo[]>, []);
  if (!s.ok) return s;
  const d = ler<Decisao[]>(decisoes as Retorno<Decisao[]>, []);
  if (!d.ok) return d;
  const p = ler<Pergunta[]>(perguntas as Retorno<Pergunta[]>, []);
  if (!p.ok) return p;
  const a = ler<Aprendizado[]>(aprendizados as Retorno<Aprendizado[]>, []);
  if (!a.ok) return a;

  return {
    ok: true,
    dados: chats.dados.map((chat) => ({
      chat,
      resumoSemana: s.dados.find((x) => x.chat_id === chat.id) ?? null,
      decisoes: d.dados.filter((x) => x.chat_id === chat.id).slice(0, 10),
      perguntas: p.dados.filter((x) => x.chat_id === chat.id).slice(0, 10),
      aprendizados: a.dados.filter((x) => x.chat_id === chat.id),
    })),
  };
}

export type StatusEnvioResumo = "enviado" | "destino-inativo" | "aguardando";

export type ResumoEnviadoLinha = {
  resumo: Resumo;
  chatNome: string;
  status: StatusEnvioResumo;
  enviadoEm: string | null;
};

/** Digest diário de DMs enviado ao dono: registrado em wa.auditoria (resumo_enviado ou resumo_nao_enviado) com alvo `digest-dm:<data>`. */
export type DigestDmEnviado = { data: string; enviado: boolean; em: string; motivo: string | null };

export type HistoricoResumos = {
  linhas: ResumoEnviadoLinha[];
  destino: DestinoNotificacao | null;
  digestsDm: DigestDmEnviado[];
};

const ALVO_DIGEST_DM = /^digest-dm:(\d{4}-\d{2}-\d{2})$/;

/** O alvo `digest-dm:<data>` não é id de wa.resumos. Retorna a data ou null se não for esse formato. */
export function dataDoAlvoDigestDm(alvo: string | null | undefined): string | null {
  const m = alvo ? ALVO_DIGEST_DM.exec(alvo) : null;
  return m ? m[1] : null;
}

/** Motivo gravado em `detalhe`: texto puro ou objeto com motivo/erro/mensagem. */
export function motivoDoDetalhe(detalhe: unknown): string | null {
  if (typeof detalhe === "string") return detalhe.trim() || null;
  if (detalhe && typeof detalhe === "object") {
    const d = detalhe as Record<string, unknown>;
    for (const chave of ["motivo", "erro", "mensagem"]) {
      const v = d[chave];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return null;
}

/** Um digest por data (o evento mais recente decide o status), da data mais nova para a mais antiga. */
export function extrairDigestsDm(auditorias: Pick<AuditoriaEnvioResumo, "alvo" | "quando" | "acao" | "detalhe">[]): DigestDmEnviado[] {
  const porData = new Map<string, DigestDmEnviado>();
  for (const a of auditorias) {
    const data = dataDoAlvoDigestDm(a.alvo);
    if (!data || (a.acao !== ACAO_RESUMO_ENVIADO && a.acao !== ACAO_RESUMO_NAO_ENVIADO)) continue;
    const atual = porData.get(data);
    if (atual && new Date(a.quando).getTime() <= new Date(atual.em).getTime()) continue;
    const enviado = a.acao === ACAO_RESUMO_ENVIADO;
    porData.set(data, { data, enviado, em: a.quando, motivo: enviado ? null : motivoDoDetalhe(a.detalhe) });
  }
  return [...porData.values()].sort((a, b) => b.data.localeCompare(a.data));
}

/**
 * O contrato do banco v1 não tem tabela de envio de resumos. O status é derivado de
 * wa.auditoria (acao = resumo_enviado, alvo = id do resumo), que o worker de notificação
 * deve gravar ao enviar. Sem esse registro, o resumo aparece como não enviado.
 */
export function derivarStatusEnvio(
  resumoId: number,
  auditorias: Pick<AuditoriaEnvioResumo, "alvo" | "quando">[],
  destino: Pick<DestinoNotificacao, "ativo"> | null,
): { status: StatusEnvioResumo; enviadoEm: string | null } {
  // Só ids numéricos de resumo: alvos como `digest-dm:<data>` pertencem a outra tela.
  const enviado = auditorias.find((a) => a.alvo !== null && /^\d+$/.test(a.alvo) && a.alvo === String(resumoId));
  if (enviado) return { status: "enviado", enviadoEm: enviado.quando };
  if (!destino || !destino.ativo) return { status: "destino-inativo", enviadoEm: null };
  return { status: "aguardando", enviadoEm: null };
}

/** Data de referência decrescente (mais recente primeiro); empate decide pelo momento da geração. */
export function ordenarLinhasResumos<T extends { resumo: Pick<Resumo, "data_ref" | "gerado_em"> }>(linhas: T[]): T[] {
  return [...linhas].sort(
    (a, b) =>
      b.resumo.data_ref.localeCompare(a.resumo.data_ref) ||
      new Date(b.resumo.gerado_em).getTime() - new Date(a.resumo.gerado_em).getTime(),
  );
}

export async function carregarResumosEnviados(client: SupabaseClient): Promise<Resultado<HistoricoResumos>> {
  const [resumos, chats, auditoria, destino] = await Promise.all([
    wa(client).from("resumos").select("*").order("gerado_em", { ascending: false }).limit(300),
    wa(client).from("chats").select("id, nome, tipo"),
    wa(client).from("auditoria").select("id, quando, ator, acao, alvo, detalhe").in("acao", [ACAO_RESUMO_ENVIADO, ACAO_RESUMO_NAO_ENVIADO]).order("quando", { ascending: false }).limit(500),
    wa(client).from("notificacao_destino").select("jid, nome, ativo, atualizado_em").maybeSingle(),
  ]);
  const r = ler<Resumo[]>(resumos as Retorno<Resumo[]>, []);
  if (!r.ok) return r;
  const c = ler<{ id: string; nome: string; tipo?: string }[]>(chats as Retorno<{ id: string; nome: string; tipo?: string }[]>, []);
  if (!c.ok) return c;
  const au = ler<AuditoriaEnvioResumo[]>(auditoria as Retorno<AuditoriaEnvioResumo[]>, []);
  if (!au.ok) return au;
  const de = ler<DestinoNotificacao | null>(destino as Retorno<DestinoNotificacao | null>, null);
  if (!de.ok) return de;
  const nomes = new Map(c.dados.map((x) => [x.id, x.nome]));
  const diretos = new Set(c.dados.filter((x) => x.tipo === "direto").map((x) => x.id));
  // Só o que foi de fato enviado conta como status "enviado" de um resumo de grupo.
  const enviadas = au.dados.filter((a) => a.acao === ACAO_RESUMO_ENVIADO);
  return {
    ok: true,
    dados: {
      destino: de.dados,
      digestsDm: extrairDigestsDm(au.dados),
      linhas: ordenarLinhasResumos(
        r.dados
          .filter((resumo) => !diretos.has(resumo.chat_id))
          .slice(0, 100)
          .map((resumo) => ({
            resumo,
            chatNome: nomes.get(resumo.chat_id) ?? "Chat removido",
            ...derivarStatusEnvio(resumo.id, enviadas, de.dados),
          })),
      ),
    },
  };
}

export type Configuracoes = { chats: ChatResumo[]; destino: DestinoNotificacao | null };

export async function carregarConfiguracoes(client: SupabaseClient): Promise<Resultado<Configuracoes>> {
  const chats = await carregarChatsLiberados(client);
  if (!chats.ok) return chats;
  const r = await wa(client).from("notificacao_destino").select("jid, nome, ativo, atualizado_em").maybeSingle();
  const de = ler<DestinoNotificacao | null>(r as Retorno<DestinoNotificacao | null>, null);
  if (!de.ok) return de;
  return { ok: true, dados: { chats: chats.dados, destino: de.dados } };
}

const PESO_URGENCIA: Record<string, number> = { alta: 1, media: 2, baixa: 3 };

/** Urgência (alta primeiro) e, dentro dela, quem espera há mais tempo primeiro. */
export function ordenarPendencias<T extends Pick<Pendencia, "urgencia" | "espera_desde">>(linhas: T[]): T[] {
  return [...linhas].sort(
    (a, b) =>
      (PESO_URGENCIA[a.urgencia] ?? 9) - (PESO_URGENCIA[b.urgencia] ?? 9) ||
      new Date(a.espera_desde).getTime() - new Date(b.espera_desde).getTime(),
  );
}

export async function carregarPendencias(client: SupabaseClient): Promise<Resultado<Pendencia[]>> {
  const r = await wa(client).from("v_pendencias").select("*").eq("status", "aberta").limit(500);
  const lida = ler<Pendencia[]>(r as Retorno<Pendencia[]>, []);
  if (!lida.ok) return lida;
  return { ok: true, dados: ordenarPendencias(lida.dados) };
}

export function statusPendenciaFinal(valor: unknown): Exclude<StatusPendencia, "aberta"> | null {
  return valor === "respondida" || valor === "descartada" ? valor : null;
}

/**
 * Fecha uma pendência aberta. Usa o cliente do usuário: a RLS (wa.is_admin) e o grant por
 * coluna (só `status`) do banco garantem que somente admin altera. Nunca reabre.
 */
export async function atualizarStatusPendencia(
  client: SupabaseClient,
  id: number,
  status: Exclude<StatusPendencia, "aberta">,
): Promise<Resultado<null>> {
  if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, erro: "Pendência inválida." };
  const r = await wa(client).from("pendencias_resposta").update({ status }).eq("id", id).eq("status", "aberta").select("id");
  const lida = ler<{ id: number }[]>(r as Retorno<{ id: number }[]>, []);
  if (!lida.ok) return lida;
  if (lida.dados.length === 0) return { ok: false, erro: "A pendência não está mais aberta ou você não tem permissão para alterá-la." };
  return { ok: true, dados: null };
}

export const CHAVE_TEMAS_APRENDIZADO = "aprendizado_temas";
const LIMITE_APRENDIZADOS = 1000;

export type AprendizadosPorTema = { aprendizados: Aprendizado[]; temas: TemaAprendizado[]; grupos: { id: string; nome: string }[] };

/** Aprendizados não descartados (candidatos e aprovados) de grupos, a lista de temas e os grupos que têm algum. */
export async function carregarAprendizadosPorTema(client: SupabaseClient): Promise<Resultado<AprendizadosPorTema>> {
  const [aprendizados, config] = await Promise.all([
    wa(client).from("v_aprendizados").select("*").neq("status", "descartado").order("criado_em", { ascending: false }).limit(LIMITE_APRENDIZADOS),
    wa(client).from("config").select("valor").eq("chave", CHAVE_TEMAS_APRENDIZADO).maybeSingle(),
  ]);
  const a = ler<Aprendizado[]>(aprendizados as Retorno<Aprendizado[]>, []);
  if (!a.ok) return a;
  const c = ler<{ valor: unknown } | null>(config as Retorno<{ valor: unknown } | null>, null);
  if (!c.ok) return c;
  const nomes = new Map<string, string>();
  for (const x of a.dados) if (x.chat_id && x.chat_nome) nomes.set(x.chat_id, x.chat_nome);
  const grupos = [...nomes.entries()].map(([id, nome]) => ({ id, nome })).sort((x, y) => x.nome.localeCompare(y.nome));
  return { ok: true, dados: { aprendizados: a.dados, temas: lerTemasConfig(c.dados?.valor), grupos } };
}

/** Aprova ou descarta um aprendizado ainda não descartado. A RLS e o grant por coluna (status) do banco restringem a admin. */
export async function decidirAprendizado(client: SupabaseClient, id: number, status: "aprovado" | "descartado"): Promise<Resultado<null>> {
  if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, erro: "Aprendizado inválido." };
  const r = await wa(client).from("aprendizados").update({ status }).eq("id", id).neq("status", "descartado").select("id");
  const lida = ler<{ id: number }[]>(r as Retorno<{ id: number }[]>, []);
  if (!lida.ok) return lida;
  if (lida.dados.length === 0) return { ok: false, erro: "O aprendizado já foi descartado ou você não tem permissão para alterá-lo." };
  return { ok: true, dados: null };
}

/** Grava a lista de temas em wa.config (a RLS permite update de admin; o trigger audita). */
export async function salvarTemasAprendizado(client: SupabaseClient, temas: TemaAprendizado[]): Promise<Resultado<null>> {
  const r = await wa(client).from("config").update({ valor: temas }).eq("chave", CHAVE_TEMAS_APRENDIZADO).select("chave");
  const lida = ler<{ chave: string }[]>(r as Retorno<{ chave: string }[]>, []);
  if (!lida.ok) return lida;
  if (lida.dados.length === 0) return { ok: false, erro: "Não foi possível salvar os temas." };
  return { ok: true, dados: null };
}

/** Limite de caracteres da resposta digitada. Espelha o check do banco (wa.fila_envio). */
export const LIMITE_TEXTO_RESPOSTA = 4000;
export const CHAVE_ENVIO_RESPOSTAS = "ENVIO_RESPOSTAS_ATIVO";

/** Erros do banco são mensagens nossas (prefixo "wa.funcao: "), sem dados; os demais viram texto genérico. */
export function erroDeRpc(erro: { message?: string; code?: string } | null | undefined): string {
  const m = (erro?.message ?? "").match(/^wa\.[a-z_]+:\s*(.+)$/i);
  return m ? m[1] : mensagemErroAmigavel(erro);
}

/** Normaliza o texto digitado: só apara as pontas. O texto aprovado é exatamente este. */
export function validarTextoResposta(valor: unknown): { ok: true; texto: string } | { ok: false; erro: string } {
  if (typeof valor !== "string") return { ok: false, erro: "Escreva a resposta antes de aprovar." };
  const texto = valor.trim();
  if (!texto) return { ok: false, erro: "Escreva a resposta antes de aprovar." };
  if (texto.length > LIMITE_TEXTO_RESPOSTA) return { ok: false, erro: `A resposta passa de ${LIMITE_TEXTO_RESPOSTA} caracteres.` };
  return { ok: true, texto };
}

/** Aprova a resposta escrita pelo dono: grava na fila. Quem valida admin, contato e pendência aberta é o banco. */
export async function aprovarRespostaPendencia(client: SupabaseClient, pendenciaId: number, texto: string): Promise<Resultado<number>> {
  if (!Number.isSafeInteger(pendenciaId) || pendenciaId <= 0) return { ok: false, erro: "Pendência inválida." };
  const t = validarTextoResposta(texto);
  if (!t.ok) return t;
  const r = await wa(client).rpc("aprovar_resposta_pendencia", { p_pendencia_id: pendenciaId, p_texto: t.texto });
  if (r.error) return { ok: false, erro: erroDeRpc(r.error) };
  return { ok: true, dados: Number(r.data) };
}

/** Cancela o envio enquanto ainda está aprovado e não foi pego pelo consumidor. */
export async function cancelarRespostaPendencia(client: SupabaseClient, filaId: number): Promise<Resultado<boolean>> {
  if (!Number.isSafeInteger(filaId) || filaId <= 0) return { ok: false, erro: "Envio inválido." };
  const r = await wa(client).rpc("cancelar_resposta_pendencia", { p_fila_id: filaId });
  if (r.error) return { ok: false, erro: erroDeRpc(r.error) };
  return { ok: true, dados: r.data === true };
}

/** Estado da chave de envio de respostas (padrão desligada: sem linha ou valor diferente de true = desligada). */
export async function carregarEnvioRespostasAtivo(client: SupabaseClient): Promise<Resultado<boolean>> {
  const r = await wa(client).from("config").select("valor").eq("chave", CHAVE_ENVIO_RESPOSTAS).limit(1);
  const lida = ler<{ valor: unknown }[]>(r as Retorno<{ valor: unknown }[]>, []);
  if (!lida.ok) return lida;
  return { ok: true, dados: lida.dados[0]?.valor === true };
}

/**
 * Kill switch de envio: true = PARADO. Falha fechada, igual ao banco: só o booleano false libera;
 * sem linha, string, número ou null contam como parado.
 */
export async function carregarKillSwitchLigado(client: SupabaseClient): Promise<Resultado<boolean>> {
  const r = await wa(client).from("config").select("valor").eq("chave", "kill_switch_envio").limit(1);
  const lida = ler<{ valor: unknown }[]>(r as Retorno<{ valor: unknown }[]>, []);
  if (!lida.ok) return lida;
  return { ok: true, dados: lida.dados[0]?.valor !== false };
}

/** Texto aprovado das linhas ainda vivas na fila (aprovado/enviando), por id. Só admin lê (RLS). */
export async function carregarTextosAprovados(client: SupabaseClient, filaIds: number[]): Promise<Resultado<Record<number, string>>> {
  const ids = filaIds.filter((n) => Number.isSafeInteger(n) && n > 0);
  if (ids.length === 0) return { ok: true, dados: {} };
  const r = await wa(client).from("fila_envio").select("id, texto").in("id", ids);
  const lida = ler<{ id: number; texto: string }[]>(r as Retorno<{ id: number; texto: string }[]>, []);
  if (!lida.ok) return lida;
  return { ok: true, dados: Object.fromEntries(lida.dados.map((l) => [Number(l.id), String(l.texto)])) };
}

/**
 * Libera nova aprovação depois de um envio interrompido, quando o dono conferiu no WhatsApp que a
 * mensagem NÃO saiu. Só admin e só em linha falhou/interrompido_verificar (o banco confere e audita).
 */
export async function liberarReaprovacaoResposta(client: SupabaseClient, filaId: number): Promise<Resultado<boolean>> {
  if (!Number.isSafeInteger(filaId) || filaId <= 0) return { ok: false, erro: "Envio inválido." };
  const r = await wa(client).rpc("liberar_reaprovacao", { p_fila_id: filaId });
  if (r.error) return { ok: false, erro: erroDeRpc(r.error) };
  return { ok: true, dados: r.data === true };
}

/** Liga ou desliga o envio. RLS e grant por coluna do banco restringem a admin; a mudança é auditada pelo banco. */
export async function definirEnvioRespostasAtivo(client: SupabaseClient, ativo: boolean): Promise<Resultado<null>> {
  const r = await wa(client).from("config").update({ valor: ativo }).eq("chave", CHAVE_ENVIO_RESPOSTAS).select("chave");
  const lida = ler<{ chave: string }[]>(r as Retorno<{ chave: string }[]>, []);
  if (!lida.ok) return lida;
  if (lida.dados.length === 0) return { ok: false, erro: "Chave de envio não encontrada ou sem permissão para alterá-la." };
  return { ok: true, dados: null };
}
