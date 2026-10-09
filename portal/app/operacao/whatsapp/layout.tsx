import { logout } from "@/app/login/actions";
import type * as React from "react";
import { exigirAdminDaRequisicao } from "@/lib/whatsapp/guarda";
import { NavWhatsapp } from "@/components/operacao/whatsapp/NavWhatsapp";

export const dynamic = "force-dynamic";

/**
 * Módulo WhatsApp da Operação. Além do guard de /operacao, nega com 404 quem não é admin
 * (a rota não revela que existe). Páginas ocupam 100% da largura (regra do portal).
 */
export default async function WhatsappLayout({ children }: { children: React.ReactNode }) {
  await exigirAdminDaRequisicao();
  return (
    <div className="w-full min-w-0 space-y-6 px-4 py-6 md:px-8">
      <p className="font-sans text-xs uppercase tracking-wider text-ink-muted">Minha Operação</p>
      <NavWhatsapp /><form action={logout}><button className="text-sm text-ink-muted underline">Sair</button></form>
      {children}
    </div>
  );
}
