import { Etiqueta, Painel } from "@/components/operacao/whatsapp/Blocos";
import { temasParaTexto } from "@/lib/whatsapp/aprendizados";
import { formatarData } from "@/lib/whatsapp/formato";
import type { Aprendizado, TemaAprendizado } from "@/lib/whatsapp/tipos";
import { decidirAprendizadoAction, salvarTemasAction } from "@/app/operacao/whatsapp/aprendizados/actions";

export function CartaoAprendizado({ a }: { a: Aprendizado }) {
  return (
    <article className="flex h-full min-w-0 flex-col justify-between gap-3 rounded-md border border-divider p-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          {a.tema && <Etiqueta tom="destaque">{a.tema}</Etiqueta>}
          {a.status === "aprovado" && <Etiqueta>Aprovado</Etiqueta>}
        </div>
        <p className="mt-2 whitespace-pre-wrap break-words font-sans text-sm text-ink">{a.corpo}</p>
        <p className="mt-2 break-words font-sans text-xs text-ink-muted">
          {a.chat_nome ?? "Grupo removido"} · {formatarData(a.criado_em)}
        </p>
      </div>
      <form action={decidirAprendizadoAction} className="flex flex-wrap gap-2">
        <input type="hidden" name="id" value={a.id} />
        {a.status === "candidato" && (
          <button type="submit" name="status" value="aprovado" className="rounded-md bg-accent px-3 py-1.5 font-sans text-sm text-on-accent hover:bg-accent-dark">
            Aprovar
          </button>
        )}
        <button type="submit" name="status" value="descartado" className="rounded-md border border-divider px-3 py-1.5 font-sans text-sm text-ink hover:border-accent">
          Descartar
        </button>
      </form>
    </article>
  );
}

export function EditorTemas({ temas }: { temas: TemaAprendizado[] }) {
  return (
    <Painel titulo="Temas dos aprendizados" descricao="Uma linha por tema, no formato Nome: descrição. O próximo resumo diário já usa a lista nova. Aprendizado fora destes temas é descartado.">
      <form action={salvarTemasAction} className="space-y-3">
        <label className="block font-sans text-sm text-ink">
          <span className="sr-only">Lista de temas</span>
          <textarea
            name="temas"
            defaultValue={temasParaTexto(temas)}
            rows={Math.max(6, temas.length + 1)}
            className="w-full rounded-md border border-divider bg-surface px-3 py-2 font-mono text-sm text-ink"
          />
        </label>
        <button type="submit" className="rounded-md bg-accent px-4 py-2 font-sans text-sm text-on-accent hover:bg-accent-dark">Salvar temas</button>
      </form>
    </Painel>
  );
}
