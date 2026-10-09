import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { EmptyState } from "@/components/EmptyState";
import { CartaoAprendizado, EditorTemas } from "@/components/operacao/whatsapp/Aprendizados";
import { ChipFiltro, EstadoErro, ListaTopicos, Painel, TituloPagina } from "@/components/operacao/whatsapp/Blocos";
import { agruparPorTema, contarPor, filtrarAprendizados, lerParametrosAprendizados, SEM_TEMA } from "@/lib/whatsapp/aprendizados";
import { carregarAprendizados, carregarAprendizadosPorTema } from "@/lib/whatsapp/dados";
import { formatarData, normalizarItens, resumoDoChat } from "@/lib/whatsapp/formato";
import { exigirAdminDaRequisicao } from "@/lib/whatsapp/guarda";
import { montarQuery, type SearchParams } from "@/lib/whatsapp/parametros";

export const dynamic = "force-dynamic";

export default async function AprendizadosWhatsappPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await exigirAdminDaRequisicao();
  const p = lerParametrosAprendizados(await searchParams);
  if (p.visao === "resumos") {
    return (
      <div className="space-y-6">
        <TituloPagina titulo="Resumos por grupo" />
        <ResumosPorGrupo />
      </div>
    );
  }

  const supabase = await createClient();
  const r = await carregarAprendizadosPorTema(supabase);
  if (!r.ok) {
    return (
      <div className="space-y-6">
        <TituloPagina titulo="Aprendizados" />
        <EstadoErro mensagem={r.erro} />
      </div>
    );
  }

  const { aprendizados, temas, grupos } = r.dados;
  const visiveis = filtrarAprendizados(aprendizados, p);
  const doGrupo = aprendizados.filter((a) => !p.grupo || a.chat_id === p.grupo);
  const porTema = contarPor(doGrupo.map((a) => a.tema));
  const nomesTema = [...temas.map((t) => t.nome), ...[...porTema.keys()].filter((k) => k !== SEM_TEMA && !temas.some((t) => t.nome === k)), ...(porTema.has(SEM_TEMA) ? [SEM_TEMA] : [])];
  const href = (extra: Record<string, string | null>) =>
    `/operacao/whatsapp/aprendizados${montarQuery({ tema: p.tema, grupo: p.grupo, q: p.q, ...extra })}`;
  const nomeGrupo = grupos.find((g) => g.id === p.grupo)?.nome;
  const filtrado = Boolean(p.tema || p.grupo || p.q);

  return (
    <div className="space-y-6">
      <TituloPagina
        titulo="Aprendizados"
        descricao="Só o que ensina algo nos temas que importam, em uma ou duas frases. O resumo completo de cada grupo continua à parte."
        acao={<Link href="/operacao/whatsapp/aprendizados?visao=resumos" className="font-sans text-sm text-accent hover:underline">Ver resumos por grupo</Link>}
      />

      <form action="/operacao/whatsapp/aprendizados" method="get" className="flex w-full min-w-0 flex-wrap items-end gap-2">
        {p.tema && <input type="hidden" name="tema" value={p.tema} />}
        {p.grupo && <input type="hidden" name="grupo" value={p.grupo} />}
        <label className="min-w-0 flex-1 font-sans text-sm text-ink">
          <span className="block text-xs font-semibold uppercase tracking-wider text-ink-muted">O que se fala sobre</span>
          <input
            type="search"
            name="q"
            defaultValue={p.q}
            maxLength={80}
            placeholder="Um tema ou uma palavra-chave, por exemplo AIOX"
            className="mt-1 w-full rounded-md border border-divider bg-surface px-3 py-2 font-sans text-sm text-ink"
          />
        </label>
        <button type="submit" className="rounded-md bg-accent px-4 py-2 font-sans text-sm text-on-accent hover:bg-accent-dark">Buscar</button>
        {filtrado && <Link href="/operacao/whatsapp/aprendizados" className="px-2 py-2 font-sans text-sm text-ink-muted hover:text-ink">Limpar</Link>}
      </form>

      <div className="flex w-full min-w-0 flex-wrap gap-2" aria-label="Filtrar por tema">
        <ChipFiltro ativo={!p.tema} href={href({ tema: null })}>Todos os temas ({doGrupo.length})</ChipFiltro>
        {nomesTema.map((t) => (
          <ChipFiltro key={t} ativo={p.tema === t} href={href({ tema: t })}>{t} ({porTema.get(t) ?? 0})</ChipFiltro>
        ))}
      </div>
      <div className="flex w-full min-w-0 flex-wrap gap-2" aria-label="Filtrar por grupo">
        <ChipFiltro ativo={!p.grupo} href={href({ grupo: null })}>Todos os grupos</ChipFiltro>
        {grupos.map((g) => (
          <ChipFiltro key={g.id} ativo={p.grupo === g.id} href={href({ grupo: g.id })}>{g.nome}</ChipFiltro>
        ))}
      </div>

      {aprendizados.length === 0 ? (
        <EmptyState titulo="Nenhum aprendizado ainda" descricao="Os aprendizados aparecem aqui quando um resumo diário trouxer algo ligado aos temas." />
      ) : visiveis.length === 0 ? (
        <EmptyState titulo="Nada encontrado" descricao="Nenhum aprendizado combina com este filtro. Tente outro tema, grupo ou palavra." />
      ) : p.q ? (
        <Painel titulo={`O que se fala sobre ${p.q}`} descricao={`${visiveis.length} ${visiveis.length === 1 ? "aprendizado" : "aprendizados"}${nomeGrupo ? ` em ${nomeGrupo}` : ""}, do mais recente ao mais antigo.`}>
          <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {visiveis.map((a) => <li key={a.id} className="min-w-0"><CartaoAprendizado a={a} /></li>)}
          </ul>
        </Painel>
      ) : (
        agruparPorTema(visiveis, temas).map(({ tema, itens }) => (
          <Painel key={tema} titulo={`${tema} (${itens.length})`}>
            <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {itens.map((a) => <li key={a.id} className="min-w-0"><CartaoAprendizado a={a} /></li>)}
            </ul>
          </Painel>
        ))
      )}

      <EditorTemas temas={temas} />
    </div>
  );
}

async function ResumosPorGrupo() {
  const supabase = await createClient();
  const r = await carregarAprendizados(supabase);

  return (
    <div className="space-y-6">
      <Link href="/operacao/whatsapp/aprendizados" className="font-sans text-sm text-accent hover:underline">Voltar para os aprendizados por tema</Link>
      <p className="font-sans text-sm text-ink-muted">O que foi discutido, o que foi decidido e o que olhar, por grupo.</p>
      {!r.ok ? (
        <EstadoErro mensagem={r.erro} />
      ) : r.dados.length === 0 ? (
        <EmptyState titulo="Nenhum grupo liberado ainda" descricao="Quando houver grupos liberados e resumos gerados, cada grupo ganha uma seção aqui." />
      ) : (
        r.dados.map(({ chat, resumoSemana, decisoes, perguntas }) => {
          const dia = resumoDoChat(chat);
          const semDados =
            chat.resumo_id === null && !resumoSemana && decisoes.length === 0 && perguntas.length === 0;
          return (
            <Painel key={chat.id} titulo={`Resumo de ${chat.nome}`}>
              {semDados ? (
                <p className="font-sans text-sm text-ink-muted">Ainda não há resumos ou decisões para este grupo.</p>
              ) : (
                <div className="space-y-6">
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                    <ListaTopicos rotulo="O que foi discutido" itens={dia.discutido} vazio="Nada registrado no último resumo." />
                    <ListaTopicos rotulo="O que foi decidido" itens={dia.decidido} vazio="Nenhuma decisão no último resumo." />
                    <ListaTopicos rotulo="O que olhar" itens={dia.olhar} vazio="Nada para olhar no último resumo." />
                  </div>
                  {chat.resumo_data_ref && (
                    <p className="font-sans text-xs text-ink-muted">Resumo diário de {formatarData(chat.resumo_data_ref)}.</p>
                  )}

                  <div className="border-t border-divider pt-4">
                    <h3 className="font-sans text-sm font-semibold text-ink">
                      Resumo semanal{resumoSemana ? ` (semana de ${formatarData(resumoSemana.data_ref)})` : ""}
                    </h3>
                    {resumoSemana ? (
                      <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-3">
                        <ListaTopicos rotulo="Discutido" itens={normalizarItens(resumoSemana.discutido)} vazio="Nada registrado." />
                        <ListaTopicos rotulo="Decidido" itens={normalizarItens(resumoSemana.decidido)} vazio="Nenhuma decisão." />
                        <ListaTopicos rotulo="Olhar" itens={normalizarItens(resumoSemana.olhar)} vazio="Nada para olhar." />
                      </div>
                    ) : (
                      <p className="mt-1 font-sans text-sm text-ink-muted">Ainda não há resumo semanal para este grupo.</p>
                    )}
                  </div>

                  {decisoes.length > 0 && (
                    <ListaTopicos
                      rotulo="Decisões registradas"
                      itens={decisoes.map((d) => (d.responsavel ? `${d.texto} (${d.responsavel})` : d.texto))}
                      vazio=""
                    />
                  )}
                  {perguntas.length > 0 && (
                    <ListaTopicos rotulo="Perguntas em aberto" itens={perguntas.map((p) => p.texto_norm)} vazio="" />
                  )}
                </div>
              )}
            </Painel>
          );
        })
      )}
    </div>
  );
}
