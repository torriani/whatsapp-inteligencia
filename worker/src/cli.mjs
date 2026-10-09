#!/usr/bin/env node
// CLI do worker. Saida: somente contagens e metadados, nunca texto de mensagem.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { criarLeitor } from "./reader.mjs";
import { ALLOWLIST_FILE, DENY_TERMS_FILE, CONFIG_FILE, CHAT_DB, CONTRATO_BANCO } from "./paths.mjs";
import { ALLOWLIST_PADRAO, carregarAllowlist, garantirArquivo, resolverChats, checarPermissao600 } from "./allowlist.mjs";
import { carregarConfig, CONFIG_PADRAO } from "./config.mjs";
import { criarArquivoExclusao } from "./dm.mjs";
import { compilarTermos, parseTermos } from "./sensitive.mjs";
import { rodarDryRun, gravarRelatorio } from "./dryrun.mjs";
import { enviarResumo } from "./sender.mjs";
import { adquirirLock, liberarLock } from "./state.mjs";
import { ingerir, notificarResumos, notificarDigestDm, listaNaoContatos, pendenciasDm, pendenciasAtualizar, liberarLocksDoTick, resumir, resumirSemana, backfillResumos, tick } from "./run.mjs";
import { criarDb } from "./db.mjs";
import { reclassificar, rollback } from "./aprendizados-reclassificar.mjs";
import { escreverPlistRespostas, gerarPlistRespostas, escreverPlist, gerarPlist, escreverPlistPendencias, gerarPlistPendencias, PLIST, LABEL } from "./launchagent.mjs";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [cmd = "status", ...args] = process.argv.slice(2);
const flag = (n) => args.includes(n);
const valor = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const log = (...a) => console.log(...a);

function contexto(config) {
  let termosRegex = null;
  if (fs.existsSync(DENY_TERMS_FILE)) {
    checarPermissao600(DENY_TERMS_FILE);
    termosRegex = compilarTermos(parseTermos(fs.readFileSync(DENY_TERMS_FILE, "utf8")));
  }
  return { termosRegex, termosEmTodas: !!config.termos_em_todas_as_mensagens };
}

async function resolver() {
  const leitor = criarLeitor();
  await leitor.schemaGuard();
  const allow = carregarAllowlist();
  const chats = resolverChats(allow, await leitor.sessoes());
  return { leitor, chats };
}

// Mesmos locks por fase do tick: comando manual nunca roda junto com o agente.
async function comLock(nome, idadeMs, fn) {
  if (!adquirirLock(nome, idadeMs)) { log(`fase "${nome}" em andamento em outro processo; nada feito`); return; }
  try { await fn(); } finally { liberarLock(nome); }
}
const ING = (fn) => () => comLock("ingestao", 30 * 60e3, fn);
const RES = (fn) => () => comLock("resumos", 3 * 3600e3, fn);

const comandos = {
  async init() {
    const a = garantirArquivo(ALLOWLIST_FILE, JSON.stringify(ALLOWLIST_PADRAO, null, 2) + "\n");
    const t = garantirArquivo(DENY_TERMS_FILE, "# Um termo por linha. Arquivo local, nunca versionar.\n");
    const c = garantirArquivo(CONFIG_FILE, JSON.stringify(CONFIG_PADRAO, null, 2) + "\n");
    const d = criarArquivoExclusao();
    log(`allowlist: ${a ? "criada" : "ja existia"}; termos: ${t ? "criado" : "ja existia"}; config: ${c ? "criada" : "ja existia"}; exclusao de DMs: ${d ? "criada" : "ja existia"}`);
  },

  async status() {
    const cfg = carregarConfig();
    const out = {
      banco_whatsapp_existe: fs.existsSync(CHAT_DB),
      allowlist: fs.existsSync(ALLOWLIST_FILE), config: fs.existsSync(CONFIG_FILE),
      contrato_banco: fs.existsSync(CONTRATO_BANCO),
      parte2_gravacao: "implementada (conexao Postgres direta)",
      ENVIO_ATIVO: cfg.ENVIO_ATIVO === true,
      destino_resumo: cfg.notificacao.grupo,
      launchagent_plist: fs.existsSync(PLIST),
    };
    try {
      const { chats } = await resolver();
      out.schema_guard = "ok";
      out.chats_liberados = chats.length;
    } catch (e) { out.erro = e.message; }
    log(JSON.stringify(out, null, 2));
  },

  async "dry-run"() {
    const cfg = carregarConfig();
    const { leitor, chats } = await resolver();
    const rel = await rodarDryRun({ leitor, chats, ctx: contexto(cfg), janelaHoras: cfg.janela_horas });
    const file = gravarRelatorio(rel);
    log(`dry-run ok. chats=${rel.chats_liberados} mensagens=${rel.total.mensagens} redigidas=${rel.total.redigidas} links=${rel.total.links}`);
    for (const g of rel.grupos) log(`${g.grupo} | modo=${g.modo} | msgs=${g.mensagens} texto=${g.texto} midia=${g.midia} eventos=${g.eventos} apagadas=${g.apagadas} redigidas=${g.redigidas} links=${g.links} (unicos ${g.links_unicos}, dominios ${g.dominios_distintos}) autores=${g.autores_distintos} 72h=${g.janela_72h}`);
    log(`relatorio: ${file}`);
  },

  async ingest() {
    const g = valor("--grupo");
    const r = await ingerir({ grupo: g, janelaHoras: valor("--janela-horas") ? Number(valor("--janela-horas")) : null });
    log(`ingestao ok. lidas=${r.total.lidas} gravadas=${r.total.gravadas} redigidas=${r.total.descartadas_sensivel}`);
  },

  async resumo() {
    const r = await resumir({ grupo: valor("--grupo"), dia: valor("--data") });
    log(`resumos: ${r.resultados.length} chats, custo claude -p US$ ${r.custo_usd}`);
  },

  async "resumo-semana"() {
    const r = await resumirSemana({ grupo: valor("--grupo"), domingo: valor("--domingo") });
    log(`resumos semanais: ${r.resultados.length}, custo US$ ${r.custo_usd}`);
  },

  async "backfill-resumos"() {
    const r = await backfillResumos({ grupo: valor("--grupo"), dias: Number(valor("--dias") || 90) });
    const n = r.resultados.filter((x) => x.status === "gerado").length;
    log(`backfill: ${n} resumos gerados, custo US$ ${r.custo_usd}, teto atingido: ${r.teto_atingido}`);
  },

  async "enviar-resumo"() {
    const r = await notificarResumos({ dia: valor("--data"), dryRun: !flag("--real"), grupo: valor("--grupo"), reenviar: flag("--reenviar"), sufixo: valor("--sufixo") });
    log(`pendentes=${r.pendentes}`);
  },

  async "pendencias-dm"() {
    await pendenciasDm();
  },

  async "digest-dm"() {
    await notificarDigestDm({ dia: valor("--data"), dryRun: !flag("--real") });
  },

  async "lista-nao-contatos"() {
    const r = await listaNaoContatos({ dia: valor("--data") });
    log(`pendencias abertas=${r.abertas} contatos=${r.contatos} nao_contatos=${r.total} sem_nome_na_lista=${r.semNome} nomes_resolvidos(todas)=${r.nomesResolvidos} sem_nome(todas)=${r.nomesSem} (dry-run, nada enviado)`);
    log(r.texto);
  },

  // Sem --aplicar e so plano (contagens). --aplicar grava backup JSON antes. --rollback <arquivo> restaura.
  async "aprendizados-reclassificar"() {
    const db = criarDb(carregarConfig().banco);
    if (valor("--rollback")) return log(JSON.stringify(await rollback({ db, arquivo: valor("--rollback") })));
    const r = await reclassificar({ db, aplicar: flag("--aplicar"), log });
    log(JSON.stringify({ aplicado: r.aplicado, backup: r.backup ?? null, ...r.resumo }, null, 2));
  },

  // Rodada incremental e idempotente de pendencias (agendada a cada 15 min). --dry-run: so conta, sem gravar nem chamar o modelo.
  async "pendencias-atualizar"() {
    const cfg = carregarConfig();
    if (!adquirirLock("pendencias", (cfg.dm.atualizar_timeout_s + 300) * 1000)) return log("pendencias-atualizar: rodada anterior em andamento; nada feito");
    const wd = setTimeout(() => { console.error(`erro: pendencias-atualizar excedeu ${cfg.dm.atualizar_timeout_s}s; abortado`); liberarLock("pendencias"); process.exit(1); }, cfg.dm.atualizar_timeout_s * 1000);
    try { await pendenciasAtualizar({ dryRun: flag("--dry-run") }); } finally { clearTimeout(wd); liberarLock("pendencias"); }
  },

  // Watchdog: tick preso nao segura os locks para sempre; sai com codigo 1 e o proximo disparo do launchd retoma.
  async tick() {
    const ms = carregarConfig().ritmo.tick_timeout_s * 1000;
    const wd = setTimeout(() => { console.error(`erro: tick excedeu ${ms / 1000}s; abortado`); liberarLocksDoTick(); process.exit(1); }, ms);
    try { await tick(); } finally { clearTimeout(wd); }
  },

  async plist() {
    const cfg = carregarConfig();
    if (flag("--print")) return log(gerarPlist({ appDir: APP_DIR, config: cfg }));
    const f = escreverPlist({ appDir: APP_DIR, config: cfg });
    log(`plist escrito em ${f} (NAO carregado). Para ativar: launchctl load ${f}`);
  },

  async "plist-respostas"() {
    const opts = { appDir: APP_DIR, real: flag("--real") };
    if (flag("--print")) return log(gerarPlistRespostas(opts));
    log(`plist escrito em ${escreverPlistRespostas(opts)} (NAO carregado)`);
  },

  async "plist-pendencias"() {
    if (flag("--print")) return log(gerarPlistPendencias({ appDir: APP_DIR }));
    log(`plist escrito em ${escreverPlistPendencias({ appDir: APP_DIR })} (NAO carregado)`);
  },

  async "enviar-teste"() {
    const cfg = carregarConfig();
    const dia = new Date().toISOString().slice(0, 10);
    const r = await enviarResumo({ texto: "Teste do adaptador de envio.", dia, config: cfg, dryRun: !flag("--real") });
    log(JSON.stringify(r));
  },
};

for (const k of ["resumo", "resumo-semana", "backfill-resumos", "pendencias-dm", "digest-dm", "lista-nao-contatos"]) comandos[k] = RES(comandos[k]);
comandos.ingest = ING(comandos.ingest);
const _env = comandos["enviar-resumo"]; comandos["enviar-resumo"] = RES(_env);
if (!comandos[cmd]) { console.error(`comando desconhecido: ${cmd}. Use: ${Object.keys(comandos).join(", ")}`); process.exit(1); }
comandos[cmd]().catch((e) => { console.error(`erro: ${e.message}`); process.exit(1); });
