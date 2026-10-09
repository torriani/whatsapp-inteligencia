import * as React from "react";

export interface EmptyStateProps {
  titulo: string;
  descricao?: string;
  acao?: React.ReactNode;
}

export function EmptyState({ titulo, descricao, acao }: EmptyStateProps) {
  return (
    <div className="border border-dashed border-divider rounded-card bg-surface p-12 text-center">
      <h3 className="font-sans text-xl text-ink mb-2">{titulo}</h3>
      {descricao && (
        <p className="font-sans text-sm text-ink-muted max-w-md mx-auto">
          {descricao}
        </p>
      )}
      {acao && <div className="mt-4">{acao}</div>}
    </div>
  );
}
