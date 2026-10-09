"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils/cn";

const ABAS = [
  { href: "/operacao/whatsapp", rotulo: "Visão geral", exato: true },
  { href: "/operacao/whatsapp/dashboard", rotulo: "Dashboard" },
  { href: "/operacao/whatsapp/pendencias", rotulo: "Pendências de resposta" },
  { href: "/operacao/whatsapp/links", rotulo: "Links" },
  { href: "/operacao/whatsapp/aprendizados", rotulo: "Aprendizados" },
  { href: "/operacao/whatsapp/resumos-enviados", rotulo: "Resumos enviados" },
  { href: "/operacao/whatsapp/configuracoes", rotulo: "Configurações" },
];

export function NavWhatsapp() {
  const pathname = usePathname();
  return (
    <nav aria-label="Seções de WhatsApp" className="flex w-full min-w-0 gap-1 overflow-x-auto border-b border-divider">
      {ABAS.map((aba) => {
        const ativa = aba.exato ? pathname === aba.href : pathname.startsWith(aba.href);
        return (
          <Link
            key={aba.href}
            href={aba.href}
            aria-current={ativa ? "page" : undefined}
            className={cn(
              "whitespace-nowrap border-b-2 px-3 py-2 font-sans text-sm transition-colors",
              ativa ? "border-accent text-ink" : "border-transparent text-ink-muted hover:text-ink",
            )}
          >
            {aba.rotulo}
          </Link>
        );
      })}
    </nav>
  );
}
