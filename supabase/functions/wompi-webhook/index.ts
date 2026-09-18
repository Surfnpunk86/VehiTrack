// ================================================================
//  AUTOFIRM VERIFICA · Edge Function "wompi-webhook"
//  Recibe los eventos de Wompi, valida la firma y acredita:
//   - Recargas de wallet  (referencia AFV-...)
//   - Cobros de suscripción (referencia SUB-...): acredita y agenda
//     el próximo cobro, o marca la suscripción como morosa.
//  Idempotente: solo actúa una vez por referencia.
//
//  Desplegar:  supabase functions deploy wompi-webhook --no-verify-jwt
// ================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

async function sha256hex(str: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

function sumarUnMes(fecha: string) {
  const d = new Date(fecha + "T00:00:00Z");
  const hoy = new Date();
  const base = d > hoy ? d : hoy;               // no acumular meses vencidos
  base.setUTCMonth(base.getUTCMonth() + 1);
  return base.toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "metodo_no_permitido" }, 405);
  try {
    const body = await req.json();
    const t = body?.data?.transaction;
    const checksum = body?.signature?.checksum;
    const timestamp = body?.timestamp;
    if (!t || !checksum || timestamp == null) return json({ error: "payload_incompleto" }, 400);

    // Validar firma del evento
    const secret = Deno.env.get("WOMPI_EVENTS_SECRET")!;
    const calc = await sha256hex(`${t.id}${t.status}${t.amount_in_cents}${timestamp}${secret}`);
    if (calc !== checksum) return json({ error: "firma_invalida" }, 401);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const ref: string = t.reference ?? "";
    const aprobado = t.status === "APPROVED";
    const fallido = ["DECLINED", "ERROR", "VOIDED"].includes(t.status);

    if (ref.startsWith("SUB-")) {
      // ── Cobro de suscripción ──
      if (aprobado) {
        const { data: cobro } = await admin.from("cobros")
          .update({ estado: "aprobado", wompi_txn_id: t.id, updated_at: new Date().toISOString() })
          .eq("reference", ref).eq("estado", "pendiente")
          .select("user_id, creditos, suscripcion_id").maybeSingle();
        if (cobro) {
          await admin.rpc("sumar_creditos", { p_user: cobro.user_id, p_creditos: cobro.creditos });
          const { data: sub } = await admin.from("suscripciones").select("proximo_cobro").eq("id", cobro.suscripcion_id).maybeSingle();
          await admin.from("suscripciones").update({
            estado: "activa", retry_count: 0,
            proximo_cobro: sumarUnMes(sub?.proximo_cobro ?? new Date().toISOString().slice(0, 10)),
            updated_at: new Date().toISOString(),
          }).eq("id", cobro.suscripcion_id);
        }
      } else if (fallido) {
        const { data: cobro } = await admin.from("cobros")
          .update({ estado: "rechazado", wompi_txn_id: t.id, updated_at: new Date().toISOString() })
          .eq("reference", ref).eq("estado", "pendiente")
          .select("suscripcion_id").maybeSingle();
        if (cobro) await admin.rpc("marcar_morosa", { p_sub: cobro.suscripcion_id });
      }
    } else {
      // ── Recarga de wallet ──
      if (aprobado) {
        const { data: rec } = await admin.from("recargas")
          .update({ estado: "aprobada", wompi_txn_id: t.id, updated_at: new Date().toISOString() })
          .eq("reference", ref).eq("estado", "pendiente")
          .select("user_id, creditos").maybeSingle();
        if (rec) await admin.rpc("sumar_creditos", { p_user: rec.user_id, p_creditos: rec.creditos });
      } else if (fallido) {
        await admin.from("recargas").update({ estado: "rechazada", wompi_txn_id: t.id, updated_at: new Date().toISOString() })
          .eq("reference", ref).eq("estado", "pendiente");
      }
    }

    return json({ ok: true });
  } catch (e) {
    return json({ error: "error_interno", detalle: String(e) }, 500);
  }
});
