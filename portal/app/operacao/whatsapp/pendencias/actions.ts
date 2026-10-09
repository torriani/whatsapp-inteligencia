"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth/is-admin";
import { createClient } from "@/lib/supabase/server";
import {
  aprovarRespostaPendencia,
  atualizarStatusPendencia,
  cancelarRespostaPendencia,
  definirEnvioRespostasAtivo,
  liberarReaprovacaoResposta,
  statusPendenciaFinal,
} from "@/lib/whatsapp/dados";

const ROTA = "/operacao/whatsapp/pendencias";

/** Volta para a tela com um aviso curto na URL (sem texto de mensagem). */
function voltar(aviso: { ok?: string; erro?: string }): never {
  const q = new URLSearchParams();
  if (aviso.ok) q.set("ok", aviso.ok);
  if (aviso.erro) q.set("erro", aviso.erro.slice(0, 200));
  redirect(`${ROTA}?${q.toString()}`);
}

/**
 * Fecha uma pendência de resposta (respondida ou descartada). Só admin: a checagem aqui
 * é a primeira barreira; a RLS e o grant por coluna do banco (wa.pendencias_resposta) são a segunda.
 */
export async function fecharPendenciaAction(formData: FormData): Promise<void> {
  if (!(await isAdmin())) return;

  const id = Number(formData.get("id"));
  const status = statusPendenciaFinal(formData.get("status"));
  if (!status) return;

  const supabase = await createClient();
  const r = await atualizarStatusPendencia(supabase, id, status);
  if (!r.ok) throw new Error(r.erro);

  revalidatePath(ROTA);
}

/**
 * Aprova a resposta que o dono escreveu. O texto vem só do formulário (nunca gerado por IA).
 * Só admin; o banco confere de novo (admin, contato salvo, pendência aberta, chave de envio ligada).
 */
export async function aprovarRespostaAction(formData: FormData): Promise<void> {
  if (!(await isAdmin())) return;
  const supabase = await createClient();
  const r = await aprovarRespostaPendencia(supabase, Number(formData.get("id")), String(formData.get("texto") ?? ""));
  revalidatePath(ROTA);
  if (!r.ok) voltar({ erro: r.erro });
  voltar({ ok: "Resposta aprovada. Ela será enviada em instantes, respeitando o ritmo de envio." });
}

/** Cancela o envio enquanto ele ainda não foi pego para envio. */
export async function cancelarRespostaAction(formData: FormData): Promise<void> {
  if (!(await isAdmin())) return;
  const supabase = await createClient();
  const r = await cancelarRespostaPendencia(supabase, Number(formData.get("fila_id")));
  revalidatePath(ROTA);
  if (!r.ok) voltar({ erro: r.erro });
  voltar(r.dados ? { ok: "Envio cancelado." } : { erro: "Não deu para cancelar: o envio já foi iniciado ou concluído." });
}

/** Libera nova aprovação depois de conferir no WhatsApp que a mensagem interrompida NÃO saiu. */
export async function liberarReaprovacaoAction(formData: FormData): Promise<void> {
  if (!(await isAdmin())) return;
  const supabase = await createClient();
  const r = await liberarReaprovacaoResposta(supabase, Number(formData.get("fila_id")));
  revalidatePath(ROTA);
  if (!r.ok) voltar({ erro: r.erro });
  voltar(r.dados ? { ok: "Nova aprovação liberada para esta pendência." } : { erro: "Não deu para liberar: o envio não está mais marcado como interrompido." });
}

/** Liga ou desliga a chave geral de envio de respostas (padrão desligada). */
export async function alternarEnvioRespostasAction(formData: FormData): Promise<void> {
  if (!(await isAdmin())) return;
  const supabase = await createClient();
  const r = await definirEnvioRespostasAtivo(supabase, formData.get("ativo") === "true");
  revalidatePath(ROTA);
  if (!r.ok) voltar({ erro: r.erro });
  voltar({ ok: formData.get("ativo") === "true" ? "Envio de respostas ligado." : "Envio de respostas desligado." });
}
