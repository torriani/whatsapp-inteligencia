import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appPaths } from './paths.js';
import { ensurePrivate, writePrivate } from './files.js';
const label = 'local.wai.whatsapp-gateway';
function domain() { const uid = process.getuid?.(); if (uid === undefined)
    throw new Error('LaunchAgent requer macOS/Unix com UID.'); return `gui/${uid}`; }
function daemonPath() { return fileURLToPath(new URL('./daemon-entry.js', import.meta.url)); }
function launchctl(...args) { return spawnSync('/bin/launchctl', args, { encoding: 'utf8' }); }
function xml(value) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
export async function installService() {
    if (process.platform !== 'darwin')
        throw new Error('MVP suportado somente no macOS.');
    const p = appPaths();
    await ensurePrivate(p);
    await fs.mkdir(path.dirname(p.launchAgent), { recursive: true });
    const environment = [['WAI_GATEWAY_DATA_DIR', process.env.WAI_GATEWAY_DATA_DIR], ['WAI_GATEWAY_RUNTIME_DIR', process.env.WAI_GATEWAY_RUNTIME_DIR], ['WAI_GATEWAY_FAKE', process.env.WAI_GATEWAY_FAKE]].filter((item) => Boolean(item[1]));
    const environmentXml = environment.length ? `<key>EnvironmentVariables</key><dict>${environment.map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join('')}</dict>` : '';
    const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(daemonPath())}</string></array>${environmentXml}<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${xml(p.log)}</string><key>StandardErrorPath</key><string>${xml(p.log)}</string><key>Umask</key><integer>63</integer></dict></plist>\n`;
    await writePrivate(p.launchAgent, plist);
    return p.launchAgent;
}
export async function startService() {
    const p = appPaths();
    if (process.env.WAI_GATEWAY_DIRECT === '1') {
        const child = spawn(process.execPath, [daemonPath()], { detached: true, stdio: 'ignore', env: process.env });
        child.unref();
        return;
    }
    await fs.access(p.launchAgent).catch(() => { throw new Error('Serviço não instalado. Execute install.'); });
    launchctl('bootout', `${domain()}/${label}`);
    const result = launchctl('bootstrap', domain(), p.launchAgent);
    if (result.status !== 0)
        throw new Error(result.stderr.trim() || 'Falha ao iniciar LaunchAgent.');
}
export async function stopService() {
    const p = appPaths();
    if (process.env.WAI_GATEWAY_DIRECT === '1') {
        try {
            const pid = Number((await fs.readFile(p.pid, 'utf8')).trim());
            process.kill(pid, 'SIGTERM');
        }
        catch (error) {
            if (error?.code !== 'ENOENT' && error?.code !== 'ESRCH')
                throw error;
        }
        return;
    }
    launchctl('bootout', `${domain()}/${label}`);
}
export async function uninstallService(purge = false) {
    const p = appPaths();
    await stopService();
    await fs.rm(p.launchAgent, { force: true });
    if (purge) {
        const target = path.join(p.trash, `WA Intelligence Gateway ${new Date().toISOString().replaceAll(':', '-')}`);
        await fs.mkdir(p.trash, { recursive: true });
        await fs.rename(p.data, target).catch((error) => { if (error?.code !== 'ENOENT')
            throw error; });
        return target;
    }
}
