import type { Metadata } from "next";
import "@fontsource/inter/400.css";
import "@fontsource/inter/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./globals.css";
export const metadata: Metadata = { title: "Inteligência WhatsApp", description: "Painel de inteligência de conversas" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
 return <html lang="pt-BR" data-ds="azul"><body>{children}</body></html>;
}
