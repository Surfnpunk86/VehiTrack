// ================================================================
//  VEHITRACK · Edge Function "wompi-webhook"
//  ----------------------------------------------------------------
//  Recibe el evento "transaction.updated" de Wompi y acredita:
//   - Recargas de wallet    (referencia AFV-...)
//   - Cobros de suscripción (referencia SUB-...): activa/renueva o
//     marca la suscripción como morosa.
//  Valida el checksum del evento con el "Events Secret" de Wompi
//  antes de confiar en el payload (así nadie puede simular un pago
//  aprobado llamando directo a esta URL).
//
//  Checksum de eventos de Wompi:
//    sha256hex( valores_de_signature.properties_en_orden + timestamp + eventsSecret )
//  donde cada "propiedad" se lee del payload siguiendo su ruta
//  (ej. "data.transaction.id" → body.data.transaction.id).
//
//  Variables de entorno requeridas (Supabase → Edge Functions → Secrets):
//    SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY  (las inyecta Supabase)
//    WOMPI_EVENTS_SECRET   (Wompi → Configuración → Llaves → Events secret)
//
//  Desplegar:  supabase functions deploy wompi-webhook --no-verify-jwt
// ================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

function sumarUnMes(fecha: string) {
  const d = new Date(fecha + "T00:00:00Z");
  const hoy = new Date();
  const base = d > hoy ? d : hoy; // no acumular meses vencidos
  base.setUTCMonth(base.getUTCMonth() + 1);
  return base.toISOString().slice(0, 10);
}

function leerRuta(obj: any, ruta: string) {
  return ruta.split(".").reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

async function sha256hex(str: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function checksumValido(body: any, eventsSecret: string) {
  const props: string[] = body?.signature?.properties;
  const checksumRecibido: string = body?.signature?.checksum;
  if (!props || !checksumRecibido) return false;
  const concatenado = props.map((p) => String(leerRuta(body, p))).join("") + String(body.timestamp) + eventsSecret;
  const calculado = await sha256hex(concatenado);
  return calculado.toUpperCase() === String(checksumRecibido).toUpperCase();
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "metodo_no_permitido" }, 405);
  try {
    const body = await req.json();

    const eventsSecret = Deno.env.get("WOMPI_EVENTS_SECRET");
    if (!eventsSecret) {
      console.warn("WOMPI_EVENTS_SECRET no configurado: el checksum del evento NO se está validando.");
    } else if (!(await checksumValido(body, eventsSecret))) {
      return json({ error: "checksum_invalido" }, 401);
    }

    const tx = body?.data?.transaction;
    if (!tx?.reference || !tx?.status) return json({ error: "payload_incompleto" }, 400);

    const ref: string = tx.reference;
    const estado: string = tx.status; // APPROVED | DECLINED | VOIDED | ERROR | PENDING
    const txnId: string = tx.id;
    const aprobado = estado === "APPROVED";
    const fallido = estado === "DECLINED" || estado === "VOIDED" || estado === "ERROR";

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    if (ref.startsWith("SUB-")) {
      // ── Cobro de suscripción ──
      if (aprobado) {
        const { data: cobro } = await admin.from("cobros")
          .update({ estado: "aprobado", wompi_txn_id: txnId, updated_at: new Date().toISOString() })
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
          .update({ estado: "rechazado", wompi_txn_id: txnId, updated_at: new Date().toISOString() })
          .eq("reference", ref).eq("estado", "pendiente")
          .select("suscripcion_id").maybeSingle();
        if (cobro) await admin.rpc("marcar_morosa", { p_sub: cobro.suscripcion_id });
      }
    } else {
      // ── Recarga de wallet ──
      if (aprobado) {
        const { data: rec } = await admin.from("recargas")
          .update({ estado: "aprobada", wompi_txn_id: txnId, updated_at: new Date().toISOString() })
          .eq("reference", ref).eq("estado", "pendiente")
          .select("user_id, creditos").maybeSingle();
        if (rec) await admin.rpc("sumar_creditos", { p_user: rec.user_id, p_creditos: rec.creditos });
      } else if (fallido) {
        await admin.from("recargas").update({ estado: "rechazada", wompi_txn_id: txnId, updated_at: new Date().toISOString() })
          .eq("reference", ref).eq("estado", "pendiente");
      }
    }

    return json({ ok: true });
  } catch (e) {
    return json({ error: "error_interno", detalle: String(e) }, 500);
  }
});
