"use server";

import { revalidatePath } from "next/cache";
import { isAdmin } from "@/lib/auth/is-admin";
import { createClient } from "@/lib/supabase/server";
import { statusDecisao, textoParaTemas } from "@/lib/whatsapp/aprendizados";
import { decidirAprendizado, salvarTemasAprendizado } from "@/lib/whatsapp/dados";

const CAMINHO = "/operacao/whatsapp/aprendizados";

/** Aprova ou descarta um aprendizado. Só admin: esta checagem é a primeira barreira, a RLS do banco é a segunda. */
export async function decidirAprendizadoAction(formData: FormData): Promise<void> {
  if (!(await isAdmin())) return;
  const status = statusDecisao(formData.get("status"));
  if (!status) return;
  const supabase = await createClient();
  const r = await decidirAprendizado(supabase, Number(formData.get("id")), status);
  if (!r.ok) throw new Error(r.erro);
  revalidatePath(CAMINHO);
}

/** Salva a lista de temas (uma linha por tema, "Nome: descrição"). O worker passa a usar a nova lista no próximo resumo. */
export async function salvarTemasAction(formData: FormData): Promise<void> {
  if (!(await isAdmin())) return;
  const parsed = textoParaTemas(String(formData.get("temas") ?? ""));
  if (!parsed.ok) throw new Error(parsed.erro);
  const supabase = await createClient();
  const r = await salvarTemasAprendizado(supabase, parsed.temas);
  if (!r.ok) throw new Error(r.erro);
  revalidatePath(CAMINHO);
}
