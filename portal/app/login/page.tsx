import { login } from "./actions";
export default async function Login({ searchParams }: { searchParams: Promise<{ erro?: string }> }) {
 const { erro } = await searchParams;
 return <main className="p-8 space-y-6"><h1 className="text-xl">Inteligência WhatsApp</h1><p>Entre com a conta criada no seu projeto Supabase.</p>{erro && <p role="alert" className="text-danger">Não foi possível entrar. Confira suas credenciais.</p>}<form action={login} className="grid gap-4"><label>E-mail<input name="email" type="email" autoComplete="username" required /></label><label>Senha<input name="password" type="password" autoComplete="current-password" required /></label><button className="cta" type="submit">Entrar<span aria-hidden="true">▪ ▪ ▪</span></button></form></main>;
}
