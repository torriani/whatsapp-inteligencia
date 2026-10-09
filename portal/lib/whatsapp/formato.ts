/** Funções puras de formatação e normalização das telas de WhatsApp. */
import type { ChatResumo, Mensagem } from "./tipos";

const FUSO = "America/Sao_Paulo";

export const TEXTO_REDIGIDO = "conteúdo omitido por filtro de sensibilidade";
export const TEXTO_APAGADO = "mensagem apagada";

export type StatusSaude = "saudavel" | "atrasada" | "erro" | "sem-dados";

export type Saude = {
  status: StatusSaude;
  rotulo: string;
  detalhe: string;
};

/** Constantes técnicas: o worker roda a cada 10 minutos. */
export const LIMITE_SAUDAVEL_MIN = 30;
export const LIMITE_ATRASADA_MIN = 6 * 60;

export function formatarDataHora(iso: string | null | undefined): string {
  if (!iso) return "sem registro";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "sem registro";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: FUSO,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function formatarHora(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, hour: "2-digit", minute: "2-digit" }).format(d);
}

/** Aceita data pura (AAAA-MM-DD) ou timestamp. Datas puras não sofrem deslocamento de fuso. */
export function formatarData(valor: string | null | undefined): string {
  if (!valor) return "sem registro";
  const pura = /^(\d{4})-(\d{2})-(\d{2})$/.exec(valor);
  if (pura) return `${pura[3]}/${pura[2]}/${pura[1]}`;
  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) return "sem registro";
  return new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
}

export function dataDoDia(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function haQuantoTempo(iso: string | null | undefined, agora: Date = new Date()): string {
  if (!iso) return "sem registro";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "sem registro";
  const min = Math.max(0, Math.floor((agora.getTime() - t) / 60000));
  if (min < 1) return "agora há pouco";
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  const dias = Math.floor(h / 24);
  return dias === 1 ? "há 1 dia" : `há ${dias} dias`;
}

export function calcularSaude(
  ultima: { iniciou_em: string | null; terminou_em: string | null; erro: string | null } | null,
  agora: Date = new Date(),
): Saude {
  if (!ultima) {
    return { status: "sem-dados", rotulo: "Sem dados", detalhe: "Nenhuma ingestão registrada até agora." };
  }
  const ref = ultima.terminou_em ?? ultima.iniciou_em;
  if (ultima.erro) {
    return { status: "erro", rotulo: "Com erro", detalhe: `A última ingestão falhou ${haQuantoTempo(ref, agora)}.` };
  }
  if (!ref) {
    return { status: "sem-dados", rotulo: "Sem dados", detalhe: "A ingestão não tem horário registrado." };
  }
  const min = (agora.getTime() - new Date(ref).getTime()) / 60000;
  if (min <= LIMITE_SAUDAVEL_MIN) {
    return { status: "saudavel", rotulo: "Saudável", detalhe: `Última ingestão ${haQuantoTempo(ref, agora)}.` };
  }
  return {
    status: "atrasada",
    rotulo: min > LIMITE_ATRASADA_MIN ? "Parada" : "Atrasada",
    detalhe: `Sem ingestão nova ${haQuantoTempo(ref, agora)}. O Mac pode estar desligado ou o WhatsApp Desktop fechado.`,
  };
}

/**
 * Os campos discutido, decidido e olhar são jsonb em formato de lista. O contrato não fixa o
 * formato dos itens: aceita texto puro ou objeto com um campo de texto conhecido.
 */
const CAMPOS_TEXTO = ["texto", "topico", "titulo", "descricao", "resumo", "text"] as const;

export function normalizarItens(valor: unknown): string[] {
  if (!Array.isArray(valor)) return [];
  const saida: string[] = [];
  for (const item of valor) {
    if (typeof item === "string") {
      if (item.trim()) saida.push(item.trim());
    } else if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      const campo = CAMPOS_TEXTO.find((c) => typeof obj[c] === "string" && (obj[c] as string).trim());
      if (campo) saida.push((obj[campo] as string).trim());
    }
  }
  return saida;
}

export type ExibicaoMensagem =
  | { tipo: "texto"; texto: string }
  | { tipo: "redigida"; texto: string }
  | { tipo: "apagada"; texto: string }
  | { tipo: "midia"; texto: string };

export function exibirMensagem(m: Pick<Mensagem, "texto" | "redigida" | "apagada" | "tem_midia" | "transcrito">): ExibicaoMensagem {
  if (m.redigida) return { tipo: "redigida", texto: TEXTO_REDIGIDO };
  if (m.apagada) return { tipo: "apagada", texto: TEXTO_APAGADO };
  const texto = (m.texto ?? "").trim();
  if (texto) return { tipo: "texto", texto };
  if (m.tem_midia) return { tipo: "midia", texto: m.transcrito ? "mídia transcrita sem texto" : "mídia sem texto (somente etiqueta)" };
  return { tipo: "texto", texto: "(mensagem sem texto)" };
}

export function resumoDoChat(c: Pick<ChatResumo, "resumo_discutido" | "resumo_decidido" | "resumo_olhar">) {
  return {
    discutido: normalizarItens(c.resumo_discutido),
    decidido: normalizarItens(c.resumo_decidido),
    olhar: normalizarItens(c.resumo_olhar),
  };
}

export function mensagemErroAmigavel(erro: { message?: string; code?: string } | null | undefined): string {
  if (!erro) return "Erro desconhecido ao ler os dados de WhatsApp.";
  const msg = erro.message ?? "";
  if (erro.code === "PGRST106" || /invalid schema/i.test(msg) || /schema.*cache/i.test(msg)) {
    return "O schema de WhatsApp ainda não está exposto na API do Supabase. A exposição é feita pelo DevOps em Configurações da API.";
  }
  if (erro.code === "42501" || /permission denied/i.test(msg)) {
    return "Sem permissão para ler os dados de WhatsApp com esta sessão.";
  }
  return "Não foi possível ler os dados de WhatsApp agora. Tente recarregar a página.";
}

/** Domínio exibível: remove prefixo www. */
export function dominioExibivel(dominio: string): string {
  return dominio.replace(/^www\./i, "");
}

/** Só permite abrir links http(s); evita esquemas perigosos vindos de mensagens de terceiros. */
export function urlSegura(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}
