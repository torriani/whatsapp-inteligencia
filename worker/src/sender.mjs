import { gatewayCommand } from "./gateway-command.mjs";
// Adaptador de envio do resumo via gateway wa-gateway (Baileys).
// Trava ENVIO_ATIVO desligada por padrao. Em dry-run nao chama o gateway.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { textoLimpo, temTravessao } from "./textguard.mjs";
import { pathCompleto } from "./bin.mjs";

const execDefault = promisify(execFile);
const expand = (p) => (p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);
const slug = (s) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export const chaveIdempotencia = (grupo, dia) => `whatsapp-inteligencia:resumo:${dia}:${slug(grupo)}`;

// Envio generico atras das mesmas travas. permitirEmoji: mensagens formatadas para o proprio founder (travessao continua proibido).
export async function enviarTexto({ texto, chave, grupo, config, dryRun = true, exec = execDefault, permitirEmoji = false }) {
  const limpo = permitirEmoji ? !temTravessao(texto) : textoLimpo(texto);
  if (!limpo) return { enviado: false, motivo: permitirEmoji ? "texto com travessao" : "texto com travessao ou emoji", chave };
  if (!grupo) return { enviado: false, motivo: "destino vazio", chave };
  if (dryRun) return { enviado: false, motivo: "dry-run", destino: grupo, chave, caracteres: texto.length };
  if (config.ENVIO_ATIVO !== true) return { enviado: false, motivo: "trava ENVIO_ATIVO desligada", destino: grupo, chave };

  const { bin, prefix } = gatewayCommand(config);
  const env = { ...process.env, PATH: pathCompleto() };
  const st = await exec(bin, [...prefix, "channel", "status"], { timeout: 20000, env });
  if (!/"?whatsapp"?\s*:\s*"?connected/i.test(`${st.stdout}`)) return { enviado: false, motivo: "gateway sem whatsapp: connected", chave };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wai-envio-"));
  const arq = path.join(dir, "mensagem.txt");
  fs.writeFileSync(arq, texto, { mode: 0o600 });
  try {
    const r = await exec(bin, [...prefix, "send", "--group", grupo, "--file", arq, "--idempotency-key", chave], { timeout: 30000, env });
    return { enviado: true, destino: grupo, chave, recibo: String(r.stdout).slice(0, 200) };
  } finally {
    fs.unlinkSync(arq);
    fs.rmdirSync(dir);
  }
}

export const enviarResumo = ({ texto, dia, config, dryRun = true, exec }) =>
  enviarTexto({ texto, chave: chaveIdempotencia(config.notificacao.grupo, dia), grupo: config.notificacao.grupo, config, dryRun, exec });
