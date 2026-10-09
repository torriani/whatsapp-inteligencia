import { gatewayCommand } from "./gateway-command.mjs";
// Consumidor das respostas aprovadas no portal (wa.fila_envio). Envia SO pelo gateway, SO o texto aprovado.
// O gateway aqui serve apenas para ENVIAR: nenhuma chamada le, lista ou grava mensagens recebidas ou historico.
// Leitura de WhatsApp continua exclusiva do ChatStorage.sqlite local (mode=ro), fora deste modulo.
// Defesas, todas antes do envio: chave do banco, ritmo e reconferencia da pendencia (dentro de wa.reivindicar_envio_resposta),
// hash sha256 do texto, contato salvo (wa.chats.contato), jid valido, gateway conectado e com suporte a --to.
// Logs e retorno: so ids, prefixo do hash e tamanho. Nunca o texto.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lit } from "./db.mjs";
import { pathCompleto } from "./bin.mjs";

const execDefault = promisify(execFile);
const expand = (p) => (p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);
export const JID_DM = /^[0-9A-Za-z.\-_]+@(s\.whatsapp\.net|lid)$/;
export const sha256 = (t) => crypto.createHash("sha256").update(t, "utf8").digest("hex");

// Codigo gravado quando o envio e incerto. O banco bloqueia nova aprovacao ate o dono conferir no WhatsApp.
export const INCERTO = "interrompido_verificar";

// O gateway marca recusas ANTES de qualquer tentativa de envio com este prefixo (stderr). So ele prova que nada saiu.
export const RECUSADO = "RECUSADO:";
const recusaDoGateway = (e) => {
  const m = String(e?.stderr ?? "").trim();
  return m.startsWith(RECUSADO) ? m.slice(RECUSADO.length).trim().replace(/\s+/g, " ").slice(0, 120) : null;
};

const concluir = (db, filaId, ok, { messageId = null, erro = null } = {}) =>
  db.exec(`select wa.concluir_envio_resposta(${Number(filaId)}, ${ok ? "true" : "false"}, ${lit(messageId)}, ${lit(erro)})`);

// Linha 'enviando' sem dono vivo por mais que isso e orfa (processo morto ou travado). O ciclo inteiro tem teto bem menor.
export const ORFA_MS = 5 * 60e3;
const TIMEOUT_AGENDA_MS = 30000;
const comTimeout = (promessa, ms, msg) => {
  let t;
  return Promise.race([promessa, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })]).finally(() => clearTimeout(t));
};

// Orfas: 'enviando' ha mais de 5 min. Pode ter saido ou nao (o worker morreu em ponto desconhecido), entao vai para
// falhou/interrompido_verificar pelo caminho oficial (nao reaprovavel ate o dono conferir). Nunca reenvia.
async function varrerOrfas(db) {
  const orfas = await db.rows(`select id from wa.fila_envio where status = 'enviando' and reivindicado_em < now() - interval '${Math.round(ORFA_MS / 1000)} seconds'`);
  for (const o of orfas) await concluir(db, o.id, false, { erro: INCERTO });
  return orfas.length;
}

// "Contato salvo" sem abrir a agenda do WhatsApp (ContactsV2.sqlite trava no launchd por causa do TCC): usa wa.chats.contato,
// gravado pela ingestao, que ja tem acesso a agenda. Falha fechada: nenhum contato marcado = erro (vira agenda_local_indisponivel).
export async function jidsContatosDoBanco(db) {
  const rows = await db.rows(`select jid from wa.chats where tipo = 'direto' and contato = true`);
  const set = new Set(rows.map((r) => r.jid));
  if (!set.size) throw new Error("nenhum contato marcado em wa.chats.contato");
  return set;
}

// Dry-run: so le contagens e metadados; nao reivindica, nao muda nada, nao toca no gateway.
export async function simularRespostas({ db }) {
  const rows = await db.rows(`select id, pendencia_id, status, expira_em, char_length(texto) as caracteres, left(texto_hash, 8) as hash_prefixo
    from wa.fila_envio where status = 'aprovado' order by id`);
  const cfg = await db.rows(`select chave, valor from wa.config where chave in ('ENVIO_RESPOSTAS_ATIVO','ENVIO_RESPOSTAS_INTERVALO_S','ENVIO_RESPOSTAS_MAX_HORA','kill_switch_envio')`);
  return { enviado: false, motivo: "dry-run", aprovadas: rows, config: Object.fromEntries(cfg.map((c) => [c.chave, c.valor])) };
}

// Um ciclo: no maximo UM envio (o ritmo e imposto pelo banco). agenda() devolve o Set de jids salvos (falha fechada).
export async function processarRespostas({ db, config, agenda, exec = execDefault, dryRun = true, timeoutAgendaMs = TIMEOUT_AGENDA_MS }) {
  if (dryRun) return simularRespostas({ db });
  if (config.respostas?.gateway_aceita_to !== true) {
    return { enviado: false, motivo: "gateway sem suporte a --to (config.respostas.gateway_aceita_to=false)" };
  }
  try { await varrerOrfas(db); } catch { /* varredura e best effort; o banco tambem limpa no claim */ }
  const { bin, prefix } = gatewayCommand(config);
  const env = { ...process.env, PATH: pathCompleto() };

  // Status antes de reivindicar: gateway fora do ar nao consome ritmo nem tentativa.
  let st;
  try { st = await exec(bin, [...prefix, "channel", "status"], { timeout: 20000, env }); } catch { return { enviado: false, motivo: "gateway inacessivel" }; }
  if (!/"?whatsapp"?\s*:\s*"?connected/i.test(`${st.stdout}`)) return { enviado: false, motivo: "gateway sem whatsapp: connected" };

  // Agenda ANTES do claim: se a leitura travar ou falhar, nada foi reivindicado (nenhuma linha fica 'enviando').
  let salvos;
  try { salvos = await comTimeout(Promise.resolve().then(agenda), timeoutAgendaMs, "agenda excedeu o tempo limite"); } catch { return { enviado: false, motivo: "agenda_local_indisponivel" }; }

  const [item] = await db.rows(`select * from wa.reivindicar_envio_resposta()`);
  if (!item) return { enviado: false, motivo: "nada a enviar (fila vazia, chave desligada ou ritmo)" };

  const base = { fila_id: item.fila_id, hash: String(item.texto_hash).slice(0, 8), caracteres: String(item.texto ?? "").length };
  const falhar = async (erro) => { await concluir(db, item.fila_id, false, { erro }); return { enviado: false, motivo: erro, ...base }; };

  if (sha256(item.texto) !== item.texto_hash) return falhar("hash_divergente");
  if (!JID_DM.test(String(item.destino_jid))) return falhar("destino_invalido");
  if (!salvos.has(item.destino_jid)) return falhar("fora_da_agenda_local");

  // Rechecagem do kill switch logo antes do envio (a janela entre o claim e o send existe). Falha fechada:
  // so o valor booleano false libera; qualquer outra coisa, ou erro de leitura, para. Nada saiu ainda.
  try {
    const [k] = await db.rows(`select valor from wa.config where chave = 'kill_switch_envio'`);
    if (!k || k.valor !== false) return falhar("kill_switch_ligado");
  } catch { return falhar("kill_switch_indisponivel"); }

  let enviou = false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wai-resp-"));
  const arq = path.join(dir, "mensagem.txt");
  fs.writeFileSync(arq, item.texto, { mode: 0o600 });
  try {
    const r = await exec(bin, [...prefix, "send", "--to", item.destino_jid, "--file", arq, "--idempotency-key", item.idempotency_key], { timeout: 30000, env });
    let recibo = {};
    try { recibo = JSON.parse(String(r.stdout)); } catch { /* resposta fora do padrao: tratada abaixo */ }
    // Daqui em diante a mensagem pode ter saido: qualquer falha vira interrompido_verificar (nao reaprovavel).
    if (recibo.sent !== true && recibo.duplicate !== true) return falhar(INCERTO);
    enviou = true;
    await concluir(db, item.fila_id, true, { messageId: recibo.messageId ?? null });
    return { enviado: true, duplicado: recibo.duplicate === true, ...base };
  } catch (e) {
    // Ja saiu pelo gateway mas o banco falhou ao registrar: nao marcar falha. A linha fica 'enviando' e o banco a
    // sinaliza como interrompida para conferencia humana; nunca ha novo envio automatico.
    if (enviou) throw new Error("envio feito, registro no banco falhou; conferir wa.fila_envio");
    // Recusa explicita do gateway (flag desligada, JID invalido, erro de uso): nada saiu, volta a ser reaprovavel.
    const recusa = recusaDoGateway(e);
    if (recusa) return falhar(`gateway_recusou: ${recusa}`);
    // Timeout, exit diferente de zero sem marca de recusa ou erro de execucao: pode ter saido. Nao e reaprovavel.
    return falhar(INCERTO);
  } finally {
    fs.unlinkSync(arq);
    fs.rmdirSync(dir);
  }
}
