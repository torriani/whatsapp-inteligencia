// JSON.parse que nunca vaza conteudo: o SyntaxError do Node cita trecho da entrada.
// Aqui so saem o tipo do erro, a posicao e o tamanho da entrada.
export class JsonInvalidoError extends Error {
  constructor(rotulo, tipo, posicao, tamanho) {
    super(`${rotulo}: JSON invalido (${tipo}, posicao ${posicao ?? "desconhecida"}, tamanho ${tamanho})`);
    this.name = "JsonInvalidoError";
  }
}

export function parseJsonSeguro(texto, rotulo = "entrada") {
  try {
    return JSON.parse(texto);
  } catch (e) {
    const pos = /position (\d+)/.exec(String(e?.message))?.[1];
    throw new JsonInvalidoError(rotulo, e?.name || "Error", pos == null ? null : Number(pos), String(texto).length);
  }
}
