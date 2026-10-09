// Conexao Postgres direta (pooler do Supabase) via psql. Nunca imprime segredo nem SQL.
// Erros devolvem so o SQLSTATE: mensagens do servidor podem conter dados.
import { parseJsonSeguro } from "./safejson.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { checarPermissao600 } from "./allowlist.mjs";
import { CONFIG_DIR } from "./paths.mjs";
import { acharBinario } from "./bin.mjs";

const TIMEOUT_PSQL_MS = 60000;
const ENV_LOCAL_600 = path.join(CONFIG_DIR, "whatsapp-db.env");

function lerVar(file, nome) {
  if (!fs.existsSync(file)) return null;
  checarPermissao600(file);
  for (const linha of fs.readFileSync(file, "utf8").split("\n")) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[1] === nome) return m[2].replace(/^["']|["']$/g, "");
  }
  return null;
}

// Ordem: variavel de ambiente, arquivo 600 dedicado.
export function localizarSenha() {
  if (process.env.WA_DB_PASSWORD) return { senha: process.env.WA_DB_PASSWORD, fonte: "env", perm600: true };
  for (const [f, nome] of [[ENV_LOCAL_600, "WA_DB_PASSWORD"]]) {
    const senha = lerVar(f, nome);
    if (senha) return { senha, fonte: path.basename(f), perm600: (fs.statSync(f).mode & 0o077) === 0 };
  }
  return null;
}

export const dollar = (s) => {
  const tag = `q${crypto.randomBytes(6).toString("hex")}`;
  return `$${tag}$${s}$${tag}$`;
};
export const lit = (v) => (v == null ? "null" : dollar(String(v)));
export const jsonLit = (obj) => `${dollar(JSON.stringify(obj))}::jsonb`;

export function criarDb(config = {}, { spawn: spawnFn = spawn, senha = null, bin: binInj = null } = {}) {
  const setting = (key, fallback) => process.env[key] || lerVar(ENV_LOCAL_600, key) || fallback;
  const host = setting("WA_DB_HOST", config.host);
  const user = setting("WA_DB_USER", config.user || (config.ref ? `postgres.${config.ref}` : ""));
  const name = setting("WA_DB_NAME", config.name || "postgres");
  const port = String(setting("WA_DB_PORT", config.port || 5432));
  const sslmode = setting("WA_DB_SSLMODE", config.sslmode || "require");
  if (!host || !user || !name || !/^\d+$/.test(port) || +port < 1 || +port > 65535) throw new Error("Configure WA_DB_HOST, WA_DB_USER, WA_DB_NAME e WA_DB_PORT");
  if (!["disable", "allow", "prefer", "require", "verify-ca", "verify-full"].includes(sslmode)) throw new Error("WA_DB_SSLMODE invalido");
  const cred = senha ? { senha, fonte: "injetada", perm600: true } : localizarSenha();
  if (!cred) throw new Error("Senha do banco nao encontrada (WA_DB_PASSWORD ou whatsapp-db.env no WAI_CONFIG_DIR).");

  function psql(sql, { json = false } = {}) {
    return new Promise((resolve, reject) => {
      const final = json ? `select coalesce(json_agg(t), '[]'::json) from (${sql}) t` : sql;
      const bin = binInj || acharBinario("psql");
      if (!bin) return reject(new Error("psql nao encontrado no PATH nem em /opt/homebrew/opt/libpq/bin"));
      const p = spawnFn(bin, ["-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=sqlstate"], {
        env: { ...process.env, PGHOST: host, PGUSER: user, PGDATABASE: name, PGPORT: port, PGSSLMODE: sslmode, PGPASSWORD: cred.senha, PGCONNECT_TIMEOUT: "20" },
      });
      let out = ""; let err = ""; let feito = false;
      const falhar = (e) => { if (!feito) { feito = true; reject(e); } };
      // Teto duro por chamada: psql preso (rede, pooler) nao pode segurar o consumidor.
      const timer = setTimeout(() => { falhar(new Error("psql excedeu o tempo limite")); p.kill("SIGKILL"); }, TIMEOUT_PSQL_MS);
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      // 'error' (ex.: ENOENT) tambem dispara 'close' com codigo negativo: so o primeiro desfecho vale.
      p.on("error", (e) => { clearTimeout(timer); falhar(new Error(`psql nao iniciou (${e.code || "erro"})`)); });
      p.on("close", (code) => {
        clearTimeout(timer);
        if (feito) return;
        if (code !== 0) {
          const st = err.match(/(?:ERROR|FATAL):\s+([0-9A-Z]{5})\b/);
          return falhar(new Error(`erro de banco (sqlstate ${st ? st[1] : "desconhecido"}, psql ${code})`));
        }
        feito = true;
        if (!json) return resolve(out.trim());
        try { resolve(parseJsonSeguro(out.trim() || "[]", "resposta do banco")); } catch (e) { reject(e); }
      });
      p.stdin.end(final);
    });
  }
  return { exec: (sql) => psql(sql), rows: (sql) => psql(sql, { json: true }), fonteSenha: { fonte: cred.fonte, perm600: cred.perm600 } };
}
