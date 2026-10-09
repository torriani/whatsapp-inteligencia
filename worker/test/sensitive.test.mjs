import test from "node:test";
import assert from "node:assert/strict";
import { classify, compilarTermos } from "../src/sensitive.mjs";

const ghp = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const sk = "sk-" + "proj1234567890abcdefgh";
const jwt = "eyJ" + "hbGciOiJIUzI1NiJ9.payload";

test("credenciais viram sensivel", () => {
  for (const t of [`token ${ghp}`, `use ${sk}`, `Authorization ${jwt}`, "AKIA" + "ABCDEFGHIJKLMNOP"]) {
    assert.equal(classify(t).sensivel, true, t.slice(0, 8));
  }
});

test("senha atribuida", () => {
  assert.equal(classify("a senha é Xk29fj10").sensivel, true);
  assert.equal(classify("password: abc12345").sensivel, true);
  assert.equal(classify("senha do wifi abc123xyz").sensivel, true);
});

test("cartao por Luhn e CPF valido", () => {
  assert.equal(classify("cartao 4111 1111 1111 1111").regra, "cartao");
  assert.equal(classify("cpf 529.982.247-25").regra, "cpf");
  assert.equal(classify("cpf 111.111.111-11").sensivel, false);
  assert.equal(classify("numero 1234 5678 9012 3456").sensivel, false);
});

test("boleto e pix", () => {
  assert.equal(classify("23793.38128 60000.000003 00000.000408 1 84340000012345").regra, "boleto");
  assert.equal(classify("chave pix 123e4567-e89b-12d3-a456-426614174000").regra, "pix");
});

test("conversa normal passa", () => {
  assert.equal(classify("Bora marcar a aula de quinta às 19h? Segue o link https://exemplo.com/x").sensivel, false);
  assert.equal(classify("não esqueci minha senha hoje").sensivel, false);
});

test("termos pessoais valem so para mensagens do dono ou DM", () => {
  assert.equal(classify("preciso pagar a dívida do banco", { fromMe: false }).sensivel, false);
  assert.equal(classify("preciso pagar a dívida do banco", { fromMe: true }).regra, "termo_pessoal");
  assert.equal(classify("preciso pagar a dívida do banco", { termosEmTodas: true }).sensivel, true);
});

test("lista local de termos", () => {
  const termosRegex = compilarTermos(["Credor Ficticio"]);
  assert.equal(classify("falei com o credor ficticio", { fromMe: true, termosRegex }).regra, "termo_lista_local");
  assert.equal(classify("falei com o credor ficticio", { fromMe: false, termosRegex }).sensivel, false);
});

test("texto vazio", () => {
  assert.equal(classify(null).sensivel, false);
});

test("numero dentro de URL nao e cartao", () => {
  assert.equal(classify("veja https://exemplo.com/p/4111111111111111/ ok").sensivel, false);
});
