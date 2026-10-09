// Localiza binarios mesmo sob o ambiente minimo do launchd (PATH=/usr/bin:/bin).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXTRAS = [
  path.dirname(process.execPath),
  path.join(os.homedir(), ".local/bin"),
  path.join(os.homedir(), ".npm-global/bin"),
  "/opt/homebrew/opt/libpq/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

export function dirsBusca(pathEnv = process.env.PATH || "") {
  return [...new Set([...pathEnv.split(path.delimiter).filter(Boolean), ...EXTRAS])];
}

export function acharBinario(nome, pathEnv = process.env.PATH || "") {
  for (const d of dirsBusca(pathEnv)) {
    const f = path.join(d, nome);
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch { /* proximo */ }
  }
  return null;
}

// PATH completo para processos filhos (claude e um script "#!/usr/bin/env node").
export const pathCompleto = () => dirsBusca().join(path.delimiter);
