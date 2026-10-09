import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { EmptyState } from "@/components/EmptyState";
import { ChipFiltro, Etiqueta, EstadoErro, IndicadorSaude, ListaTopicos, Painel, TituloPagina } from "@/components/operacao/whatsapp/Blocos";
import { carregarVisaoGeral } from "@/lib/whatsapp/dados";
import { calcularSaude, formatarData, formatarDataHora, haQuantoTempo, resumoDoChat } from "@/lib/whatsapp/formato";
import { exigirAdminDaRequisicao } from "@/lib/whatsapp/guarda";
import { lerFiltroTipo, type SearchParams } from "@/lib/whatsapp/parametros";

export const dynamic = "force-dynamic";

export default async function VisaoGeralWhatsappPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await exigirAdminDaRequisicao();
  const tipo = lerFiltroTipo(await searchParams);
  const direto = tipo === "direto";
  const supabase = await createClient();
  const r = await carregarVisaoGeral(supabase, tipo);

  if (!r.ok) {
    return (
      <div className="space-y-6">
        <TituloPagina titulo="WhatsApp" />
        <EstadoErro mensagem={r.erro} />
      </div>
    );
  }

  const { chats, ultimaIngestao } = r.dados;
  const saude = calcularSaude(ultimaIngestao);
  const ref = ultimaIngestao?.terminou_em ?? ultimaIngestao?.iniciou_em ?? null;

  return (
    <div className="space-y-6">
      <TituloPagina
        titulo="WhatsApp"
        descricao={direto ? "Acompanhamento das mensagens diretas liberadas. Somente leitura." : "Acompanhamento dos grupos liberados. Somente leitura."}
      />

      <div className="flex w-full min-w-0 flex-wrap gap-2" aria-label="Filtrar por tipo de chat">
        <ChipFiltro ativo={!direto} href="/operacao/whatsapp">Grupos</ChipFiltro>
        <ChipFiltro ativo={direto} href="/operacao/whatsapp?tipo=direto">Mensagens diretas</ChipFiltro>
      </div>

      <Painel titulo="Ingestão" descricao="Estado da última sincronização do Mac com o banco.">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <IndicadorSaude saude={saude} />
          <Indicador rotulo="Última ingestão" valor={ref ? haQuantoTempo(ref) : "sem registro"} apoio={formatarDataHora(ref)} />
          <Indicador
            rotulo="Última execução"
            valor={ultimaIngestao ? `${ultimaIngestao.gravadas ?? 0} gravadas` : "sem registro"}
            apoio={ultimaIngestao ? `${ultimaIngestao.lidas ?? 0} lidas, ${ultimaIngestao.descartadas_sensivel ?? 0} descartadas por sensibilidade` : "O worker ainda não rodou."}
          />
          <Indicador rotulo={direto ? "Conversas liberadas" : "Grupos liberados"} valor={String(chats.length)} apoio="Somente chats liberados são lidos." />
        </div>
      </Painel>

      {chats.length === 0 ? (
        <EmptyState
          titulo={direto ? "Nenhuma mensagem direta liberada ainda" : "Nenhum grupo liberado ainda"}
          descricao="Quando um chat for liberado e o worker rodar, o resumo mais recente e as contagens do dia aparecem aqui."
        />
      ) : (
        <div className="grid w-full min-w-0 grid-cols-1 gap-4 xl:grid-cols-2">
          {chats.map((chat) => {
            const resumo = resumoDoChat(chat);
            return (
              <Painel key={chat.id}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="truncate font-serif text-xl text-ink">
                      <Link href={`/operacao/whatsapp/${chat.id}`} className="hover:text-accent">
                        {chat.nome}
                      </Link>
                    </h2>
                    <p className="font-sans text-xs text-ink-muted">
                      Última mensagem {chat.ultima_msg_em ? haQuantoTempo(chat.ultima_msg_em) : "sem registro"}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <Etiqueta tom="destaque">{chat.n_mensagens_24h} mensagens em 24 h</Etiqueta>
                    {!direto && <Etiqueta>{chat.n_links} links</Etiqueta>}
                    {chat.n_perguntas_abertas > 0 && <Etiqueta tom="alerta">{chat.n_perguntas_abertas} perguntas abertas</Etiqueta>}
                  </div>
                </div>

                <div className="mt-4 space-y-3">
                  {chat.resumo_id === null ? (
                    <p className="font-sans text-sm text-ink-muted">{direto ? "Ainda não há resumo diário para esta conversa." : "Ainda não há resumo diário para este grupo."}</p>
                  ) : (
                    <>
                      <p className="font-sans text-xs text-ink-muted">
                        Resumo de {formatarData(chat.resumo_data_ref)} ({chat.resumo_n_mensagens ?? 0} mensagens)
                      </p>
                      <ListaTopicos rotulo="Discutido" itens={resumo.discutido.slice(0, 3)} vazio="Nada registrado." />
                      <ListaTopicos rotulo="Decidido" itens={resumo.decidido.slice(0, 3)} vazio="Nenhuma decisão." />
                      <ListaTopicos rotulo="Olhar" itens={resumo.olhar.slice(0, 3)} vazio="Nada para olhar." />
                    </>
                  )}
                </div>

                <div className="mt-4 flex flex-wrap gap-3 font-sans text-sm">
                  <Link href={`/operacao/whatsapp/${chat.id}`} className="text-accent hover:underline">
                    Ler mensagens
                  </Link>
                  {direto ? (
                    <Link href="/operacao/whatsapp/pendencias" className="text-accent hover:underline">
                      Pendências de resposta
                    </Link>
                  ) : (
                    <>
                      <Link href={`/operacao/whatsapp/links?chat=${chat.id}`} className="text-accent hover:underline">
                        Links
                      </Link>
                      <Link href="/operacao/whatsapp/aprendizados" className="text-accent hover:underline">
                        Aprendizados
                      </Link>
                    </>
                  )}
                </div>
              </Painel>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Indicador({ rotulo, valor, apoio }: { rotulo: string; valor: string; apoio: string }) {
  return (
    <div className="min-w-0">
      <p className="font-sans text-xs font-semibold uppercase tracking-wider text-ink-muted">{rotulo}</p>
      <p className="mt-1 font-sans text-sm font-medium text-ink">{valor}</p>
      <p className="font-sans text-xs text-ink-muted">{apoio}</p>
    </div>
  );
}
