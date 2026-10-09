/** Leitura segura dos parâmetros de URL das telas de WhatsApp. */

export type SearchParams = Record<string, string | string[] | undefined>;

export function primeiro(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

export type FiltroTipoChat = "grupos" | "direto" | "todos";

/** Lista de chats: grupos e comunidades por padrão; mensagens diretas só com ?tipo=direto. */
export function lerFiltroTipo(sp: SearchParams): "grupos" | "direto" {
  return primeiro(sp.tipo) === "direto" ? "direto" : "grupos";
}

const DATA_PURA = /^\d{4}-\d{2}-\d{2}$/;

function dataPuraValida(v: string): boolean {
  if (!DATA_PURA.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Brasília não tem horário de verão desde 2019: offset fixo -03:00. */
const OFFSET = "-03:00";

export function inicioDoDia(v: string): string | null {
  return dataPuraValida(v) ? new Date(`${v}T00:00:00${OFFSET}`).toISOString() : null;
}

/** Início do dia seguinte: serve de limite superior exclusivo para "até a data". */
export function fimDoDiaExclusivo(v: string): string | null {
  if (!dataPuraValida(v)) return null;
  const d = new Date(`${v}T00:00:00${OFFSET}`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

export type ParametrosMensagens = {
  busca: string;
  de: string;
  ate: string;
  desde: string | null;
  antesEm: string | null;
  antesId: number | null;
};

export function lerParametrosMensagens(sp: SearchParams): ParametrosMensagens {
  const busca = primeiro(sp.q).slice(0, 200);
  const de = dataPuraValida(primeiro(sp.de)) ? primeiro(sp.de) : "";
  const ate = dataPuraValida(primeiro(sp.ate)) ? primeiro(sp.ate) : "";

  const cursorEm = primeiro(sp.antes_em);
  const cursorId = Number(primeiro(sp.antes_id));
  const cursorValido = cursorEm !== "" && !Number.isNaN(new Date(cursorEm).getTime()) && Number.isSafeInteger(cursorId) && cursorId > 0;

  return {
    busca,
    de,
    ate,
    desde: de ? inicioDoDia(de) : null,
    antesEm: cursorValido ? new Date(cursorEm).toISOString() : ate ? fimDoDiaExclusivo(ate) : null,
    antesId: cursorValido ? cursorId : null,
  };
}

/** Monta query string ignorando valores vazios. */
export function montarQuery(valores: Record<string, string | number | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(valores)) {
    if (v !== null && v !== undefined && String(v) !== "") p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}
