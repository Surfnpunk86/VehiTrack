# Guía de despliegue — Autofirm Verifica

Como no tienes aún un proyecto de Supabase, sigue este orden exacto:
Supabase primero (backend + base de datos), luego Render (frontend).

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

## 3. Desplegar las Edge Functions

Necesitas el [CLI de Supabase](https://supabase.com/docs/guides/cli) instalado localmente (no corre en Render):

```bash
npm install -g supabase
supabase login
supabase link --project-ref TU-PROJECT-REF   # lo ves en la URL del dashboard
```

Configura los secretos (nunca los subas al repo):

```bash
supabase secrets set WOMPI_EVENTS_SECRET=tu_secreto_de_eventos_wompi
supabase secrets set PLACAPI_BASE_URL=https://api.placapi.com/v1
supabase secrets set PLACAPI_API_KEY=tu_llave_privada_de_placapi
```

Despliega las dos funciones:

```bash
supabase functions deploy wompi-webhook --no-verify-jwt
supabase functions deploy consulta
```

En el panel de Wompi, configura la URL del webhook apuntando a:
`https://TU-PROYECTO.supabase.co/functions/v1/wompi-webhook`

⚠️ **Antes de ir a producción**: abre `supabase/functions/consulta/index.ts` y revisa la función `consultarPlacApi`. La escribí como plantilla razonable porque no tengo acceso a la documentación real de PlacApi — necesitas confirmar el endpoint exacto, cómo se autentica y la forma de la respuesta, y ajustar el mapeo al shape que usa el frontend (revisa la constante `SAMPLE` dentro de `autofirm-verifica.html` para ver esa forma).

## 4. Completar config.js

Abre `config.js` (ya generado en la raíz del repo) y reemplaza los 4 valores:

```js
window.AUTOFIRM_CONFIG = {
  SUPABASE_URL: "https://TU-PROYECTO.supabase.co",
  SUPABASE_ANON_KEY: "...",
  WOMPI_PUBLIC_KEY: "pub_test_...",   // o pub_prod_... en producción
  WOMPI_API_URL: "https://sandbox.wompi.co/v1", // o production en vivo
};
```

Este archivo sí va en el repo/hosting (son llaves públicas), pero **nunca** pongas ahí `service_role`, `WOMPI_EVENTS_SECRET` ni la llave privada de Wompi/PlacApi.

## 5. Desplegar el frontend en Render

Opción rápida (Blueprint, usa el `render.yaml` ya incluido):

1. Sube estos cambios (config.js, render.yaml, supabase/functions/consulta) a tu repo de GitHub.
2. En Render: **New + → Blueprint** → conecta el repo `Surfnpunk86/VehiTrack`.
3. Render detecta `render.yaml` y crea un **Static Site** automáticamente.
4. Espera el deploy; la URL pública quedará como `https://autofirm-verifica.onrender.com`.

Opción manual (sin Blueprint):

1. **New + → Static Site** → conecta el repo.
2. Build command: (vacío)
3. Publish directory: `.` (raíz del repo)
4. Deploy.

## 6. Probar

1. Abre la URL de Render. Si `config.js` está bien, debe desaparecer el modo demo.
2. Regístrate/inicia sesión (usa Supabase Auth, revisa que esté habilitado en el dashboard).
3. Verifica que tu wallet tenga créditos: en SQL Editor de Supabase,
   ```sql
   update public.wallets set creditos = creditos + 10
   where user_id = (select id from auth.users where email = 'tucorreo@ejemplo.com');
   ```
4. Haz una consulta de placa y confirma que descuenta el crédito y trae el informe.
5. Haz un pago de prueba en Wompi sandbox y confirma que el webhook acredita el saldo.

## Resumen de qué corre dónde

| Pieza | Dónde |
|---|---|
| `autofirm-verifica.html`, `config.js` | Render (Static Site) |
| `supabase/functions/wompi-webhook` | Supabase Edge Functions |
| `supabase/functions/consulta` | Supabase Edge Functions |
| `verifica-*.sql` | Supabase Postgres (SQL Editor) |
