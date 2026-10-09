export class FakeBackend {
    channel = 'unpaired';
    groupList = [{ id: '120000000000000000@g.us', name: 'Grupo Teste' }];
    async pair(onQr) { onQr('TEST-QR-NOT-REAL'); }
    async connect() { this.channel = 'connected'; }
    async disconnect() { this.channel = 'disconnected'; }
    async logout() { this.channel = 'unpaired'; }
    async status() { return this.channel; }
    async groups() { return this.groupList; }
    async send(groupId, text) { void groupId; void text; return { messageId: 'TEST-MESSAGE-ID' }; }
    async close() { }
}
