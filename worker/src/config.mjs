import { parseJsonSeguro } from "./safejson.mjs";
import { checarPermissao600 } from "./allowlist.mjs";
import fs from "node:fs";
import { CONFIG_FILE } from "./paths.mjs";

export const CONFIG_PADRAO = {
  ENVIO_ATIVO: false,
  notificacao: {
    grupo: "",
    gateway_bin: "wa-gateway",
    // Destino dos digests de DM. Vazio = nada de DM sai pelo WhatsApp (so portal). Nunca o grupo de notificacoes.
    destino_dm: "",
  },
  dm: { ativo: false, dias_atividade: 30, pendencia_dias: 14, lote_llm: 6, digest_max_por_mensagem: 10, somente_contatos: true, atualizar_max_conversas: 10, atualizar_timeout_s: 600 },
  ritmo: { tick_timeout_s: 2400, ingestao_segundos: 600, resumo_hora: 7, resumo_minuto: 0 },
  janela_horas: 72,
  banco: { ref: "", host: "", port: 5432 },
  resumo: {
    modos: ["inteligencia"],
    modelo: "sonnet",
    minimo_mensagens_dia: 5,
    semanal_dia_semana: 0,
    semanal_hora: 20,
    max_aprendizados_por_dia: 3,
    teto_backfill_usd: 25,
    max_chars_entrada: 80000,
  },
  termos_em_todas_as_mensagens: false,
};

export function carregarConfig(file = CONFIG_FILE) {
  let user = {};
  if (fs.existsSync(file)) {
    checarPermissao600(file);
    user = parseJsonSeguro(fs.readFileSync(file, "utf8"), "config");
    if (!user || typeof user !== "object" || Array.isArray(user)) throw new Error("Config deve ser objeto JSON");
    if (user.ENVIO_ATIVO != null && typeof user.ENVIO_ATIVO !== "boolean") throw new Error("ENVIO_ATIVO deve ser booleano");
    if (user.dm?.ativo != null && typeof user.dm.ativo !== "boolean") throw new Error("dm.ativo deve ser booleano");
  }
  return {
    ...CONFIG_PADRAO, ...user,
    notificacao: { ...CONFIG_PADRAO.notificacao, ...(user.notificacao || {}) },
    ritmo: { ...CONFIG_PADRAO.ritmo, ...(user.ritmo || {}) },
    banco: { ...CONFIG_PADRAO.banco, ...(user.banco || {}) },
    resumo: { ...CONFIG_PADRAO.resumo, ...(user.resumo || {}) },
    dm: { ...CONFIG_PADRAO.dm, ...(user.dm || {}) },
  };
}
