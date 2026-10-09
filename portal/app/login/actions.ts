"use server";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
export async function login(form: FormData) {
 const client = await createClient();
 const { error } = await client.auth.signInWithPassword({ email: String(form.get("email") ?? ""), password: String(form.get("password") ?? "") });
 if (error) redirect("/login?erro=1");
 redirect("/operacao/whatsapp");
}
export async function logout() { const client = await createClient(); await client.auth.signOut(); redirect("/login"); }
