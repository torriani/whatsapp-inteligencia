// Gera o plist do LaunchAgent a partir da config. NAO carrega automaticamente.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR, STATE_DIR, TIMEZONE } from "./paths.mjs";
import { dirsBusca } from "./bin.mjs";

export const LABEL = "local.wai.whatsapp-inteligencia";
export const PLIST = path.join(os.homedir(), "Library/LaunchAgents", `${LABEL}.plist`);

export const LABEL_PENDENCIAS = "local.wai.whatsapp-pendencias";
export const PLIST_PENDENCIAS = path.join(os.homedir(), "Library/LaunchAgents", `${LABEL_PENDENCIAS}.plist`);

export function gerarPlist({ appDir, config, node = process.execPath }) {
  const logDir = STATE_DIR;
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!--
  Inteligencia de WhatsApp. Um unico agente: a cada StartInterval roda "tick",
  que ingere e, apos o horario do resumo (config), gera o resumo diario uma vez por dia.
  Ritmo ajustavel em ~/.wa-intelligence/whatsapp-inteligencia-config.json e "cli.mjs plist".
  Logs: so contagens e erros, nunca texto de mensagem.
-->
<plist version="1.0">
<dict>
    <key>Label</key><string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${esc(node)}</string>
        <string>${esc(path.join(appDir, "src/cli.mjs"))}</string>
        <string>tick</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>${esc(dirsBusca("").join(path.delimiter))}</string>
        <key>WAI_CONFIG_DIR</key><string>${esc(CONFIG_DIR)}</string>
        <key>WAI_STATE_DIR</key><string>${esc(STATE_DIR)}</string>
        <key>WAI_TIMEZONE</key><string>${esc(TIMEZONE)}</string>
    </dict>
    <key>StartInterval</key><integer>${config.ritmo.ingestao_segundos}</integer>
    <key>RunAtLoad</key><false/>
    <key>StandardOutPath</key><string>${esc(path.join(logDir, "tick.log"))}</string>
    <key>StandardErrorPath</key><string>${esc(path.join(logDir, "tick.err"))}</string>
</dict>
</plist>
`;
}

export function escreverPlist(opts) {
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(PLIST, gerarPlist(opts));
  return PLIST;
}

// Agente das pendencias: a cada 15 min roda "pendencias-atualizar". Nunca le a agenda do WhatsApp (TCC trava no launchd);
// o "contato salvo" vem de wa.chats.contato, gravado pela ingestao.
export function gerarPlistPendencias({ appDir, intervaloSegundos = 900, node = process.execPath }) {
  const logDir = STATE_DIR;
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!--
  Pendencias de resposta do WhatsApp. A cada 15 min roda "pendencias-atualizar": cria, atualiza e fecha pendencias
  de contatos salvos, com teto de conversas por rodada e watchdog (config dm.atualizar_*). Nao envia nada ao WhatsApp
  e nao abre a agenda do WhatsApp. Logs: so contagens e erros.
-->
<plist version="1.0">
<dict>
    <key>Label</key><string>${LABEL_PENDENCIAS}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${esc(node)}</string>
        <string>${esc(path.join(appDir, "src/cli.mjs"))}</string>
        <string>pendencias-atualizar</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>${esc(dirsBusca("").join(path.delimiter))}</string>
        <key>WAI_CONFIG_DIR</key><string>${esc(CONFIG_DIR)}</string>
        <key>WAI_STATE_DIR</key><string>${esc(STATE_DIR)}</string>
        <key>WAI_TIMEZONE</key><string>${esc(TIMEZONE)}</string>
    </dict>
    <key>ProcessType</key><string>Background</string>
    <key>StartInterval</key><integer>${intervaloSegundos}</integer>
    <key>RunAtLoad</key><false/>
    <key>ExitTimeOut</key><integer>30</integer>
    <key>StandardOutPath</key><string>${esc(path.join(logDir, "pendencias.log"))}</string>
    <key>StandardErrorPath</key><string>${esc(path.join(logDir, "pendencias.err"))}</string>
</dict>
</plist>
`;
}

export function escreverPlistPendencias(opts) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  if (fs.existsSync(PLIST_PENDENCIAS)) fs.copyFileSync(PLIST_PENDENCIAS, `${PLIST_PENDENCIAS}.bak`);
  fs.mkdirSync(path.dirname(PLIST_PENDENCIAS), { recursive: true });
  fs.writeFileSync(PLIST_PENDENCIAS, gerarPlistPendencias(opts));
  return PLIST_PENDENCIAS;
}

export const LABEL_RESPOSTAS = "local.wai.whatsapp-respostas";
export const PLIST_RESPOSTAS = path.join(os.homedir(), "Library/LaunchAgents", `${LABEL_RESPOSTAS}.plist`);
export function gerarPlistRespostas({ appDir, intervaloSegundos = 60, node = process.execPath, real = false }) {
  return gerarPlistPendencias({ appDir, intervaloSegundos, node })
    .replace(/<!--[^]*?-->/, "<!-- Consumidor de respostas aprovadas. Dry-run por padrao. -->")
    .replaceAll(LABEL_PENDENCIAS, LABEL_RESPOSTAS)
    .replace("src/cli.mjs", "src/respostas-cli.mjs")
    .replace("<string>pendencias-atualizar</string>", real ? "<string>--real</string>" : "<string>--dry-run</string>")
    .replaceAll("pendencias.log", "respostas.log").replaceAll("pendencias.err", "respostas.err");
}
export function escreverPlistRespostas(opts) {
  fs.mkdirSync(path.dirname(PLIST_RESPOSTAS), { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(PLIST_RESPOSTAS, gerarPlistRespostas(opts), { mode: 0o600 });
  return PLIST_RESPOSTAS;
}
