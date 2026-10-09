import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG_PADRAO } from "../src/config.mjs";
import { enviarResumo } from "../src/sender.mjs";
test("standalone starts closed without destination or database identity", async () => {
 assert.equal(CONFIG_PADRAO.dm.ativo, false);
 assert.equal(CONFIG_PADRAO.ENVIO_ATIVO, false);
 assert.equal(CONFIG_PADRAO.notificacao.grupo, "");
 assert.equal(CONFIG_PADRAO.banco.ref, "");
 const r = await enviarResumo({texto:"fixture",dia:"2026-10-09",config:CONFIG_PADRAO,dryRun:false,exec:()=>{throw new Error("must not call gateway")}});
 assert.equal(r.enviado,false);
});
