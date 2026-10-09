// Every test run receives fresh config/state; never inherit personal credentials.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const cwd = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "wai-tests-"));
const env = { ...process.env, WAI_CONFIG_DIR: path.join(root,"config"), WAI_STATE_DIR: path.join(root,"state"), WAI_TIMEZONE: "America/Sao_Paulo" };
for (const key of Object.keys(env)) if (key.startsWith("WA_DB_")) delete env[key];
try {
  const files = fs.readdirSync(cwd).filter(name => name.endsWith(".test.mjs")).map(name => path.join(cwd,name));
  process.exitCode = spawnSync(process.execPath, ["--test", ...files], { env, stdio:"inherit" }).status ?? 1;
} finally { fs.rmSync(root, {recursive:true,force:true}); }
