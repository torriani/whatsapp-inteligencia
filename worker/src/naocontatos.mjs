// Lista unica, em dry-run, das pendencias abertas de quem NAO e contato salvo: nome, numero completo, pedido resumido e ha quanto tempo.
// Numero de telefone so aparece aqui e no digest. Nunca envia; nunca traz conteudo de mensagem alem do pedido resumido.
import { limparItem, haTexto } from "./formatar.mjs";
import { excluida } from "./dm.mjs";
import { lit } from "./db.mjs";

const ddmm = (dia) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;
// O WhatsApp devolve numero sem nome como "\u202a+55 51 99361\u20119752\u202c": tira marcas invisiveis e hifen nao quebravel.
const limpo = (s) => String(s ?? "").replace(/\p{Cf}/gu, "").replace(/[\u2010-\u2015\u2212]/g, "-").trim();
const SEM_NOME = /^(contato \d{0,6}|[+\d\s().-]*)$/i;
const pareceTelefone = (s) => /^\+?[\d\s().-]+$/.test(s) && s.replace(/\D/g, "").length >= 10;

const ehCodigo = (n) => !n || SEM_NOME.test(n) || /^sem nome\b/i.test(n) || /@|^\d{8,}$/.test(n);

// Nome de exibicao, nesta ordem: nome salvo na agenda, pushname do WhatsApp, nome do chat. Codigo (numero, jid) nunca e nome.
// agenda: Map jid -> nome salvo. Sem nome: "sem nome" (e o numero, quando conhecido, e acrescentado por quem monta o texto).
export function nomeParaLista(jid, nomeChat, pushnames, agenda = new Map()) {
  for (const cand of [agenda.get(jid), pushnames.get(jid), nomeChat]) {
    const n = limparItem(limpo(cand), 60);
    if (!ehCodigo(n)) return n;
  }
  return "sem nome";
}

// Nome para o digest e o portal: o nome resolvido, ou "sem nome +55 ..." quando so ha o numero.
export function nomeComNumero(jid, nomeChat, pushnames, agenda = new Map()) {
  const nome = nomeParaLista(jid, nomeChat, pushnames, agenda);
  if (nome !== "sem nome") return nome;
  const num = numeroParaLista(jid, nomeChat, pushnames);
  return num.startsWith("+") ? `sem nome ${num}` : "sem nome";
}

const formatarTel = (d) => {
  // Celular BR em formato antigo (8 digitos iniciados em 6-9): o numero discavel leva o 9 na frente.
  const antigo = d.match(/^55(\d{2})([6-9]\d{7})$/);
  const br = antigo ? [null, antigo[1], `9${antigo[2].slice(0, 4)}`, antigo[2].slice(4)] : d.match(/^55(\d{2})(9\d{4})(\d{4})$/);
  return br ? `+55 ${br[1]} ${br[2].length === 5 ? br[2] : br[2]}-${br[3]}` : `+${d}`;
};

// Telefone: do jid quando e de telefone; em jid @lid so se o nome exibido pelo WhatsApp for o proprio numero.
export function numeroParaLista(jid, nomeChat = "", pushnames = new Map()) {
  const m = String(jid).match(/^(\d{8,15})@s\.whatsapp\.net$/);
  if (m) return formatarTel(m[1]);
  for (const cand of [pushnames.get(jid), nomeChat]) {
    const n = limpo(cand);
    if (pareceTelefone(n)) return formatarTel(n.replace(/\D/g, ""));
  }
  return "número oculto pelo WhatsApp";
}

// pendencias: [{ jid, contato_nome, ultima_em, espera_desde, pedido, audio_sem_transcricao, contato }] (contato ja calculado).
export function montarListaNaoContatos({ pendencias, pushnames, agenda = new Map(), exclusoes = { excluir: [] }, dia, agoraMs = Date.now() }) {
  const quando = (p) => p.ultima_em || p.espera_desde;
  const itens = pendencias
    .filter((p) => p.contato !== true && !excluida({ jid: p.jid, nome: p.contato_nome }, exclusoes))
    .sort((a, b) => Date.parse(quando(b)) - Date.parse(quando(a)))
    .map((p) => ({
      nome: nomeParaLista(p.jid, p.contato_nome, pushnames, agenda),
      numero: numeroParaLista(p.jid, p.contato_nome, pushnames),
      pedido: p.audio_sem_transcricao ? "áudio sem transcrição" : limparItem(p.pedido, 140),
      ha: haTexto(quando(p), agoraMs),
    }));
  const cab = `\u{1F4EC} *Pendências de quem não está nos seus contatos* · ${ddmm(dia)}\n_${itens.length} ${itens.length === 1 ? "pessoa" : "pessoas"}, da mensagem mais recente para a mais antiga_`;
  const corpo = itens.map((i) => `*${i.nome}* · ${i.numero}\n- Pedido: ${i.pedido}\n- ${i.ha}`);
  return { total: itens.length, itens, texto: itens.length ? `${cab}\n\n${corpo.join("\n\n")}` : `${cab}\n\n_Nenhuma pendência aberta de quem não é contato._` };
}

// Grava o nome resolvido em wa.chats.nome e nas pendencias abertas (contato_nome), quando vazio ou codigo. Sem migration.
export async function atualizarNomes(db, agenda, pushnames) {
  const chats = await db.rows(`select id, jid, nome from wa.chats where tipo = 'direto'`);
  let alterados = 0;
  for (const c of chats) {
    const novo = nomeComNumero(c.jid, c.nome, pushnames, agenda);
    if (novo === c.nome) continue;
    await db.exec(`update wa.chats set nome = ${lit(novo)} where id = ${lit(c.id)}::uuid`);
    alterados++;
  }
  await db.exec(`update wa.pendencias_resposta p set contato_nome = c.nome from wa.chats c
    where c.id = p.chat_id and c.tipo = 'direto' and p.status = 'aberta' and p.contato_nome is distinct from c.nome`);
  return alterados;
}
