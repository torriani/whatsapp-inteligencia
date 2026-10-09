// Estado local do worker (marca d'agua, custos, lock). Fora de qualquer repo.
import { parseJsonSeguro } from "./safejson.mjs";
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./paths.mjs";

const FILE = path.join(STATE_DIR, "state.json");
const LOCK = path.join(STATE_DIR, "run.lock");

export function carregarEstado() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(FILE)) return { version: 1, chats: {}, custo_usd: {}, resumos: {} };
  return parseJsonSeguro(fs.readFileSync(FILE, "utf8"), "state");
}

export function salvarEstado(estado) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(estado, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

// Leitura-modificacao-gravacao curta e atomica: fases concorrentes (ingestao e resumos) nao pisam no estado uma da outra.
export function atualizarEstado(fn) {
  const e = carregarEstado();
  fn(e);
  salvarEstado(e);
  return e;
}

// Locks por fase, com arquivo e pid. Lock de processo morto e retomado; alem disso expira por idade.
const lockFile = (nome) => path.join(STATE_DIR, `${nome}.lock`);
const vivo = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

export function adquirirLock(nome = "run", maxIdadeMs = 30 * 60 * 1000) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const f = lockFile(nome);
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    try {
      fs.writeFileSync(f, `${process.pid} ${new Date().toISOString()}\n`, { flag: "wx", mode: 0o600 });
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const pid = Number(String(fs.readFileSync(f, "utf8")).split(" ")[0]);
      const velho = Date.now() - fs.statSync(f).mtimeMs > maxIdadeMs;
      if (Number.isInteger(pid) && vivo(pid) && !velho) return false;
      try { fs.unlinkSync(f); } catch { /* outro processo ja retomou */ }
    }
  }
  return false;
}
export const liberarLock = (nome = "run") => { try { fs.unlinkSync(lockFile(nome)); } catch { /* ja liberado */ } };
