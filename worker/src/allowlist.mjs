// Allowlist local: negacao por padrao. Arquivo fora de qualquer repo, permissao 600.
import { parseJsonSeguro } from "./safejson.mjs";
import fs from "node:fs";
import path from "node:path";
import { ALLOWLIST_FILE, CONFIG_DIR } from "./paths.mjs";

export const norm = (s) =>
  String(s ?? "")
    .normalize("NFD").replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

// Modelo vazio: nenhum nome de grupo vive no repo. A lista real fica so em ~/.wa-intelligence/whatsapp-allowlist.json (600).
// Cada entrada: { nome, match: "exato" | "prefixo" | "contem", modo: "registrar" | "inteligencia", backfill_dias? }
// (comparacao sem acento, sem pontuacao, sem emoji). Arquivo ausente ou lista vazia: nada e lido (falha fechada).
export const ALLOWLIST_PADRAO = {
  version: 1,
  nota: "Negacao por padrao. Somente grupos (@g.us). Nenhuma conversa direta (D2). Nao versionar.",
  tipos_sessao_permitidos: [1],
  allow: [],
  deny_always: [],
};

export function garantirArquivo(file, conteudo, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) return false;
  fs.writeFileSync(file, conteudo, { mode });
  fs.chmodSync(file, mode);
  return true;
}

export function checarPermissao600(file) {
  const mode = fs.statSync(file).mode & 0o777;
  if (mode & 0o077) throw new Error(`Permissao insegura em ${file} (${mode.toString(8)}). Exigido 600.`);
}

export function carregarAllowlist(file = ALLOWLIST_FILE) {
  if (!fs.existsSync(file)) throw new Error(`Allowlist ausente em ${file}. Rode "init". Sem allowlist nada e lido.`);
  checarPermissao600(file);
  const data = parseJsonSeguro(fs.readFileSync(file, "utf8"), "allowlist");
  if (!Array.isArray(data.allow)) throw new Error("Allowlist invalida: campo allow ausente.");
  return data;
}

function casa(regra, nomeChat) {
  const a = norm(regra.nome);
  const b = norm(nomeChat);
  if (!a || !b) return false;
  if (regra.match === "exato") return a === b;
  if (regra.match === "prefixo") return b.startsWith(a);
  if (regra.match === "contem") return b.includes(a);
  return false;
}

// sessoes: [{ pk, jid, nome, tipo, removido }] (so da tabela de sessoes).
// Retorna as sessoes liberadas, com modo. Duas barreiras duras: so @g.us e nunca DM.
export function resolverChats(allowlist, sessoes) {
  const tipos = allowlist.tipos_sessao_permitidos ?? [1];
  const negados = (allowlist.deny_always || []).map(norm);
  const out = [];
  for (const s of sessoes) {
    if (!s.jid || !s.jid.endsWith("@g.us")) continue;
    if (!tipos.includes(s.tipo)) continue;
    if (s.removido) continue;
    const n = norm(s.nome);
    if (negados.includes(n)) continue;
    const regra = allowlist.allow.find((r) => casa(r, s.nome));
    if (regra) out.push({ ...s, modo: regra.modo || "registrar", regra: regra.nome, backfill_dias: regra.backfill_dias || 0 });
  }
  return out;
}
