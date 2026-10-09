"use client";

import { EstadoErro } from "@/components/operacao/whatsapp/Blocos";

export default function ErroWhatsapp({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="space-y-3">
      <EstadoErro mensagem="Ocorreu um erro inesperado ao montar esta tela." />
      <button
        type="button"
        onClick={reset}
        className="rounded-md border border-divider bg-surface px-3 py-1.5 font-sans text-sm text-ink hover:border-accent"
      >
        Tentar de novo
      </button>
    </div>
  );
}
