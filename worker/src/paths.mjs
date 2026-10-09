import os from "node:os";
import path from "node:path";

export const HOME = os.homedir();
export const CONFIG_DIR = process.env.WAI_CONFIG_DIR || path.join(HOME, ".wa-intelligence");
export const ALLOWLIST_FILE = path.join(CONFIG_DIR, "whatsapp-allowlist.json");
export const ICONES_FILE = path.join(CONFIG_DIR, "whatsapp-icones.json");
export const DM_EXCLUIR_FILE = path.join(CONFIG_DIR, "whatsapp-dm-excluir.json");
export const DENY_TERMS_FILE = path.join(CONFIG_DIR, "whatsapp-deny-terms.txt");
export const CONFIG_FILE = path.join(CONFIG_DIR, "whatsapp-inteligencia-config.json");
export const CHAT_DB = path.join(
  HOME,
  "Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite",
);
export const CONTACTS_DB = path.join(path.dirname(CHAT_DB), "ContactsV2.sqlite");
export const TMP_DIR = path.join(os.tmpdir(), "whatsapp-inteligencia");
export const STATE_DIR = process.env.WAI_STATE_DIR || path.join(HOME, "Library/Application Support/whatsapp-inteligencia");
export const CONTRATO_BANCO = path.join(CONFIG_DIR, "contrato-banco.md");

export const TIMEZONE = process.env.WAI_TIMEZONE || "America/Sao_Paulo";
// Validate before using the timezone in SQL or scheduling.
new Intl.DateTimeFormat("en", { timeZone: TIMEZONE });
