// Filtro de conteudo sensivel. Roda ANTES de qualquer gravacao.
// Devolve apenas o nome da regra que disparou, nunca o trecho.

const strip = (s) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

function luhn(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function cpfValido(d) {
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  for (const t of [9, 10]) {
    let s = 0;
    for (let i = 0; i < t; i++) s += Number(d[i]) * (t + 1 - i);
    if (((s * 10) % 11) % 10 !== Number(d[t])) return false;
  }
  return true;
}

function cnpjValido(d) {
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  for (const t of [12, 13]) {
    let s = 0;
    let p = t - 7;
    for (let i = 0; i < t; i++) { s += Number(d[i]) * p--; if (p < 2) p = 9; }
    const r = s % 11 < 2 ? 0 : 11 - (s % 11);
    if (r !== Number(d[t])) return false;
  }
  return true;
}

const CREDENCIAIS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\beyJ[A-Za-z0-9_-]{10,}/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const SENHA_ATRIBUIDA =
  /\b(senha|password|passwd|pwd|passcode|token|api[\s_-]?key|secret|segredo)\b\s*(?:[:=]|\bé\b|\beh\b|\bsera\b|\bserá\b)\s*\S{4,}/i;
const SENHA_COM_VALOR =
  /\b(senha|password)\b[^\n]{0,30}?\b(?=\S*\d)(?=\S*[A-Za-z])\S{6,}/i;
// Prefixos de bandeiras (Visa, Master, Amex, Diners, Discover, JCB, Elo, Hipercard). Evita ids e telefones.
const PREFIXO_CARTAO = /^(4|5[0-5]|2[2-7]|3[0-8]|6011|65|636|606282|384100|384140|627780|50)/;
const BOLETO_47 = /\b\d{5}[.\s]?\d{5}[.\s]?\d{5}[.\s]?\d{6}[.\s]?\d{5}[.\s]?\d{6}[.\s]?\d[.\s]?\d{14}\b/;
const BOLETO_48 = /\b(?:\d{11,12}[\s-]?\d[\s-]?){4}\b/;
const PIX_UUID = /\bpix\b[^\n]{0,40}\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const PIX_CNPJ_CTX = /\b(pix|chave)\b/i;

export const TERMOS_PADRAO_PESSOAIS = [
  "divida", "dividas", "emprestimo", "parcela", "financiamento", "serasa",
  "cheque especial", "fatura do cartao", "negativado",
];

export function compilarTermos(lista) {
  const termos = [...new Set(lista.map((t) => strip(t.trim())).filter(Boolean))];
  if (!termos.length) return null;
  const esc = termos.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${esc.join("|")})(?![\\p{L}\\p{N}])`, "u");
}

const REGEX_PADRAO = compilarTermos(TERMOS_PADRAO_PESSOAIS);

export function parseTermos(conteudo) {
  return conteudo.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

// opts: { fromMe, direct, termosRegex, termosEmTodas }
export function classify(texto, opts = {}) {
  if (!texto) return { sensivel: false, regra: null };
  for (const re of CREDENCIAIS) if (re.test(texto)) return { sensivel: true, regra: "credencial" };
  if (SENHA_ATRIBUIDA.test(texto) || SENHA_COM_VALOR.test(texto)) return { sensivel: true, regra: "senha" };
  if (PIX_UUID.test(texto)) return { sensivel: true, regra: "pix" };
  if (BOLETO_47.test(texto) || BOLETO_48.test(texto)) return { sensivel: true, regra: "boleto" };

  // Numeros dentro de URL (ids de post, timestamps) geram falso positivo em Luhn: tirar antes.
  const semUrl = texto.replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, " ");
  for (const m of semUrl.matchAll(/(?<![\p{L}\p{N}_])\d(?:[ .-]?\d){10,18}(?![\p{L}\p{N}_])/gu)) {
    const d = m[0].replace(/\D/g, "");
    if (d.length >= 14 && d.length <= 19 && PREFIXO_CARTAO.test(d) && luhn(d)) return { sensivel: true, regra: "cartao" };
    if (d.length === 11 && cpfValido(d)) return { sensivel: true, regra: "cpf" };
    if (d.length === 14 && cnpjValido(d) && PIX_CNPJ_CTX.test(texto)) return { sensivel: true, regra: "cnpj_pix" };
  }

  if (opts.fromMe || opts.direct || opts.termosEmTodas) {
    const norm = strip(texto);
    if (REGEX_PADRAO.test(norm)) return { sensivel: true, regra: "termo_pessoal" };
    if (opts.termosRegex && opts.termosRegex.test(norm)) return { sensivel: true, regra: "termo_lista_local" };
  }
  return { sensivel: false, regra: null };
}
