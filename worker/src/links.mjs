// Extrator deterministico de links (regex). Sem LLM.
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+|\bwww\.[^\s<>"'`]+/gi;
const TRACKING = /^(utm_[a-z]+|fbclid|gclid|igshid|mc_cid|mc_eid|ref_src)$/i;

function trimTrail(u) {
  let s = u;
  while (/[.,;:!?)\]}>]$/.test(s)) {
    if (s.endsWith(")") && (s.match(/\(/g) || []).length >= (s.match(/\)/g) || []).length) break;
    s = s.slice(0, -1);
  }
  return s;
}

export function normalizeUrl(raw) {
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u;
  try { u = new URL(withProto); } catch { return null; }
  if (!u.hostname.includes(".")) return null;
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  let s = u.toString();
  if (s.endsWith("/") && u.pathname === "/" && !u.search) s = s.slice(0, -1);
  return { urlNorm: s, dominio: u.hostname.replace(/^www\./, "") };
}

// Retorna [{ url, urlNorm, dominio, autor }] sem duplicar dentro da mesma mensagem.
export function extractLinks(text, autor = null) {
  if (!text) return [];
  const seen = new Set();
  const out = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = trimTrail(m[0]);
    const n = normalizeUrl(url);
    if (!n || seen.has(n.urlNorm)) continue;
    seen.add(n.urlNorm);
    out.push({ url, urlNorm: n.urlNorm, dominio: n.dominio, autor });
  }
  return out;
}
