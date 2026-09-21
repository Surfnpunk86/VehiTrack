// ================================================================
//  VEHITRACK · Edge Function "suscribir"
//  ----------------------------------------------------------------
//  Recibe el token de tarjeta y el token de aceptación que el
//  frontend obtuvo directamente de Wompi (nunca vemos el número de
//  tarjeta). Con la llave PRIVADA de Wompi:
//   1) Crea una "fuente de pago" (payment source) reutilizable a
//      partir del token — esto es lo que permite cobrar los meses
//      siguientes sin que el usuario vuelva a ingresar la tarjeta.
//   2) Cobra el primer mes contra esa fuente de pago.
//  El webhook (`wompi-webhook`) confirma cuando Wompi aprueba esa
//  primera transacción y activa la suscripción.
//
//  Variables de entorno requeridas (Supabase → Edge Functions → Secrets):
//    SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY  (las inyecta Supabase)
//    WOMPI_PRIVATE_KEY   llave privada de Wompi (prv_test_... / prv_prod_...)
//    WOMPI_API_URL       https://sandbox.wompi.co/v1 o https://production.wompi.co/v1
//
//  Desplegar:  supabase functions deploy suscribir
// ================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

const PLANES: Record<string, { amount: number; creditos: number }> = {
  Basic: { amount: 29900, creditos: 10 },
  Standard: { amount: 69900, creditos: 30 },
  Advanced: { amount: 149900, creditos: 100 },
};

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
    const user = userData.user;

    const body = await req.json().catch(() => ({}));
    const plan: string = body?.plan;
    const token: string = body?.token;
    const acceptanceToken: string = body?.acceptanceToken;
    const p = PLANES[plan];
    if (!p || !token || !acceptanceToken) return json({ error: "datos_incompletos" }, 400);

    const privateKey = Deno.env.get("WOMPI_PRIVATE_KEY");
    const wompiApi = Deno.env.get("WOMPI_API_URL") || "https://production.wompi.co/v1";
    if (!privateKey) return json({ error: "wompi_no_configurado" }, 500);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // 1) Crear la fuente de pago reutilizable a partir del token de tarjeta.
    const psRes = await fetch(`${wompiApi}/payment_sources`, {
      method: "POST",
      headers: { Authorization: `Bearer ${privateKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "CARD", token, customer_email: user.email, acceptance_token: acceptanceToken,
      }),
    });
    const psData = await psRes.json();
    const paymentSourceId = psData?.data?.id;
    if (!psRes.ok || !paymentSourceId) {
      return json({ error: "tarjeta_rechazada", detalle: psData?.error?.messages || psData?.error?.reason || "No se pudo guardar la tarjeta." }, 402);
    }

    const { data: sub, error: subErr } = await admin.from("suscripciones").insert({
      user_id: user.id, plan, amount_cents: p.amount * 100, creditos_ciclo: p.creditos,
      customer_email: user.email, payment_source_id: paymentSourceId, estado: "pendiente",
    }).select("id").single();
    if (subErr) return json({ error: "error_interno", detalle: subErr.message }, 500);

    const yyyymm = new Date().toISOString().slice(0, 7).replace("-", "");
    const reference = `SUB-${sub.id}-${yyyymm}`;

    // 2) Cobrar el primer mes contra la fuente de pago recién creada.
    const txRes = await fetch(`${wompiApi}/transactions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${privateKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        amount_in_cents: p.amount * 100, currency: "COP", customer_email: user.email,
        payment_source_id: paymentSourceId, reference,
      }),
    });
    const txData = await txRes.json();
    if (!txRes.ok || !txData?.data?.id) {
      await admin.from("suscripciones").update({ estado: "rechazada" }).eq("id", sub.id);
      return json({ error: "pago_rechazado", detalle: txData?.error?.messages || "Wompi rechazó el cobro." }, 402);
    }

    await admin.from("cobros").insert({
      suscripcion_id: sub.id, user_id: user.id, reference,
      amount_cents: p.amount * 100, creditos: p.creditos, estado: "pendiente",
      wompi_txn_id: txData.data.id,
    });

    return json({ ok: true, subscriptionId: sub.id, transactionStatus: txData.data.status });
  } catch (e) {
    return json({ error: "error_interno", detalle: String(e) }, 500);
  }
});
