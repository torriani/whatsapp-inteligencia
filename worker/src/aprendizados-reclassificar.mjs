// Reclassifica aprendizados candidatos pelos temas de wa.config: descarta suporte e fora de tema
// (status 'descartado', nunca apaga linha), encurta os mantidos e atribui tema.
// Sempre grava backup JSON antes de aplicar; --rollback restaura a partir dele.
import fs from "node:fs";
import path from "node:path";
import { lit, jsonLit } from "./db.mjs";
import { chamarClaude, extrairJson } from "./llm.mjs";
import { STATE_DIR } from "./paths.mjs";
import { carregarTemas, encurtar, listaTemasPrompt, LIMITE_CORPO } from "./temas.mjs";

const LOTE = 15;
export const MOTIVOS = ["suporte", "fora_do_tema"];

export function montarPrompt(temas, itens) {
  return `Voce reclassifica aprendizados extraidos de grupos de WhatsApp para o dono do negocio. So interessam aprendizados ligados a estes temas:
${listaTemasPrompt(temas)}
Para cada item decida:
- "manter": ensina algo ligado a um tema. Devolva "tema" (exatamente um nome da lista) e "corpo" reescrito mais curto, uma ou duas frases, no maximo ${LIMITE_CORPO} caracteres. Use somente informacoes que ja estao no item. Nao invente, nao acrescente exemplo, numero ou ferramenta que nao esteja nele.
- "suporte": duvida de acesso, login, instalacao ou erro de uso de um produto, reembolso, pedido de ajuda de aluno, logistica de aula ou encontro, aviso operacional.
- "fora_do_tema": so o que realmente nao se liga a nenhum tema da lista.
Tecnica, pratica ou comparacao sobre agentes, ferramentas, repositorios, modelos, vendas, copy ou video e tema, mesmo quando o exemplo vem de um produto especifico. Portugues do Brasil com acentos, sem travessao, sem emoji.
Devolva JSON: {"itens":[{"id":<numero>,"decisao":"manter"|"suporte"|"fora_do_tema","tema":<nome ou null>,"corpo":<texto ou null>}]} com um objeto por item recebido.

Itens:
${itens.map((i) => `#${i.id} (${i.chat_nome}) ${i.titulo}: ${i.corpo}`).join("\n")}`;
}

const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const raizes = (s) => norm(s).match(/[a-z0-9]{5,}/g) || [];

// Guarda de fidelidade: o texto novo nao pode trazer termos de peso que o original nao tem.
export function fiel(novo, original, minimo = 0.7) {
  const base = new Set(raizes(original).map((w) => w.slice(0, 5)));
  const termos = raizes(novo).map((w) => w.slice(0, 5));
  if (!termos.length) return true;
  return termos.filter((w) => base.has(w)).length / termos.length >= minimo;
}

// Valida a decisao do modelo para um item. Devolve { id, status, tema, corpo, motivo_descarte } ou null (nao processado).
export function validarDecisao(d, item, temas) {
  if (!d || Number(d.id) !== Number(item.id)) return null;
  if (MOTIVOS.includes(d.decisao)) return { id: item.id, status: "descartado", tema: null, corpo: item.corpo, motivo_descarte: d.decisao };
  if (d.decisao !== "manter") return null;
  const tema = temas.find((t) => t.nome.toLowerCase() === String(d.tema ?? "").trim().toLowerCase());
  if (!tema) return null;
  // Reescrita ausente, longa ou infiel ao original: cai para o proprio texto, cortado em fim de frase.
  let corpo = encurtar(d.corpo);
  if (!corpo || !fiel(corpo, `${item.titulo} ${item.corpo}`)) corpo = encurtar(item.corpo);
  if (!corpo) return null;
  return { id: item.id, status: "candidato", tema: tema.nome, corpo, motivo_descarte: null };
}

export function contagens(antes, plano) {
  const porTema = {};
  const descartados = { suporte: 0, fora_do_tema: 0 };
  let mantidos = 0;
  for (const p of plano) {
    if (p.status === "descartado") descartados[p.motivo_descarte]++;
    else { mantidos++; porTema[p.tema] = (porTema[p.tema] || 0) + 1; }
  }
  return { antes: antes.length, mantidos, por_tema: porTema, descartados, nao_processados: antes.length - plano.length };
}

const COLUNAS = "id, chat_id, titulo, corpo, tags, fontes, confianca, status, tema, motivo_descarte, criado_em, atualizado_em";

export async function planejar({ db, temas, llm = chamarClaude, modelo = "sonnet", log = () => {} }) {
  const itens = await db.rows(`select a.id, c.nome as chat_nome, a.titulo, a.corpo from wa.aprendizados a join wa.chats c on c.id = a.chat_id
    where a.status = 'candidato' and a.tema is null and c.tipo <> 'direto' order by a.id`);
  const plano = []; let custo = 0;
  for (let i = 0; i < itens.length; i += LOTE) {
    let pendentes = itens.slice(i, i + LOTE);
    // 1a tentativa com o lote inteiro; as seguintes em grupos menores, para isolar resposta ilegivel.
    for (const tamanho of [LOTE, 5, 1, 1]) {
      if (!pendentes.length) break;
      const sobra = [];
      for (let j = 0; j < pendentes.length; j += tamanho) {
        const grupo = pendentes.slice(j, j + tamanho);
        let decs = [];
        try {
          const r = await llm(montarPrompt(temas, grupo), { modelo });
          custo += r.custo || 0;
          decs = extrairJson(r.texto).itens || [];
        } catch { /* resposta ilegivel ou falha da chamada: o grupo volta na proxima rodada, menor */ }
        for (const it of grupo) {
          const p = validarDecisao(decs.find((d) => Number(d.id) === Number(it.id)), it, temas);
          if (p) plano.push(p); else sobra.push(it);
        }
      }
      pendentes = sobra;
    }
    log(`lote ${Math.floor(i / LOTE) + 1}: ${plano.length} decididos de ${Math.min(i + LOTE, itens.length)}`);
  }
  return { itens, plano, custo };
}

export function gravarBackup(rows, dir = path.join(STATE_DIR, "backups")) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `aprendizados-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(rows), { mode: 0o600 });
  return file;
}

// Atualiza so tema, corpo, status e motivo_descarte, por id, numa transacao.
export function sqlAtualizar(linhas) {
  return `begin;
update wa.aprendizados a set tema = x.tema, corpo = x.corpo, status = x.status, motivo_descarte = x.motivo_descarte
from jsonb_to_recordset(${jsonLit(linhas)}) as x(id bigint, tema text, corpo text, status text, motivo_descarte text)
where a.id = x.id;
commit;`;
}

export async function reclassificar({ db, aplicar = false, llm, log = console.log }) {
  const temas = await carregarTemas(db);
  if (!temas.length) throw new Error("wa.config[aprendizado_temas] vazio ou ausente");
  const { itens, plano, custo } = await planejar({ db, temas, llm, log });
  const resumo = { ...contagens(itens, plano), custo_usd: Number(custo.toFixed(4)) };
  if (!aplicar) return { aplicado: false, resumo, plano };
  const backup = gravarBackup(await db.rows(`select ${COLUNAS} from wa.aprendizados order by id`));
  await db.exec(sqlAtualizar(plano.map(({ id, tema, corpo, status, motivo_descarte }) => ({ id, tema, corpo, status, motivo_descarte }))));
  return { aplicado: true, backup, resumo };
}

export async function rollback({ db, arquivo }) {
  const rows = JSON.parse(fs.readFileSync(arquivo, "utf8"));
  const linhas = rows.map((r) => ({ id: r.id, tema: r.tema ?? null, corpo: r.corpo, status: r.status, motivo_descarte: r.motivo_descarte ?? null }));
  await db.exec(sqlAtualizar(linhas));
  return { restaurados: linhas.length };
}
