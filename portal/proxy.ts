import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
export async function proxy(request: NextRequest) {
 let response = NextResponse.next({ request });
 const client = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { cookies: {
 getAll: () => request.cookies.getAll(),
 setAll: (items) => { items.forEach(({name,value}) => request.cookies.set(name,value)); response = NextResponse.next({request}); items.forEach(({name,value,options}) => response.cookies.set(name,value,options)); }
 }});
 const { data: { user } } = await client.auth.getUser();
 if (!user && !request.nextUrl.pathname.startsWith("/login")) { const redirect = NextResponse.redirect(new URL("/login", request.url)); response.cookies.getAll().forEach(c => redirect.cookies.set(c)); return redirect; }
 return response;
}
export const config = { matcher: ["/", "/login", "/operacao/:path*"] };
