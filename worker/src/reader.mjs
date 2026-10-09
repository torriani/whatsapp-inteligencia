// Leitor SOMENTE LEITURA do ChatStorage.sqlite via CLI sqlite3 (sem dependencia).
// Nunca abre para escrita, nunca toca no original.
import { parseJsonSeguro } from "./safejson.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CHAT_DB } from "./paths.mjs";
import { ESPERADO, avaliarSchema } from "./schema-guard.mjs";

const exec = promisify(execFile);
export const APPLE_EPOCH = 978307200;

export function criarLeitor(dbPath = CHAT_DB, { exec: execFn = exec } = {}) {
  const uri = `file:${encodeURI(dbPath)}?mode=ro`;
  async function sql(query) {
    const { stdout } = await execFn("sqlite3", ["-readonly", "-json", uri, query], { maxBuffer: 512 * 1024 * 1024 });
    return stdout.trim() ? parseJsonSeguro(stdout, "saida do sqlite3") : [];
  }

  const int = (n) => {
    const v = Number(n);
    if (!Number.isSafeInteger(v)) throw new Error("parametro numerico invalido");
    return v;
  };

  return {
    sql,
    async schemaGuard() {
      const atual = {};
      for (const t of Object.keys(ESPERADO)) {
        const rows = await sql(`select name from pragma_table_info('${t}')`);
        atual[t] = rows.map((r) => r.name);
      }
      return avaliarSchema(atual);
    },
    // Consulta so a tabela de sessoes. Nenhum texto de mensagem.
    async sessoes() {
      const rows = await sql(
        "select Z_PK pk, ZCONTACTJID jid, ZPARTNERNAME nome, ZSESSIONTYPE tipo, ZREMOVED removido, ZLASTMESSAGEDATE ultima from ZWACHATSESSION",
      );
      return rows.map((r) => ({ ...r, removido: !!r.removido }));
    },
    async maxPk(chatPk) {
      const r = await sql(`select coalesce(max(Z_PK),0) m from ZWAMESSAGE where ZCHATSESSION = ${int(chatPk)}`);
      return r[0].m;
    },
    // Incremental: Z_PK > afterPk OU data >= desdeApple (janela de reconciliacao e backfill).
    // Pagina por cursor de Z_PK.
    async mensagens(chatPk, { afterPk = 0, desdeApple = null, cursor = 0, limite = 5000 } = {}) {
      const janela = desdeApple == null ? "" : ` or m.ZMESSAGEDATE >= ${Number(desdeApple)}`;
      return sql(`
        select m.Z_PK pk, m.ZISFROMME fromMe, m.ZMESSAGEDATE data, m.ZSTANZAID stanza, m.ZTEXT texto,
               m.ZMESSAGETYPE tipo, m.ZGROUPEVENTTYPE evento, m.ZMEDIAITEM midia, m.ZPARENTMESSAGE pai,
               m.ZPUSHNAME push, coalesce(gm.ZCONTACTNAME, m.ZPUSHNAME) autor, gm.ZMEMBERJID autorJid,
               pm.ZSTANZAID paiStanza, mi.ZTITLE titulo
        from ZWAMESSAGE m
        left join ZWAGROUPMEMBER gm on gm.Z_PK = m.ZGROUPMEMBER
        left join ZWAMEDIAITEM mi on mi.Z_PK = m.ZMEDIAITEM
        left join ZWAMESSAGE pm on pm.Z_PK = m.ZPARENTMESSAGE
        where m.ZCHATSESSION = ${int(chatPk)} and m.Z_PK > ${int(cursor)} and (m.Z_PK > ${int(afterPk)}${janela})
        order by m.Z_PK limit ${int(limite)}`);
    },
    async mensagensApos(chatPk, afterPk, limite = 5000) {
      return this.mensagens(chatPk, { afterPk, cursor: afterPk, limite });
    },
  };
}

export const appleParaIso = (d) => new Date((Number(d) + APPLE_EPOCH) * 1000).toISOString();
export const isoParaApple = (ms) => ms / 1000 - APPLE_EPOCH;
