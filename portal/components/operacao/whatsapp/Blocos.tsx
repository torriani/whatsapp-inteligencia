import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils/cn";
import type { Saude } from "@/lib/whatsapp/formato";

export function TituloPagina({ titulo, descricao, acao }: { titulo: string; descricao?: string; acao?: React.ReactNode }) {
  return (
    <div className="flex w-full min-w-0 flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-serif text-3xl text-ink">{titulo}</h1>
        {descricao && <p className="mt-1 font-sans text-sm text-ink-muted">{descricao}</p>}
      </div>
      {acao}
    </div>
  );
}

export function EstadoErro({ mensagem }: { mensagem: string }) {
  return (
    <div role="alert" className="w-full min-w-0 rounded-card border border-danger bg-surface p-4">
      <p className="font-sans text-sm font-medium text-danger">Não foi possível carregar esta tela</p>
      <p className="mt-1 font-sans text-sm text-ink-muted">{mensagem}</p>
    </div>
  );
}

export function Painel({ titulo, descricao, children, className }: { titulo?: string; descricao?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("w-full min-w-0 overflow-hidden rounded-card border border-divider bg-surface shadow-card", className)}>
      {(titulo || descricao) && (
        <header className="border-b border-divider p-4">
          {titulo && <h2 className="font-serif text-xl text-ink">{titulo}</h2>}
          {descricao && <p className="font-sans text-sm text-ink-muted">{descricao}</p>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function ListaTopicos({ rotulo, itens, vazio }: { rotulo: string; itens: string[]; vazio: string }) {
  return (
    <div className="min-w-0">
      <h3 className="font-sans text-xs font-semibold uppercase tracking-wider text-ink-muted">{rotulo}</h3>
      {itens.length === 0 ? (
        <p className="mt-1 font-sans text-sm text-ink-muted">{vazio}</p>
      ) : (
        <ul className="mt-1 list-disc space-y-1 pl-5 font-sans text-sm text-ink">
          {itens.map((item, i) => (
            <li key={i} className="break-words">{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const COR_SAUDE: Record<Saude["status"], string> = {
  saudavel: "bg-success",
  atrasada: "bg-warning",
  erro: "bg-danger",
  "sem-dados": "bg-ink-muted",
};

export function IndicadorSaude({ saude }: { saude: Saude }) {
  return (
    <div className="flex items-start gap-2" role="status" aria-label={`Saúde da ingestão: ${saude.rotulo}`}>
      <span aria-hidden className={cn("mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-pill", COR_SAUDE[saude.status])} />
      <div className="min-w-0">
        <p className="font-sans text-sm font-medium text-ink">{saude.rotulo}</p>
        <p className="font-sans text-xs text-ink-muted">{saude.detalhe}</p>
      </div>
    </div>
  );
}

export function Etiqueta({ children, tom = "neutro" }: { children: React.ReactNode; tom?: "neutro" | "destaque" | "alerta" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-pill border px-2 py-0.5 font-sans text-xs",
        tom === "neutro" && "border-divider text-ink-muted",
        tom === "destaque" && "border-accent text-ink",
        tom === "alerta" && "border-warning text-ink",
      )}
    >
      {children}
    </span>
  );
}

export function LinkBotao({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="inline-flex items-center rounded-md border border-divider bg-surface px-3 py-1.5 font-sans text-sm text-ink hover:border-accent">
      {children}
    </Link>
  );
}

export function ChipFiltro({ ativo, href, children }: { ativo: boolean; href: string; children: React.ReactNode }) {
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
