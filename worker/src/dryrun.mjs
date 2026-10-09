// Relatorio de CONTAGENS por grupo. Nenhum texto de mensagem sai daqui.
import fs from "node:fs";
import { TMP_DIR } from "./paths.mjs";
import { processar } from "./processar.mjs";
import { isoParaApple } from "./reader.mjs";

export async function rodarDryRun({ leitor, chats, ctx, janelaHoras = 72, agora = Date.now() }) {
  const desde = isoParaApple(agora - janelaHoras * 3600 * 1000);
  const grupos = [];
  for (const chat of chats) {
    const g = {
      grupo: chat.nome, pk: chat.pk, modo: chat.modo,
      mensagens: 0, texto: 0, midia: 0, eventos: 0, apagadas: 0, redigidas: 0,
      redigidas_por_regra: {}, links: 0, links_unicos: 0, dominios_distintos: 0, autores_distintos: 0,
      janela_72h: 0, por_tipo: {}, primeira: null, ultima: null,
    };
    const urls = new Set(); const doms = new Set(); const autores = new Set();
    let after = 0;
    for (;;) {
      const rows = await leitor.mensagensApos(chat.pk, after);
      if (!rows.length) break;
      for (const row of rows) {
        const r = processar(row, ctx);
        g.mensagens++;
        g.por_tipo[row.tipo] = (g.por_tipo[row.tipo] || 0) + 1;
        if (r.kind === "texto") g.texto++;
        else if (r.kind === "midia") g.midia++;
        else if (r.kind === "evento") g.eventos++;
        else if (r.kind === "apagada") g.apagadas++;
        else if (r.kind === "redigida") { g.redigidas++; g.redigidas_por_regra[r.regra] = (g.redigidas_por_regra[r.regra] || 0) + 1; }
        for (const l of r.links) { g.links++; urls.add(l.urlNorm); doms.add(l.dominio); }
        if (r.autor) autores.add(r.autor);
        if (row.data >= desde) g.janela_72h++;
        if (r.enviada_em) { if (!g.primeira || r.enviada_em < g.primeira) g.primeira = r.enviada_em; if (!g.ultima || r.enviada_em > g.ultima) g.ultima = r.enviada_em; }
        after = row.pk;
      }
      if (rows.length < 5000) break;
    }
    g.links_unicos = urls.size; g.dominios_distintos = doms.size; g.autores_distintos = autores.size;
    grupos.push(g);
  }
  const total = grupos.reduce((a, g) => ({ mensagens: a.mensagens + g.mensagens, redigidas: a.redigidas + g.redigidas, links: a.links + g.links }), { mensagens: 0, redigidas: 0, links: 0 });
  return { gerado_em: new Date(agora).toISOString(), janela_horas: janelaHoras, chats_liberados: chats.length, total, grupos };
}

export function gravarRelatorio(rel) {
  fs.mkdirSync(TMP_DIR, { recursive: true, mode: 0o700 });
  const file = `${TMP_DIR}/dry-run-${rel.gerado_em.replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(file, JSON.stringify(rel, null, 2), { mode: 0o600 });
  return file;
}
