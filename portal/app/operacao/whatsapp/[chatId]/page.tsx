import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { EmptyState } from "@/components/EmptyState";
import { Etiqueta, EstadoErro, LinkBotao, Painel, TituloPagina } from "@/components/operacao/whatsapp/Blocos";
import { carregarChat, listarMensagens, uuidValido } from "@/lib/whatsapp/dados";
import { dataDoDia, exibirMensagem, formatarData, formatarHora } from "@/lib/whatsapp/formato";
import { exigirAdminDaRequisicao } from "@/lib/whatsapp/guarda";
import { lerParametrosMensagens, montarQuery, type SearchParams } from "@/lib/whatsapp/parametros";
import type { Mensagem } from "@/lib/whatsapp/tipos";
import { cn } from "@/lib/utils/cn";

export const dynamic = "force-dynamic";

export default async function GrupoWhatsappPage({
  params,
  searchParams,
}: {
  params: Promise<{ chatId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  await exigirAdminDaRequisicao();
  const { chatId } = await params;
  if (!uuidValido(chatId)) notFound();

  const supabase = await createClient();
  const chatR = await carregarChat(supabase, chatId);
  if (!chatR.ok) return <EstadoErro mensagem={chatR.erro} />;
  if (!chatR.dados) notFound();
  const chat = chatR.dados;

  const filtros = lerParametrosMensagens(await searchParams);
  const msgsR = await listarMensagens(supabase, {
    chatId,
    busca: filtros.busca,
    antesEm: filtros.antesEm,
    antesId: filtros.antesId,
    desde: filtros.desde,
  });

  const base = { q: filtros.busca, de: filtros.de, ate: filtros.ate };
  const temFiltro = Boolean(filtros.busca || filtros.de || filtros.ate);
  const emPaginaInterna = filtros.antesId !== null;

  return (
    <div className="space-y-6">
      <TituloPagina
        titulo={chat.nome}
        descricao={`${chat.n_mensagens} mensagens registradas, ${chat.n_links} links, ${chat.n_aprendizados} aprendizados.`}
        acao={<LinkBotao href={chat.tipo === "direto" ? "/operacao/whatsapp?tipo=direto" : "/operacao/whatsapp"}>Voltar à visão geral</LinkBotao>}
      />

      <form method="get" className="grid w-full min-w-0 grid-cols-1 gap-3 rounded-card border border-divider bg-surface p-4 md:grid-cols-[2fr_1fr_1fr_auto] md:items-end">
        <Campo rotulo="Buscar no texto" nome="q" tipo="search" valor={filtros.busca} />
        <Campo rotulo="De" nome="de" tipo="date" valor={filtros.de} />
        <Campo rotulo="Até" nome="ate" tipo="date" valor={filtros.ate} />
        <div className="flex gap-2">
          <button type="submit" className="rounded-md bg-accent px-4 py-2 font-sans text-sm text-on-accent hover:bg-accent-dark">
            Filtrar
          </button>
          {(temFiltro || emPaginaInterna) && (
            <Link href={`/operacao/whatsapp/${chatId}`} className="rounded-md border border-divider px-4 py-2 font-sans text-sm text-ink hover:border-accent">
              Limpar
            </Link>
          )}
        </div>
      </form>

      {!msgsR.ok ? (
        <EstadoErro mensagem={msgsR.erro} />
      ) : msgsR.dados.mensagens.length === 0 ? (
        <EmptyState
          titulo={temFiltro || emPaginaInterna ? "Nenhuma mensagem encontrada" : "Ainda não há mensagens neste grupo"}
          descricao={
            temFiltro || emPaginaInterna
              ? "Ajuste a busca ou o período para ver resultados."
              : "As mensagens aparecem aqui depois que o worker rodar pela primeira vez."
          }
        />
      ) : (
        <Painel titulo="Mensagens" descricao="Mais recentes primeiro. Mídia aparece apenas como etiqueta.">
          <ol className="divide-y divide-divider">
            {msgsR.dados.mensagens.map((m, i, lista) => (
              <LinhaMensagem key={m.id} m={m} novoDia={i === 0 || dataDoDia(lista[i - 1].enviada_em) !== dataDoDia(m.enviada_em)} />
            ))}
          </ol>
          {msgsR.dados.proximo && (
            <div className="mt-4">
              <Link
                href={`/operacao/whatsapp/${chatId}${montarQuery({ ...base, antes_em: msgsR.dados.proximo.antesEm, antes_id: msgsR.dados.proximo.antesId })}`}
                className="rounded-md border border-divider px-4 py-2 font-sans text-sm text-ink hover:border-accent"
              >
                Mensagens mais antigas
              </Link>
            </div>
          )}
        </Painel>
      )}
    </div>
  );
}

function Campo({ rotulo, nome, tipo, valor }: { rotulo: string; nome: string; tipo: string; valor: string }) {
  return (
    <label className="block min-w-0 font-sans text-xs text-ink-muted">
      {rotulo}
      <input
        name={nome}
        type={tipo}
        defaultValue={valor}
        className="mt-1 block w-full rounded-md border border-divider bg-bg px-3 py-2 text-sm text-ink"
      />
    </label>
  );
}

function LinhaMensagem({ m, novoDia }: { m: Mensagem; novoDia: boolean }) {
  const exib = exibirMensagem(m);
  return (
    <li className="py-3">
      {novoDia && (
        <p className="mb-2 font-sans text-xs font-semibold uppercase tracking-wider text-ink-muted">{formatarData(m.enviada_em)}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-sans text-sm font-medium text-ink">{m.do_dono ? "Você" : (m.autor_nome ?? "Autor não identificado")}</span>
        <span className="font-sans text-xs text-ink-muted">{formatarHora(m.enviada_em)}</span>
        {m.tem_midia && <Etiqueta>{m.transcrito ? "mídia transcrita" : "mídia"}</Etiqueta>}
      </div>
      <p
        className={cn(
          "mt-1 whitespace-pre-wrap break-words font-sans text-sm",
          exib.tipo === "texto" ? "text-ink" : "italic text-ink-muted",
        )}
      >
        {exib.texto}
      </p>
    </li>
  );
}
