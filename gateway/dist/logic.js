import crypto from 'node:crypto';
export function resolveGroup(groups, target) {
    const value = target.trim();
    if (!value)
        throw new Error('Destino explícito é obrigatório.');
    const exactId = groups.filter(g => g.id === value);
    const exactName = groups.filter(g => g.name.localeCompare(value, undefined, { sensitivity: 'accent' }) === 0);
    const matches = exactId.length ? exactId : exactName;
    if (matches.length !== 1)
        throw new Error(matches.length ? 'Destino ambíguo; use o ID exato do grupo.' : 'Grupo não encontrado; execute groups e use nome exato ou ID.');
    if (!matches[0].id.endsWith('@g.us'))
        throw new Error('Destino não é um grupo WhatsApp válido.');
    return matches[0];
}
export function idempotencyKey(groupId, text, supplied) {
    if (supplied?.trim())
        return supplied.trim();
    return crypto.createHash('sha256').update(`${groupId}\0${text}`).digest('hex');
}
