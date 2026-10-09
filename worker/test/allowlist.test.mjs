import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolverChats, ALLOWLIST_PADRAO, norm, carregarAllowlist } from "../src/allowlist.mjs";

// Nomes fictícios. A lista real vive só em ~/.wa-intelligence/whatsapp-allowlist.json.
const ALLOW = {
  ...ALLOWLIST_PADRAO,
  allow: [
    { nome: "Grupo Alfa", match: "exato", modo: "inteligencia", backfill_dias: 90 },
    { nome: "Time Beta Equipe", match: "prefixo", modo: "registrar" },
    { nome: "Comunidade Gama IA", match: "contem", modo: "registrar" },
  ],
};
const s = (pk, nome, tipo = 1, jid = `${pk}@g.us`) => ({ pk, nome, tipo, jid, removido: false });

test("modelo padrao vem vazio (nenhum nome de grupo no repo)", () => {
  assert.deepEqual(ALLOWLIST_PADRAO.allow, []);
  assert.equal(resolverChats(ALLOWLIST_PADRAO, [s(1, "Grupo Alfa")]).length, 0);
});

test("negacao por padrao e regras de nome", () => {
  const sessoes = [
    s(1, "Grupo Alfa"), s(2, "Grupo Alfa"), s(3, "Grupo Alfa Extra"), s(4, "Time Beta Equipe (01/10) #2"),
    s(5, "\u{1f916} Comunidade Gama IA | Profissionais"), s(6, "Familia Fulano"),
    s(7, "Grupo Alfa", 0, "5511999999999@s.whatsapp.net"), s(8, "Grupo Alfa", 4),
  ];
  const r = resolverChats(ALLOW, sessoes);
  assert.deepEqual(r.map((c) => c.pk), [1, 2, 4, 5]);
  assert.equal(r[0].backfill_dias, 90);
});

test("deny_always vence e removidos saem", () => {
  const al = { ...ALLOW, deny_always: ["Grupo Alfa"] };
  assert.equal(resolverChats(al, [s(1, "Grupo Alfa")]).length, 0);
  assert.equal(resolverChats(ALLOW, [{ ...s(1, "Grupo Alfa"), removido: true }]).length, 0);
});

test("DM nunca, mesmo se listada ou com tipo permitido", () => {
  const al = { ...ALLOW, allow: [{ nome: "Fulano", match: "exato" }], tipos_sessao_permitidos: [0, 1] };
  assert.equal(resolverChats(al, [s(1, "Fulano", 0, "55@s.whatsapp.net")]).length, 0);
});

test("arquivo ausente falha fechado e permissao frouxa e recusada", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wai-al-"));
  const f = path.join(dir, "al.json");
  assert.throws(() => carregarAllowlist(f), /ausente/);
  fs.writeFileSync(f, JSON.stringify(ALLOW), { mode: 0o644 });
  fs.chmodSync(f, 0o644);
  assert.throws(() => carregarAllowlist(f), /Permissao insegura/);
  fs.chmodSync(f, 0o600);
  assert.equal(carregarAllowlist(f).allow.length, 3);
  fs.unlinkSync(f); fs.rmdirSync(dir);
});

test("norm", () => assert.equal(norm("ÁGUA 10K MÊS"), "agua 10k mes"));
