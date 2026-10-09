import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runDaemon } from '../dist/daemon.js';
import { FakeBackend } from '../dist/fake-backend.js';
import { requestSocket } from '../dist/http.js';
import { writeJson } from '../dist/files.js';

test('isolated fake gateway: durable reservations, corruption and singleton', async () => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wai-test-'));
 const old = { ...process.env };
 process.env.WAI_GATEWAY_DATA_DIR = dir;
 process.env.WAI_GATEWAY_RUNTIME_DIR = path.join(dir, 'run');
 process.env.WAI_GATEWAY_ALLOW_SEND_TO = '1';
 let daemon;
 try {
  let sends = 0;
  const fake = new FakeBackend();
  fake.send = async () => { sends++; await new Promise(r => setTimeout(r, 30)); return { messageId: 'fake' }; };
  daemon = await runDaemon(fake);
  const send = body => requestSocket(daemon.paths.socket, 'POST', '/send', body);
  for (const destination of [{ group: 'Grupo Teste' }, { to: '123@s.whatsapp.net' }]) {
   const input = { ...destination, text: 'test', idempotencyKey: 'same' };
   const results = await Promise.allSettled([send(input), send(input)]);
   assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
   assert.equal((await send(input)).duplicate, true);
  }
  assert.equal(sends, 2);
  await assert.rejects(runDaemon(new FakeBackend()), /lock unavailable/);
  assert.equal((await requestSocket(daemon.paths.socket, 'GET', '/status')).service, 'running');
  fake.send = async () => { sends++; throw Error('uncertain'); };
  for (const destination of [{ group: 'Grupo Teste' }, { to: '123@s.whatsapp.net' }]) {
   const input = { ...destination, text: 'test', idempotencyKey: 'uncertain' };
   await assert.rejects(send(input), /incerto/);
   await assert.rejects(send(input), /pendente/);
  }
  assert.equal(sends, 4);
  const ledger = JSON.parse(await fs.readFile(daemon.paths.ledger, 'utf8'));
  assert.equal(ledger['group:uncertain'].status, 'pending');
  assert.equal(ledger['to:uncertain'].status, 'pending');
  assert.equal((await fs.stat(daemon.paths.ledger)).mode & 0o777, 0o600);
  await fs.writeFile(daemon.paths.ledger, '[]');
  await assert.rejects(send({ group: 'Grupo Teste', text: 'new' }), /inválido/);
  assert.equal(sends, 4);
  await daemon.close(); daemon = undefined;
  await assert.rejects(runDaemon(fake), /inválido/);
  await writeJson(path.join(dir, 'send-ledger.json'), ledger);
  daemon = await runDaemon(fake);
  await assert.rejects(send({ group: 'Grupo Teste', text: 'test', idempotencyKey: 'uncertain' }), /pendente/);
  assert.equal(sends, 4);
 } finally {
  await daemon?.close();
  for (const key of ['WAI_GATEWAY_DATA_DIR', 'WAI_GATEWAY_RUNTIME_DIR', 'WAI_GATEWAY_ALLOW_SEND_TO']) {
   if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
  }
  await fs.rm(dir, { recursive: true, force: true });
 }
});
