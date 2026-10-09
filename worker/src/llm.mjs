// Chamada nao interativa da CLI do Claude (claude -p). Sem ferramentas, sem sessao persistida.
import { parseJsonSeguro } from "./safejson.mjs";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { TMP_DIR } from "./paths.mjs";
import { acharBinario, pathCompleto } from "./bin.mjs";

const SISTEMA =
  "Voce e um extrator interno de dados de conversas de trabalho. Responda apenas com JSON valido, sem texto antes ou depois. " +
  "Escreva em portugues do Brasil com acentuacao completa. Nunca use travessao nem emoji. Nunca cite mensagens literalmente.";

export function chamarClaude(prompt, { modelo = "sonnet", timeoutMs = 240000 } = {}) {
  fs.mkdirSync(`${TMP_DIR}/cwd`, { recursive: true, mode: 0o700 });
  return new Promise((resolve, reject) => {
    const bin = acharBinario("claude");
    if (!bin) return reject(new Error("claude nao encontrado no PATH"));
    const p = spawn(bin, [
      "-p", "--output-format", "json", "--model", modelo, "--tools", "",
      "--disable-slash-commands", "--no-session-persistence", "--setting-sources", "project",
      "--system-prompt", SISTEMA,
    ], { cwd: `${TMP_DIR}/cwd`, env: { ...process.env, PATH: pathCompleto() } });
    let out = "";
    const t = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("claude -p excedeu o tempo")); }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.on("error", (e) => { clearTimeout(t); reject(new Error(`claude nao iniciou (${e.code || "erro"})`)); });
    p.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0) return reject(new Error(`claude -p falhou (codigo ${code})`));
      try {
        const j = parseJsonSeguro(out, "saida do claude -p");
        if (j.is_error) return reject(new Error("claude -p devolveu erro"));
        resolve({ texto: j.result ?? "", custo: Number(j.total_cost_usd) || 0 });
      } catch { reject(new Error("saida do claude -p ilegivel")); }
    });
    p.stdin.end(prompt);
  });
}

export function extrairJson(texto) {
  const limpo = texto.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const i = limpo.indexOf("{");
  const f = limpo.lastIndexOf("}");
  if (i < 0 || f < i) throw new Error("JSON ausente na resposta");
  return parseJsonSeguro(limpo.slice(i, f + 1), "resposta do modelo");
}
