// ================================================================
//  VEHITRACK · Edge Function "cobrar-suscripciones"
//  ----------------------------------------------------------------
//  Cobra automáticamente el siguiente mes a toda suscripción activa
//  cuyo `proximo_cobro` ya se cumplió, usando la fuente de pago
//  (payment_source_id) que Wompi guardó cuando el usuario se
//  suscribió por primera vez — sin pedirle la tarjeta de nuevo.
//  El webhook (`wompi-webhook`) es quien confirma el resultado y
//  avanza `proximo_cobro` un mes más.
//
//  Esta función NO se auto-ejecuta: prográmala para correr una vez
//  al día. Dos formas típicas en Supabase:
//   a) pg_cron + pg_net (dentro de la base de datos):
//      select cron.schedule('cobrar-suscripciones-diario', '0 8 * * *', $$
//        select net.http_post(
//          url := 'https://TU-PROYECTO.supabase.co/functions/v1/cobrar-suscripciones',
//          headers := jsonb_build_object('Authorization', 'Bearer TU_SERVICE_ROLE_KEY')
//        );
//      $$);
//   b) Un cron externo (GitHub Actions, cron-job.org, etc.) que haga
//      un POST diario a esa misma URL con ese mismo header.
//
//  Variables de entorno requeridas (Supabase → Edge Functions → Secrets):
//    SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY  (las inyecta Supabase)
//    WOMPI_PRIVATE_KEY, WOMPI_API_URL
//
//  Desplegar:  supabase functions deploy cobrar-suscripciones
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
  try {
    const privateKey = Deno.env.get("WOMPI_PRIVATE_KEY");
    const wompiApi = Deno.env.get("WOMPI_API_URL") || "https://production.wompi.co/v1";
    if (!privateKey) return json({ error: "wompi_no_configurado" }, 500);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const hoy = new Date().toISOString().slice(0, 10);

    const { data: pendientes, error } = await admin.from("suscripciones")
      .select("id, plan, user_id, customer_email, payment_source_id")
      .eq("estado", "activa").lte("proximo_cobro", hoy);
    if (error) return json({ error: "error_interno", detalle: error.message }, 500);

    const resultados = [];
    for (const sub of pendientes ?? []) {
      const p = PLANES[sub.plan];
      if (!p || !sub.payment_source_id) continue;

      const yyyymm = new Date().toISOString().slice(0, 7).replace("-", "");
      const reference = `SUB-${sub.id}-${yyyymm}`;

      // Evita cobrar dos veces el mismo ciclo si la función corre más de una vez.
      const { data: yaExiste } = await admin.from("cobros").select("id").eq("reference", reference).maybeSingle();
      if (yaExiste) { resultados.push({ sub: sub.id, skip: "ya_facturado" }); continue; }

      const txRes = await fetch(`${wompiApi}/transactions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${privateKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          amount_in_cents: p.amount * 100, currency: "COP", customer_email: sub.customer_email,
          payment_source_id: sub.payment_source_id, reference,
        }),
      });
      const txData = await txRes.json();

      await admin.from("cobros").insert({
        suscripcion_id: sub.id, user_id: sub.user_id, reference,
        amount_cents: p.amount * 100, creditos: p.creditos,
        estado: "pendiente", wompi_txn_id: txData?.data?.id ?? null,
      });
      resultados.push({ sub: sub.id, reference, ok: txRes.ok });
    }

    return json({ procesadas: resultados.length, resultados });
  } catch (e) {
    return json({ error: "error_interno", detalle: String(e) }, 500);
  }
});
