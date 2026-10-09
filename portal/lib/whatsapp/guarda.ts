import { cache } from "react";
import { notFound } from "next/navigation";
import { isAdmin } from "@/lib/auth/is-admin";

type Dependencias = {
  verificarAdmin: () => Promise<boolean>;
  negar: () => never;
};

/**
 * Guarda server-side do módulo WhatsApp. Quem não é admin recebe 404, o mesmo
 * retorno de uma rota que não existe, para não revelar o módulo.
 * As dependências são injetáveis para teste.
 */
export async function exigirAdminWhatsapp(
  deps: Dependencias = { verificarAdmin: isAdmin, negar: notFound },
): Promise<void> {
  const admin = await deps.verificarAdmin();
  if (!admin) deps.negar();
}

/** Versão para as páginas: deduplica a checagem dentro da mesma requisição. */
export const exigirAdminDaRequisicao = cache(() => exigirAdminWhatsapp());
