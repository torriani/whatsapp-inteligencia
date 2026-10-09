import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export async function ensurePrivate(paths) {
    for (const dir of [paths.data, paths.runtime, paths.auth]) {
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        await fs.chmod(dir, 0o700);
    }
}
export async function writePrivate(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    let handle;
    try {
        handle = await fs.open(temporary, 'wx', 0o600);
        await handle.writeFile(value);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await fs.rename(temporary, file);
        const directory = await fs.open(path.dirname(file), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
    } finally {
        await handle?.close();
        await fs.rm(temporary, { force: true });
    }
}
export async function readJson(file, fallback) {
    try {
        return JSON.parse(await fs.readFile(file, 'utf8'));
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return fallback;
        throw error;
    }
}
export async function writeJson(file, value) {
    await writePrivate(file, `${JSON.stringify(value, null, 2)}\n`);
}
