import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { EmptyState } from "@/components/EmptyState";
import { EstadoErro, Etiqueta, Painel, TituloPagina } from "@/components/operacao/whatsapp/Blocos";
import { agruparDominios, carregarChatsLiberados, carregarLinks, LIMITE_LINKS, uuidValido } from "@/lib/whatsapp/dados";
import { dominioExibivel, formatarData, urlSegura } from "@/lib/whatsapp/formato";
import { exigirAdminDaRequisicao } from "@/lib/whatsapp/guarda";
import { montarQuery, primeiro, type SearchParams } from "@/lib/whatsapp/parametros";
import { cn } from "@/lib/utils/cn";
import { alternarFavoritoLinkAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function LinksWhatsappPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await exigirAdminDaRequisicao();
  const sp = await searchParams;
  const chatParam = primeiro(sp.chat);
  const chatId = uuidValido(chatParam) ? chatParam : "";
  const busca = primeiro(sp.q).slice(0, 100);
  const dominio = primeiro(sp.dominio).slice(0, 253);
  const favoritos = primeiro(sp.favoritos) === "1";

  const supabase = await createClient();
  const [chatsR, linksR] = await Promise.all([
    carregarChatsLiberados(supabase, "grupos"),
    carregarLinks(supabase, { chatId: chatId || undefined, busca, dominio: dominio || undefined, favoritos }),
  ]);

  if (!chatsR.ok || !linksR.ok) {
    return (
      <div className="space-y-6">
        <TituloPagina titulo="Links" />
        <EstadoErro mensagem={!chatsR.ok ? chatsR.erro : !linksR.ok ? linksR.erro : ""} />
      </div>
    );
  }

  const chats = [...chatsR.dados].sort((a, b) => b.n_links - a.n_links || a.nome.localeCompare(b.nome));
  const { links, truncado } = linksR.dados;
  const dominios = agruparDominios(links).slice(0, 12);
  const filtrado = Boolean(chatId || busca || dominio || favoritos);
  const nomeChat = chats.find((c) => c.id === chatId)?.nome;

  const href = (extra: Record<string, string | null>) =>
    `/operacao/whatsapp/links${montarQuery({ chat: chatId, q: busca, dominio, favoritos: favoritos ? "1" : null, ...extra })}`;

  return (
    <div className="space-y-6">
      <TituloPagina
        titulo="Links"
        descricao={
          favoritos
            ? `Links que você favoritou${nomeChat ? ` em ${nomeChat}` : ""}, do favoritado mais recente ao mais antigo.`
            : nomeChat
              ? `Links compartilhados em ${nomeChat}.`
              : "Links compartilhados em todos os grupos liberados, do mais recente ao mais antigo."
        }
      />

      <div className="flex w-full min-w-0 flex-wrap gap-2" aria-label="Filtrar por favoritos">
        <Chip ativo={!favoritos} href={href({ favoritos: null })}>Todos</Chip>
        <Chip ativo={favoritos} href={href({ favoritos: "1" })}>Favoritos</Chip>
      </div>

      <div className="flex w-full min-w-0 flex-wrap gap-2" aria-label="Filtrar por grupo">
        <Chip ativo={!chatId} href={href({ chat: null })}>Todos os grupos</Chip>
        {chats.map((c) => (
          <Chip key={c.id} ativo={c.id === chatId} href={href({ chat: c.id })}>
            {c.nome} ({c.n_links})
          </Chip>
        ))}
      </div>

      <form method="get" className="grid w-full min-w-0 grid-cols-1 gap-3 rounded-card border border-divider bg-surface p-4 md:grid-cols-[1fr_auto] md:items-end">
        {chatId && <input type="hidden" name="chat" value={chatId} />}
        {dominio && <input type="hidden" name="dominio" value={dominio} />}
        {favoritos && <input type="hidden" name="favoritos" value="1" />}
        <label className="block min-w-0 font-sans text-xs text-ink-muted">
          Buscar por endereço, título, domínio ou autor
          <input name="q" type="search" defaultValue={busca} className="mt-1 block w-full rounded-md border border-divider bg-bg px-3 py-2 text-sm text-ink" />
        </label>
        <div className="flex gap-2">
          <button type="submit" className="rounded-md bg-accent px-4 py-2 font-sans text-sm text-on-accent hover:bg-accent-dark">Buscar</button>
          {filtrado && (
            <Link href="/operacao/whatsapp/links" className="rounded-md border border-divider px-4 py-2 font-sans text-sm text-ink hover:border-accent">Limpar</Link>
          )}
        </div>
      </form>

      {links.length === 0 ? (
        <EmptyState
          titulo={favoritos && !busca && !chatId && !dominio ? "Nenhum link favoritado" : filtrado ? "Nenhum link encontrado" : "Ainda não há links"}
          descricao={favoritos && !busca && !chatId && !dominio ? "Use a estrela ao lado de um link para guardá-lo aqui." : filtrado ? "Ajuste os filtros para ver resultados." : "Os links compartilhados nos grupos aparecem aqui depois que o worker rodar."}
        />
      ) : (
        <>
          {dominios.length > 0 && (
            <Painel titulo="Domínios mais citados" descricao="Soma das menções no conjunto exibido.">
              <div className="flex flex-wrap gap-2">
                {dominios.map((d) => (
                  <Chip key={d.dominio} ativo={d.dominio === dominio} href={href({ dominio: d.dominio === dominio ? null : d.dominio })}>
                    {dominioExibivel(d.dominio)} ({d.total})
                  </Chip>
                ))}
              </div>
            </Painel>
          )}

          <Painel>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-divider font-sans text-sm">
                <thead>
                  <tr>
                    <Th><span className="sr-only">Favorito</span></Th>
                    <Th>Link</Th>
                    <Th>Domínio</Th>
                    <Th>Grupo</Th>
                    <Th>Autor</Th>
                    <Th>Data</Th>
                    <Th>Vezes</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-divider">
                  {links.map((l) => {
                    const seguro = urlSegura(l.url);
                    return (
                      <tr key={l.id}>
                        <td className="w-10 px-3 py-3">
                          <form action={alternarFavoritoLinkAction}>
                            <input type="hidden" name="id" value={l.id} />
                            <input type="hidden" name="favorito" value={l.favorito ? "false" : "true"} />
                            <button
                              type="submit"
                              aria-pressed={l.favorito}
                              aria-label={l.favorito ? "Remover dos favoritos" : "Adicionar aos favoritos"}
                              title={l.favorito ? "Remover dos favoritos" : "Adicionar aos favoritos"}
                              className={cn("rounded-md p-1 hover:text-accent", l.favorito ? "text-accent" : "text-ink-muted")}
                            >
                              <Estrela cheia={l.favorito} />
                            </button>
                          </form>
                        </td>
                        <td className="max-w-[420px] px-3 py-3 text-ink">
                          {seguro ? (
                            <a href={seguro} target="_blank" rel="noopener noreferrer" className="block truncate text-accent hover:underline">
                              {l.titulo || l.url_norm}
                            </a>
                          ) : (
                            <span className="block truncate">{l.titulo || l.url_norm}</span>
                          )}
                        </td>
                        <td className="px-3 py-3 text-ink">{dominioExibivel(l.dominio)}</td>
                        <td className="px-3 py-3 text-ink-muted">{l.chat_nome}</td>
                        <td className="px-3 py-3 text-ink-muted">{l.autor_nome ?? "Não identificado"}</td>
                        <td className="whitespace-nowrap px-3 py-3 text-ink-muted">{formatarData(l.compartilhado_em)}</td>
                        <td className="px-3 py-3">{l.vezes > 1 ? <Etiqueta tom="destaque">{l.vezes}</Etiqueta> : <span className="text-ink-muted">1</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {truncado && (
              <p className="mt-3 font-sans text-xs text-ink-muted">
                Mostrando os {LIMITE_LINKS} links mais recentes. Use a busca ou os filtros para chegar aos mais antigos.
              </p>
            )}
          </Painel>
        </>
      )}
    </div>
  );
}

function Estrela({ cheia }: { cheia: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill={cheia ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9 6.8 19.7l1-5.9L3.5 9.7l5.9-.8L12 3.5z" />
    </svg>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-ink-muted">{children}</th>;
}

function Chip({ ativo, href, children }: { ativo: boolean; href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={ativo ? "true" : undefined}
      className={cn(
        "rounded-pill border px-3 py-1 font-sans text-sm",
        ativo ? "border-accent bg-accent text-on-accent" : "border-divider text-ink hover:border-accent",
      )}
    >
      {children}
    </Link>
  );
}
