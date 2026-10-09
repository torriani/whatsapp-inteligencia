import fs from 'node:fs/promises';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
const silentLogger = pino({ level: 'silent' });
export class BaileysBackend {
    paths;
    socket;
    constructor(paths) {
        this.paths = paths;
    }
    async hasCredentials() { try {
        await fs.access(`${this.paths.auth}/creds.json`);
        return true;
    }
    catch {
        return false;
    } }
    async ensureConnected(onQr) {
        if (this.socket?.user)
            return this.socket;
        const { state, saveCreds } = await useMultiFileAuthState(this.paths.auth);
        return new Promise((resolve, reject) => {
            const open = () => {
                const socket = makeWASocket({
                    auth: state, logger: silentLogger, printQRInTerminal: false,
                    syncFullHistory: false, shouldSyncHistoryMessage: () => false,
                    markOnlineOnConnect: false, generateHighQualityLinkPreview: false,
                    getMessage: async () => undefined
                });
                this.socket = socket;
                socket.ev.on('creds.update', saveCreds);
                socket.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
                    if (qr && onQr)
                        onQr(qr);
                    if (connection === 'open')
                        resolve(socket);
                    if (connection !== 'close')
                        return;
                    const code = lastDisconnect?.error?.output?.statusCode;
                    if (code === DisconnectReason.restartRequired || code === 515) {
                        open();
                        return;
                    }
                    this.socket = undefined;
                    reject(new Error(code === DisconnectReason.loggedOut ? 'Sessão encerrada pelo WhatsApp; execute pair novamente.' : `Conexão encerrada (${code ?? 'desconhecido'}).`));
                });
            };
            open();
        });
    }
    async pair(onQr) { await this.ensureConnected(onQr); }
    async connect() {
        if (!await this.hasCredentials())
            throw new Error('WhatsApp não pareado. Execute channel connect para abrir o QR.');
        await this.ensureConnected();
    }
    async disconnect() { await this.close(); }
    async logout() {
        if (await this.hasCredentials()) {
            const socket = await this.ensureConnected();
            await socket.logout();
        }
        this.socket = undefined;
        await fs.rm(this.paths.auth, { recursive: true, force: true });
        await fs.mkdir(this.paths.auth, { recursive: true, mode: 0o700 });
    }
    async status() { if (this.socket?.user)
        return 'connected'; return await this.hasCredentials() ? 'disconnected' : 'unpaired'; }
    async groups() {
        if (!await this.hasCredentials())
            throw new Error('WhatsApp não pareado. Execute pair primeiro.');
        const all = await (await this.ensureConnected()).groupFetchAllParticipating();
        return Object.values(all).map(group => ({ id: group.id, name: group.subject })).sort((a, b) => a.name.localeCompare(b.name));
    }
    async send(groupId, text) {
        const result = await (await this.ensureConnected()).sendMessage(groupId, { text });
        return { messageId: result?.key.id ?? null };
    }
    async close() { this.socket?.end(undefined); this.socket = undefined; }
}
