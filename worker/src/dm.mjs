// Conversas individuais (ZSESSIONTYPE=0): selecao, exclusao local e nome de exibicao. Nunca grupos aqui.
import fs from "node:fs";
import { DM_EXCLUIR_FILE } from "./paths.mjs";
import { garantirArquivo, checarPermissao600, norm } from "./allowlist.mjs";
import { parseJsonSeguro } from "./safejson.mjs";
import { APPLE_EPOCH } from "./reader.mjs";

export const EXCLUSAO_MODELO = { version: 1, nota: "Contatos fora da leitura de DMs. Entradas: { nome } (exato, sem acento) ou { telefone } (so digitos). Nao versionar.", excluir: [] };

export function criarArquivoExclusao(file = DM_EXCLUIR_FILE, inicial = EXCLUSAO_MODELO) {
  return garantirArquivo(file, JSON.stringify(inicial, null, 2) + "\n");
}

// Arquivo ausente = falha fechada (nenhuma DM e lida). Permissao frouxa = erro.
export function carregarExclusoes(file = DM_EXCLUIR_FILE) {
  if (!fs.existsSync(file)) throw new Error(`Lista de exclusao de DMs ausente em ${file}. Rode "init". Sem ela nenhuma DM e lida.`);
  checarPermissao600(file);
  const j = parseJsonSeguro(fs.readFileSync(file, "utf8"), "dm-excluir");
  if (!Array.isArray(j.excluir)) throw new Error("Lista de exclusao de DMs invalida: campo excluir ausente.");
  return j;
}

const DIGITOS = (s) => String(s ?? "").replace(/\D/g, "");

export function excluida(sessao, exclusoes) {
  const n = norm(sessao.nome);
  const tel = DIGITOS(String(sessao.jid).split("@")[0]);
  return exclusoes.excluir.some((e) => (e.nome && norm(e.nome) === n) || (e.telefone && tel && DIGITOS(e.telefone) === tel));
}

const JID_DM = /@(s\.whatsapp\.net|lid)$/;

// sessoes: [{ pk, jid, nome, tipo, removido, ultima }]. conhecidos: Set de jids ja ingeridos (seguem sempre).
export function resolverDms(sessoes, exclusoes, { agoraMs = Date.now(), dias = 30, conhecidos = new Set(), nomear = null } = {}) {
  const corte = agoraMs / 1000 - APPLE_EPOCH - dias * 86400;
  const out = [];
  for (const s of sessoes) {
    if (s.tipo !== 0 || s.removido || !JID_DM.test(s.jid || "")) continue;
    if (excluida(s, exclusoes)) continue;
    if (!conhecidos.has(s.jid) && !(Number(s.ultima) >= corte)) continue;
    const tel = DIGITOS(s.jid.split("@")[0]);
    out.push({ ...s, nome: (nomear && nomear(s)) || s.nome?.trim() || `Contato ${tel.slice(-4) || s.pk}`, tipoChat: "direto", modo: "registrar", regra: "dm", backfill_dias: dias, direct: true });
  }
  return out;
}
