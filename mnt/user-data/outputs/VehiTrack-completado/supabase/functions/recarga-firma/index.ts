// ================================================================
//  VEHITRACK · Edge Function "recarga-firma"
//  ----------------------------------------------------------------
//  Genera la referencia y la "firma de integridad" que exige el
//  checkout hospedado de Wompi (checkout.wompi.co/p/) antes de
//  redirigir al usuario a pagar. La llave SECRETA de integridad de
//  Wompi vive solo aquí, nunca en el frontend.
//
//  Fórmula oficial de Wompi para la firma de integridad del widget:
//    sha256hex( `${reference}${amountInCents}${currency}${integritySecret}` )
//
//  Variables de entorno requeridas (Supabase → Edge Functions → Secrets):
//    SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY  (las inyecta Supabase)
//    WOMPI_PUBLIC_KEY        llave pública de Wompi (pub_test_... / pub_prod_...)
//    WOMPI_INTEGRITY_SECRET  llave secreta de integridad (Configuración → Llaves)
//
//  Desplegar:  supabase functions deploy recarga-firma
// ================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// Créditos que otorga cada monto de recarga (debe reflejar lo que
// muestra el frontend en el modal de recarga).
const TABLA_RECARGAS: Record<number, number> = {
  20000: 4,
  50000: 12,   // 10 + 2 de bono
  100000: 25,  // 20 + 5 de bono
};

async function sha256hex(str: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "metodo_no_permitido" }, 405);
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const anon = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await anon.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "no_autenticado" }, 401);
    const userId = userData.user.id;

    const body = await req.json().catch(() => ({}));
    const monto = Number(body?.monto);
    const creditos = TABLA_RECARGAS[monto];
    if (!monto || !creditos) return json({ error: "monto_invalido" }, 400);

    const publicKey = Deno.env.get("WOMPI_PUBLIC_KEY");
    const secret = Deno.env.get("WOMPI_INTEGRITY_SECRET");
    if (!publicKey || !secret) return json({ error: "wompi_no_configurado" }, 500);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const reference = `AFV-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const amountInCents = monto * 100;

    const { error: insErr } = await admin.from("recargas").insert({
      user_id: userId, reference, monto_cents: amountInCents, creditos, estado: "pendiente",
    });
    if (insErr) return json({ error: "error_interno", detalle: insErr.message }, 500);

    const signature = await sha256hex(`${reference}${amountInCents}COP${secret}`);
    return json({ reference, amountInCents, publicKey, signature });
  } catch (e) {
    return json({ error: "error_interno", detalle: String(e) }, 500);
  }
});
