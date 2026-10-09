import type { PontoDia } from "@/lib/whatsapp/dashboard";

const LARGURA = 560;
const ALTURA = 160;
const BASE = 24;

function rotuloDia(dia: string): string {
  return `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;
}

/** Barras por dia em SVG puro. Os números ficam também em texto para leitores de tela. */
export function BarrasPorDia({ serie, rotulo }: { serie: PontoDia[]; rotulo: string }) {
  const maximo = Math.max(1, ...serie.map((p) => p.total));
  const passo = LARGURA / Math.max(1, serie.length);
  const largura = passo * 0.6;
  const util = ALTURA - BASE - 16;
  const total = serie.reduce((soma, p) => soma + p.total, 0);
  return (
    <figure className="w-full min-w-0">
      <svg viewBox={`0 0 ${LARGURA} ${ALTURA}`} role="img" aria-label={`${rotulo}: ${total} no período`} className="h-auto w-full">
        <line x1={0} x2={LARGURA} y1={ALTURA - BASE} y2={ALTURA - BASE} className="stroke-divider" strokeWidth={1} />
        {serie.map((p, i) => {
          const altura = (p.total / maximo) * util;
          const x = i * passo + (passo - largura) / 2;
          const mostrarRotulo = i % 2 === 0 || serie.length <= 7;
          return (
            <g key={p.dia}>
              <title>{`${rotuloDia(p.dia)}: ${p.total}`}</title>
              <rect x={x} y={ALTURA - BASE - altura} width={largura} height={Math.max(altura, p.total > 0 ? 1 : 0)} rx={2} className="fill-accent" />
              {p.total > 0 && (
                <text x={x + largura / 2} y={ALTURA - BASE - altura - 4} textAnchor="middle" className="fill-ink-muted font-sans" fontSize={10}>
                  {p.total}
                </text>
              )}
              {mostrarRotulo && (
                <text x={x + largura / 2} y={ALTURA - 8} textAnchor="middle" className="fill-ink-muted font-sans" fontSize={10}>
                  {rotuloDia(p.dia)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="sr-only">
        {serie.map((p) => `${rotuloDia(p.dia)}: ${p.total}`).join("; ")}
      </figcaption>
    </figure>
  );
}

export type ItemBarra = { rotulo: string; valor: number; tom?: "destaque" | "alerta" | "perigo" };

const COR_TOM: Record<NonNullable<ItemBarra["tom"]>, string> = {
  destaque: "bg-accent",
  alerta: "bg-warning",
  perigo: "bg-danger",
};

/** Barras horizontais em CSS, proporcionais ao maior valor da lista. */
export function BarrasHorizontais({ itens, vazio }: { itens: ItemBarra[]; vazio: string }) {
  const maximo = Math.max(1, ...itens.map((i) => i.valor));
  if (itens.length === 0) return <p className="font-sans text-sm text-ink-muted">{vazio}</p>;
  return (
    <ul className="space-y-2">
      {itens.map((item) => (
        <li key={item.rotulo} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 font-sans text-sm">
          <span className="truncate text-ink">{item.rotulo}</span>
          <span className="h-2 w-full overflow-hidden rounded-pill bg-divider" aria-hidden>
            <span className={`block h-full rounded-pill ${COR_TOM[item.tom ?? "destaque"]}`} style={{ width: `${(item.valor / maximo) * 100}%` }} />
          </span>
          <span className="tabular-nums text-ink-muted">{item.valor}</span>
        </li>
      ))}
    </ul>
  );
}
