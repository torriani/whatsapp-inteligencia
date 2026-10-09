#!/usr/bin/env node
import fs from 'node:fs/promises';
import qrcode from 'qrcode-terminal';
import { appPaths } from './paths.js';
import { requestSocket } from './http.js';
import { installService, startService, stopService, uninstallService } from './service.js';
import { BaileysBackend } from './baileys.js';
import { ensurePrivate } from './files.js';
function option(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
function usage() { console.log('Uso: wa-gateway <install|pair|channel|start|stop|restart|status|groups|send|logs|doctor|uninstall>'); }
async function waitForDaemon() { const p = appPaths(); for (let i = 0; i < 40; i++) {
    try {
        await requestSocket(p.socket, 'GET', '/status');
        return;
    }
    catch {
        await new Promise(r => setTimeout(r, 100));
    }
} throw new Error('Daemon não ficou pronto. Execute logs e doctor.'); }
async function main() {
    const [command, ...args] = process.argv.slice(2);
    const p = appPaths();
    if (!command || command === '--help' || command === 'help')
        return usage();
    if (command === '--version')
        return console.log('0.2.0');
    if (command === 'install' || (command === 'setup')) {
        const file = await installService();
        await startService();
        await waitForDaemon();
        console.log(`Instalado: ${file}`);
        return;
    }
    if (command === 'start') {
        await startService();
        await waitForDaemon();
        console.log('Serviço iniciado.');
        return;
    }
    if (command === 'stop') {
        await stopService();
        console.log('Serviço parado.');
        return;
    }
    if (command === 'restart') {
        await stopService();
        await startService();
        await waitForDaemon();
        console.log('Serviço reiniciado.');
        return;
    }
    if (command === 'status') {
        console.log(JSON.stringify(await requestSocket(p.socket, 'GET', '/status'), null, 2));
        return;
    }
    if (command === 'channel') {
        const [action] = args;
        if (action === 'status') {
            console.log(JSON.stringify(await requestSocket(p.socket, 'GET', '/status'), null, 2));
            return;
        }
        if (action === 'connect') {
            try {
                console.log(JSON.stringify(await requestSocket(p.socket, 'POST', '/channel/connect'), null, 2));
            }
            catch (error) {
                const message = error instanceof Error ? error.message : '';
                if (!message.includes('não pareado'))
                    throw error;
                const backend = new BaileysBackend(p);
                await backend.pair(qr => qrcode.generate(qr, { small: true }));
                await backend.close();
                await stopService();
                await startService();
                await waitForDaemon();
                console.log(JSON.stringify(await requestSocket(p.socket, 'POST', '/channel/connect'), null, 2));
            }
            return;
        }
        if (action === 'disconnect') {
            console.log(JSON.stringify(await requestSocket(p.socket, 'POST', '/channel/disconnect'), null, 2));
            return;
        }
        if (action === 'logout') {
            console.log(JSON.stringify(await requestSocket(p.socket, 'POST', '/channel/logout'), null, 2));
            return;
        }
        throw new Error('Uso: channel <connect|disconnect|status|logout>');
    }
    if (command === 'groups') {
        const result = await requestSocket(p.socket, 'GET', '/groups');
        for (const g of result.groups)
            console.log(`${g.name}\t${g.id}`);
        return;
    }
    if (command === 'send') {
        const group = option(args, '--group');
        const to = option(args, '--to');
        const file = option(args, '--file');
        if (!file || !group === !to || (to && !option(args, '--idempotency-key')))
            throw new Error('RECUSADO: uso: send (--group <nome-ou-id> | --to <jid> --idempotency-key <chave>) --file <arquivo> [--idempotency-key <chave>]');
        const text = await fs.readFile(file, 'utf8');
        console.log(JSON.stringify(await requestSocket(p.socket, 'POST', '/send', { group, to, text, idempotencyKey: option(args, '--idempotency-key') }), null, 2));
        return;
    }
    if (command === 'pair') {
        await ensurePrivate(p);
        const backend = new BaileysBackend(p);
        await backend.pair(qr => qrcode.generate(qr, { small: true }));
        console.log('WhatsApp pareado. Reinicie o serviço.');
        await backend.close();
        return;
    }
    if (command === 'logs') {
        const raw = await fs.readFile(p.log, 'utf8').catch(() => 'Sem logs.\n');
        console.log(raw.split('\n').slice(-200).join('\n'));
        return;
    }
    if (command === 'doctor') {
        const checks = { platform: process.platform, node: process.version, dataDir: p.data, credentialsPresent: false, daemon: 'unavailable' };
        try {
            await fs.access(`${p.auth}/creds.json`);
            checks.credentialsPresent = true;
        }
        catch {
            checks.credentialsPresent = false;
        }
        try {
            checks.daemon = await requestSocket(p.socket, 'GET', '/status');
        }
        catch {
            checks.daemon = 'unavailable';
        }
        checks.secureDataPermissions = ((await fs.stat(p.data).catch(() => undefined))?.mode ?? 0) & 0o077 ? false : true;
        console.log(JSON.stringify(checks, null, 2));
        return;
    }
    if (command === 'uninstall') {
        const purge = args.includes('--purge');
        const moved = await uninstallService(purge);
        console.log(purge ? `Dados movidos para recuperação em: ${moved}` : 'Serviço removido; credenciais locais preservadas. Use --purge para movê-las ao Lixo.');
        return;
    }
    throw new Error(`Comando desconhecido: ${command}`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Erro desconhecido.'); process.exitCode = 1; });
