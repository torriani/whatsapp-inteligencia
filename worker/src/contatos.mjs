// Contato salvo x numero desconhecido. SOMENTE LEITURA (sqlite3 -readonly, mode=ro).
// Criterio: a DM e de contato salvo quando o jid da conversa (ZWACHATSESSION.ZCONTACTJID) consta na agenda do WhatsApp,
// ContactsV2.sqlite, tabela ZWAADDRESSBOOKCONTACT: ZWHATSAPPID (jid de telefone) ou ZLID (jid @lid). Toda linha dessa
// tabela e um contato da agenda do dono (ZFULLNAME, ZPHONENUMBER, ZWHATSAPPID e ZLID sempre preenchidos).
// ZPARTNERNAME NAO serve: para numero desconhecido o WhatsApp grava o nome de perfil (pushname) ali.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseJsonSeguro } from "./safejson.mjs";
import { CONTACTS_DB, CHAT_DB } from "./paths.mjs";
import { lit } from "./db.mjs";

const exec = promisify(execFile);
const COLUNAS_AGENDA = ["ZWHATSAPPID", "ZLID", "ZFULLNAME"];

export function criarLeitorContatos({ contactsDb = CONTACTS_DB, chatDb = CHAT_DB, exec: execFn = exec } = {}) {
  async function sql(arquivo, query) {
    const { stdout } = await execFn("sqlite3", ["-readonly", "-json", `file:${encodeURI(arquivo)}?mode=ro`, query], { maxBuffer: 64 * 1024 * 1024, timeout: 20000, killSignal: "SIGKILL" });
    return stdout.trim() ? parseJsonSeguro(stdout, "saida do sqlite3") : [];
  }
  return {
    // Map jid (telefone e lid) -> nome salvo na agenda (ZFULLNAME); .has() diz se e contato. Falha fechada: schema diferente ou agenda vazia lancam erro.
    async jidsSalvos() {
      const cols = new Set((await sql(contactsDb, "select name from pragma_table_info('ZWAADDRESSBOOKCONTACT')")).map((r) => r.name));
      const falta = COLUNAS_AGENDA.filter((c) => !cols.has(c));
      if (falta.length) throw new Error(`agenda do WhatsApp mudou. Faltando: ${falta.join(", ")}`);
      const rows = await sql(contactsDb, "select ZWHATSAPPID w, ZLID l, ZFULLNAME n from ZWAADDRESSBOOKCONTACT");
      const set = new Map();
      for (const r of rows) { const nome = r.n || ""; if (r.w) set.set(r.w, nome); if (r.l) set.set(r.l, nome); }
      if (!set.size) throw new Error("agenda do WhatsApp vazia ou ilegivel; marcacao de contatos nao alterada");
      return set;
    },
    // Map jid -> nome de exibicao do WhatsApp para quem pode nao estar na agenda: ZWACHATSESSION.ZPARTNERNAME (que, sem contato salvo,
    // traz o pushname ou o proprio numero formatado, unica fonte de telefone para jid @lid) sobreposto por ZWAPROFILEPUSHNAME.
    async pushnames() {
      const mapa = new Map();
      for (const r of await sql(chatDb, "select ZCONTACTJID j, ZPARTNERNAME n from ZWACHATSESSION where ZSESSIONTYPE = 0 and ZPARTNERNAME is not null and ZPARTNERNAME <> ''")) mapa.set(r.j, r.n);
      for (const r of await sql(chatDb, "select ZJID j, ZPUSHNAME n from ZWAPROFILEPUSHNAME where ZPUSHNAME is not null and ZPUSHNAME <> ''")) mapa.set(r.j, r.n);
      return mapa;
    },
  };
}

export const ehContato = (jid, salvos) => salvos.has(jid);

// Marca wa.chats.contato (true/false) nas DMs. Retorna contagens. Nao grava telefone.
export async function sincronizarContatos(db, salvos) {
  const chats = await db.rows(`select id, jid from wa.chats where tipo = 'direto'`);
  const sim = chats.filter((c) => salvos.has(c.jid)).map((c) => c.id);
  const nao = chats.filter((c) => !salvos.has(c.jid)).map((c) => c.id);
  const marcar = async (ids, valor) => {
    for (let i = 0; i < ids.length; i += 200) {
      await db.exec(`update wa.chats set contato = ${valor} where id = any(array[${ids.slice(i, i + 200).map(lit).join(",")}]::uuid[]) and contato is distinct from ${valor}`);
    }
  };
  await marcar(sim, "true");
  await marcar(nao, "false");
  return { contatos: sim.length, nao_contatos: nao.length };
}
