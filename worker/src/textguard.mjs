// Validador local de forma: sem travessao e sem emoji. Regrava (sanitiza) se falhar.
const DASH = /[\u2013\u2014]/g;
const EMOJI = /[\p{Extended_Pictographic}‍️]/gu;

export const temTravessao = (s) => /[\u2013\u2014]/.test(s);
export const temEmoji = (s) => /[\p{Extended_Pictographic}]/u.test(s);
export const textoLimpo = (s) => !temTravessao(s) && !temEmoji(s);

export function sanitizar(s) {
  return s.replace(DASH, ",").replace(EMOJI, "").replace(/[ \t]+,/g, ",").replace(/ {2,}/g, " ");
}

// Formata resumo curto por grupo a partir de JSON estruturado (Parte 2 alimenta).
export function formatarResumo(dia, itens) {
  const linhas = [`Resumo WhatsApp ${dia}`];
  for (const g of itens) {
    linhas.push("", g.grupo);
    for (const [rot, lista] of [["Discutido", g.discutido], ["Decidido", g.decidido], ["Olhar", g.olhar]]) {
      if (lista && lista.length) linhas.push(`${rot}: ${lista.join("; ")}`);
    }
  }
  return sanitizar(linhas.join("\n"));
}
