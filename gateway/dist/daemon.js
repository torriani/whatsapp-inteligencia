import fs from 'node:fs/promises';
import http from 'node:http';
import { ensurePrivate, readJson, writeJson, writePrivate } from './files.js';
import { resolveGroup, idempotencyKey } from './logic.js';
import { appPaths } from './paths.js';
import { FakeBackend } from './fake-backend.js';
// Envio por --to (contato individual): desligado por padrao. Liga com WAI_GATEWAY_ALLOW_SEND_TO=1 no ambiente do daemon.
const JID_INDIVIDUAL = /^[0-9A-Za-z._-]+@(s\.whatsapp\.net|lid)$/;
// Serializa leitura+gravacao do ledger (a chamada de envio fica FORA da trava).
let ledgerChain = Promise.resolve();
function withLedger(fn) { const r = ledgerChain.then(fn); ledgerChain = r.catch(() => { }); return r; }
function reply(res, code, value) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }
async function body(req) { let raw = ''; for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_100_000)
        throw new Error('Requisição excede o limite.');
} return raw ? JSON.parse(raw) : {}; }
export async function runDaemon(backend) {
    const paths = appPaths();
    await ensurePrivate(paths);
    // Never remove another daemon's socket. A crash leaves a lock requiring review.
    const lockPath = `${paths.ledger}.lock`;
    let lock;
    try { lock = await fs.open(lockPath, 'wx', 0o600); }
    catch (error) { throw new Error(`Gateway lock unavailable (${lockPath}): ${error.message}. Stop the existing daemon; after a crash verify its PID before removing the lock.`); }
    await lock.writeFile(`${process.pid}\n`);
    await lock.sync();
    const releaseLock = async () => { await lock.close(); await fs.rm(lockPath, { force: true }); };
    const readLedger = async () => {
        const ledger = await readJson(paths.ledger, {});
        if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger) ||
            Object.values(ledger).some(entry => !entry || typeof entry !== 'object' ||
                !(entry.status === 'pending' || (typeof entry.messageId === 'string' && typeof entry.sentAt === 'string'))))
            throw new Error('Ledger inválido; envios bloqueados. Restaure um backup verificado.');
        return ledger;
    };
    try { await readLedger(); } catch (error) { await releaseLock(); throw error; }
    let gateway;
    try {
        gateway = backend ?? (process.env.WAI_GATEWAY_FAKE === '1' ? new FakeBackend() : new (await import('./baileys.js')).BaileysBackend(paths));
        await writePrivate(paths.pid, `${process.pid}\n`);
    } catch (error) { await releaseLock(); throw error; }
    const server = http.createServer(async (req, res) => {
        try {
            if (req.method === 'GET' && req.url === '/status')
                return reply(res, 200, { service: 'running', whatsapp: await gateway.status(), pid: process.pid, version: '0.2.0' });
            if (req.method === 'POST' && req.url === '/channel/connect') {
                await gateway.connect();
                return reply(res, 200, { connected: true, whatsapp: await gateway.status() });
            }
            if (req.method === 'POST' && req.url === '/channel/disconnect') {
                await gateway.disconnect();
                return reply(res, 200, { connected: false, whatsapp: await gateway.status() });
            }
            if (req.method === 'POST' && req.url === '/channel/logout') {
                await gateway.logout();
                return reply(res, 200, { loggedOut: true, whatsapp: await gateway.status() });
            }
            if (req.method === 'GET' && req.url === '/groups')
                return reply(res, 200, { groups: await gateway.groups() });
            if (req.method === 'POST' && req.url === '/send') {
                const input = await body(req);
                const text = String(input.text ?? '');
                if (!text.trim())
                    throw new Error('Arquivo vazio; envio cancelado.');
                if (Buffer.byteLength(text) > 1_000_000)
                    throw new Error('Arquivo excede 1 MB.');
                if (input.to !== undefined && input.to !== null) {
                    if (process.env.WAI_GATEWAY_ALLOW_SEND_TO !== '1')
                        throw new Error('RECUSADO: Envio por --to desligado neste gateway.');
                    if (input.group)
                        throw new Error('RECUSADO: Use --group ou --to, nunca os dois.');
                    const to = String(input.to).trim();
                    if (!JID_INDIVIDUAL.test(to))
                        throw new Error('RECUSADO: Destino --to deve ser um JID de contato individual.');
                    if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim())
                        throw new Error('RECUSADO: --to exige idempotency-key.');
                    // Prefixo proprio: a chave de --to nunca colide com a de --group no mesmo ledger.
                    const keyTo = `to:${input.idempotencyKey.trim()}`;
                    // Reserva 'pending' ANTES de enviar. Chave ja existente: duplicada (enviada) ou pendente (incerta, NAO reenvia).
                    const reserva = await withLedger(async () => {
                        const ledgerTo = await readLedger();
                        const atual = ledgerTo[keyTo];
                        if (atual)
                            return atual;
                        ledgerTo[keyTo] = { to, status: 'pending', reservedAt: new Date().toISOString() };
                        await writeJson(paths.ledger, ledgerTo);
                        return null;
                    });
                    if (reserva?.status === 'pending')
                        return reply(res, 409, { sent: false, duplicate: false, pending: true, error: 'Envio anterior com esta chave ficou pendente: verificar no WhatsApp antes de qualquer reenvio.' });
                    if (reserva)
                        return reply(res, 200, { sent: false, duplicate: true, ...reserva });
                    let resTo;
                    try {
                        resTo = await gateway.send(to, text);
                    }
                    catch {
                        // Pode ter saido: a reserva fica 'pending' de proposito.
                        return reply(res, 502, { sent: false, duplicate: false, pending: true, error: 'Envio incerto: a chave ficou pendente. Verificar no WhatsApp.' });
                    }
                    const gravado = { to, messageId: resTo.messageId, sentAt: new Date().toISOString() };
                    await withLedger(async () => { const l = await readLedger(); l[keyTo] = gravado; await writeJson(paths.ledger, l); });
                    return reply(res, 200, { sent: true, duplicate: false, ...gravado });
                }
                const group = resolveGroup(await gateway.groups(), String(input.group ?? ''));
                const key = `group:${idempotencyKey(group.id, text, typeof input.idempotencyKey === 'string' ? input.idempotencyKey : undefined)}`;
                const existente = await withLedger(async () => {
                    const ledger = await readLedger();
                    if (Object.hasOwn(ledger, key)) return ledger[key];
                    Object.defineProperty(ledger, key, { value: { groupId: group.id, status: 'pending', reservedAt: new Date().toISOString() }, enumerable: true, writable: true, configurable: true });
                    await writeJson(paths.ledger, ledger);
                    return null;
                });
                if (existente?.status === 'pending')
                    return reply(res, 409, { sent: false, pending: true, error: 'Envio pendente: verificar no WhatsApp antes de reenviar.' });
                if (existente) return reply(res, 200, { sent: false, duplicate: true, ...existente });
                let result;
                try { result = await gateway.send(group.id, text); }
                catch { return reply(res, 502, { sent: false, pending: true, error: 'Envio incerto: a chave ficou pendente. Verificar no WhatsApp.' }); }
                const gravado = { groupId: group.id, messageId: result.messageId, sentAt: new Date().toISOString() };
                await withLedger(async () => { const l = await readLedger(); l[key] = gravado; await writeJson(paths.ledger, l); });
                return reply(res, 200, { sent: true, duplicate: false, ...gravado });
            }
            reply(res, 404, { error: 'Rota não encontrada.' });
        }
        catch (error) {
            reply(res, 400, { error: error?.message ?? 'Erro interno.' });
        }
    });
    let stopping;
    const shutdown = () => stopping ??= (async () => {
        await new Promise(resolve => server.close(resolve));
        try { await gateway.close(); }
        finally { await fs.rm(paths.pid, { force: true }); await releaseLock(); }
    })();
    const onSignal = () => { void shutdown().finally(() => process.exit(0)); };
    try {
        await new Promise((resolve, reject) => server.listen(paths.socket, resolve).once('error', reject));
        await fs.chmod(paths.socket, 0o600);
    } catch (error) { await gateway.close(); await releaseLock(); throw error; }
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
    return { paths, close: async () => {
        process.removeListener('SIGTERM', onSignal);
        process.removeListener('SIGINT', onSignal);
        await shutdown();
    } };
}
