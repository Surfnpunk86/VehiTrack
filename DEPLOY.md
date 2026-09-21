# Guía de despliegue — VehiTrack

Como no tienes aún un proyecto de Supabase, sigue este orden exacto:
Supabase primero (backend + base de datos), luego Wompi, luego Render (frontend).

## 1. Crear el proyecto de Supabase

1. Ve a https://supabase.com/dashboard → **New project**.
2. Guarda la **contraseña de la base de datos** que definas ahí, la necesitarás para el CLI.
3. Cuando esté listo, entra a **Project Settings → API** y copia:
   - `Project URL` → lo usarás como `SUPABASE_URL`
   - `anon public` key → lo usarás como `SUPABASE_ANON_KEY`
   - `service_role` key → **secreta**, solo para las Edge Functions, nunca al frontend

## 2. Crear las tablas (SQL Editor)

En el dashboard de Supabase, abre **SQL Editor → New query** y ejecuta los 3 archivos **en este orden exacto** (cada uno depende del anterior):

1. `verifica-backend.sql`
2. `verifica-pagos.sql`
3. `verifica-suscripciones.sql`

Pega el contenido completo de cada archivo y dale **Run** antes de pasar al siguiente.

## 3. Configurar tu comercio en Wompi

1. Regístrate en https://comercios.wompi.co y activa tu comercio (o usa el sandbox de pruebas mientras tanto: https://comercios.wompi.co/sandbox).
2. Ve a **Configuración → Llaves** (Settings → API Keys) y copia:
   - **Llave pública** (`pub_test_...` en sandbox, `pub_prod_...` en producción) → la usa el frontend, va en `config.js`.
   - **Llave privada** (`prv_test_...` / `prv_prod_...`) → **secreta**, solo para la Edge Function `suscribir` y `cobrar-suscripciones`.
   - **Llave secreta de integridad** → **secreta**, solo para `recarga-firma` (firma el checkout de recargas).
   - **Events secret** → **secreta**, solo para `wompi-webhook` (valida que las notificaciones vengan realmente de Wompi).
3. Empieza en modo **sandbox** (`https://sandbox.wompi.co/v1`) y prueba todo el flujo antes de pasar a producción (`https://production.wompi.co/v1`) con las llaves `_prod_`.

## 4. Desplegar las Edge Functions

Necesitas el [CLI de Supabase](https://supabase.com/docs/guides/cli) instalado localmente (no corre en Render):

```bash
npm install -g supabase
supabase login
supabase link --project-ref TU-PROJECT-REF   # lo ves en la URL del dashboard
```

Configura los secretos (nunca los subas al repo):

```bash
supabase secrets set WOMPI_PUBLIC_KEY=pub_test_tu_llave_publica
supabase secrets set WOMPI_PRIVATE_KEY=prv_test_tu_llave_privada
supabase secrets set WOMPI_INTEGRITY_SECRET=tu_llave_secreta_de_integridad
supabase secrets set WOMPI_EVENTS_SECRET=tu_events_secret
supabase secrets set WOMPI_API_URL=https://sandbox.wompi.co/v1
supabase secrets set PLACAPI_BASE_URL=https://api.placapi.com/v1
supabase secrets set PLACAPI_API_KEY=tu_llave_privada_de_placapi
```

Despliega las cinco funciones:

```bash
supabase functions deploy wompi-webhook --no-verify-jwt
supabase functions deploy recarga-firma
supabase functions deploy suscribir
supabase functions deploy cobrar-suscripciones
supabase functions deploy consulta
```

En el panel de Wompi, configura la URL de eventos (webhook) apuntando a:
`https://TU-PROYECTO.supabase.co/functions/v1/wompi-webhook`

### Renovación mensual automática de suscripciones

`cobrar-suscripciones` cobra el siguiente mes a cada suscripción activa que ya cumplió su fecha, usando la tarjeta guardada — pero **no se ejecuta sola**, hay que programarla una vez al día. La forma más simple dentro de Supabase (SQL Editor):

```sql
select cron.schedule('cobrar-suscripciones-diario', '0 8 * * *', $$
  select net.http_post(
    url := 'https://TU-PROYECTO.supabase.co/functions/v1/cobrar-suscripciones',
    headers := jsonb_build_object('Authorization', 'Bearer TU_SERVICE_ROLE_KEY')
  );
$$);
```

(Requiere las extensiones `pg_cron` y `pg_net`, activables desde **Database → Extensions**.) Alternativa sin tocar SQL: un cron externo (GitHub Actions, cron-job.org, etc.) que haga un `POST` diario a esa misma URL con ese mismo header.

⚠️ **Antes de ir a producción con `consulta`**: revisa `consultarPlacApi` dentro de `supabase/functions/consulta/index.ts`; no tengo acceso a la documentación real de PlacApi, así que el endpoint y el mapeo de la respuesta son una plantilla, no algo verificado.

## 5. Completar config.js

Abre `config.js` (ya generado en la raíz del repo) y reemplaza los 4 valores:

```js
window.VEHITRACK_CONFIG = {
  SUPABASE_URL: "https://TU-PROYECTO.supabase.co",
  SUPABASE_ANON_KEY: "...",
  WOMPI_PUBLIC_KEY: "pub_test_...",   // o pub_prod_... en producción
  WOMPI_API_URL: "https://sandbox.wompi.co/v1", // o production en vivo
};
```

Este archivo sí va en el repo/hosting (son llaves públicas), pero **nunca** pongas ahí la llave privada, la de integridad ni el events secret de Wompi.

## 6. Desplegar el frontend en Render

**Recomendado — manual, sin `render.yaml` (100% confiable):**

1. En Render: **New + → Static Site** → conecta el repo `Surfnpunk86/VehiTrack`.
2. **Build Command**: déjalo vacío.
3. **Publish Directory**: `.` (un solo punto, la raíz del repo).
4. Deploy. La URL pública quedará como `https://vehitrack.onrender.com`.

Si ya tienes un servicio creado con el Blueprint y te dio el error `bash: line 1: .: filename argument required`, ese servicio quedó mal configurado (interpretó el Blueprint como si fuera un servicio con comandos de shell). Bórralo y créalo de nuevo con los 4 pasos de arriba — es la forma más segura.

**Alternativa — Blueprint con `render.yaml`:** ya corregido en este paquete (usaba `runtime: static`, que Render no reconoce; ahora usa `env: static`). Si prefieres esta vía: sube `render.yaml` al repo, luego **New + → Blueprint** → conecta el repo, y Render debería crear el Static Site solo. Si vuelve a fallar, usa la opción manual de arriba, que no depende de este archivo.

## 7. Probar

1. Abre la URL de Render. Si `config.js` está bien, debe desaparecer el modo demo.
2. Regístrate/inicia sesión (usa Supabase Auth, revisa que esté habilitado en el dashboard).
3. Verifica que tu wallet tenga créditos: en SQL Editor de Supabase,
   ```sql
   update public.wallets set creditos = creditos + 10
   where user_id = (select id from auth.users where email = 'tucorreo@ejemplo.com');
   ```
4. Haz una consulta de placa y confirma que descuenta el crédito y trae el informe.
5. Recarga con una [tarjeta de prueba de Wompi](https://docs.wompi.co/docs/colombia/tarjetas-de-prueba/) en sandbox y confirma que el webhook acredita el saldo.
6. Suscríbete a un plan con una tarjeta de prueba y confirma que se activa; luego prueba `cobrar-suscripciones` manualmente (invócala desde el dashboard de Supabase) para ver que cobra el segundo ciclo sin pedir la tarjeta de nuevo.

## Resumen de qué corre dónde

| Pieza | Dónde |
|---|---|
| `index.html`, `config.js`, `logo.png` | Render (Static Site) |
| `supabase/functions/wompi-webhook` | Supabase Edge Functions |
| `supabase/functions/recarga-firma` | Supabase Edge Functions |
| `supabase/functions/suscribir` | Supabase Edge Functions |
| `supabase/functions/cobrar-suscripciones` | Supabase Edge Functions (programada a diario) |
| `supabase/functions/consulta` | Supabase Edge Functions |
| `verifica-*.sql` | Supabase Postgres (SQL Editor) |
