#!/usr/bin/env node
// Entrada do consumidor de respostas aprovadas. Padrao: dry-run. Envio real so com --real (e chave ENVIO_RESPOSTAS_ATIVO ligada no banco).
// Fora de cli.mjs de proposito: lock proprio ("respostas"), nunca disputa com ingestao e resumos.
import { carregarConfig } from "./config.mjs";
import { criarDb } from "./db.mjs";
import { processarRespostas, jidsContatosDoBanco } from "./respostas.mjs";
import { adquirirLock, liberarLock } from "./state.mjs";

const dryRun = !process.argv.includes("--real");
if (!adquirirLock("respostas", 3 * 60e3)) { console.log("consumidor de respostas em andamento; nada feito"); process.exit(0); }
// Teto do ciclo: se algo externo travar, sai com o lock liberado em vez de segurar o consumidor.
const watchdog = setTimeout(() => { console.error("erro: ciclo excedeu 120s; abortado"); liberarLock("respostas"); process.exit(1); }, 120e3);
try {
  const config = carregarConfig();
  const db = criarDb(config.banco);
  const r = await processarRespostas({ db, config, agenda: () => jidsContatosDoBanco(db), dryRun });
  console.log(JSON.stringify(r));
} catch (e) {
  console.error(`erro: ${e.message}`);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  liberarLock("respostas");
}
