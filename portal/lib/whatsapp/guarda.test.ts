import assert from "node:assert/strict";
import test from "node:test";

// react/cache e next/navigation não rodam fora do Next: a guarda importa ambos.
// Testamos pela função pura exportada, com dependências injetadas.
async function carregar() {
  return import("./guarda");
}

test("admin passa pela guarda sem negar", async () => {
  const { exigirAdminWhatsapp } = await carregar();
  let negou = false;
  await exigirAdminWhatsapp({
    verificarAdmin: async () => true,
    negar: () => {
      negou = true;
      throw new Error("negado");
    },
  });
  assert.equal(negou, false);
});

test("não admin é negado", async () => {
  const { exigirAdminWhatsapp } = await carregar();
  await assert.rejects(
    exigirAdminWhatsapp({
      verificarAdmin: async () => false,
      negar: () => {
        throw new Error("NEXT_NOT_FOUND");
      },
    }),
    /NEXT_NOT_FOUND/,
  );
});

test("falha ao verificar admin propaga erro e não libera acesso", async () => {
  const { exigirAdminWhatsapp } = await carregar();
  await assert.rejects(
    exigirAdminWhatsapp({
      verificarAdmin: async () => {
        throw new Error("falha de rede");
      },
      negar: () => {
        throw new Error("NEXT_NOT_FOUND");
      },
    }),
    /falha de rede/,
  );
});
