"use server";

import { revalidatePath } from "next/cache";
import { isAdmin } from "@/lib/auth/is-admin";
import { createClient } from "@/lib/supabase/server";
import { definirFavoritoLink } from "@/lib/whatsapp/dados";

/**
 * Alterna o favorito de um link. Só admin: a checagem aqui é a primeira barreira;
 * a RLS e o grant por coluna do banco (wa.links.favorito) são a segunda.
 * O valor desejado vem do formulário (estado atual invertido), o que torna o clique idempotente.
 */
export async function alternarFavoritoLinkAction(formData: FormData): Promise<void> {
  if (!(await isAdmin())) return;

  const id = Number(formData.get("id"));
  const favorito = formData.get("favorito") === "true";

  const supabase = await createClient();
  const r = await definirFavoritoLink(supabase, id, favorito);
  if (!r.ok) throw new Error(r.erro);

  revalidatePath("/operacao/whatsapp/links");
}
