-- ================================================================
--  VEHITRACK · SUSCRIPCIONES (débito automático con Wompi)
--  Ejecutar después de verifica-backend.sql y verifica-pagos.sql
--
--  CORRECCIONES sobre el archivo original:
--   1) suscripciones.estado ahora nace en 'pendiente' (no 'activa').
--      Antes, una suscripción recién creada ya se veía como activa
--      ANTES de que Wompi confirmara el primer cobro. Ahora solo el
--      webhook la pasa a 'activa' cuando el pago se aprueba.
--   2) cobros.user_id ahora es NOT NULL y referencia auth.users,
--      porque la política de seguridad (RLS) depende de esa columna
--      para decidir qué puede ver cada usuario — si quedara vacía
--      por error, esa fila sería invisible para todos, sin aviso.
--   3) Se agregan CHECK a 'plan' y 'estado' para no permitir valores
--      inválidos que el webhook no sabría interpretar.
-- ================================================================

-- Suscripción activa por usuario/plan -----------------------------
create table if not exists public.suscripciones (
  id              bigint generated always as identity primary key,
  user_id         uuid references auth.users(id) on delete cascade,
  plan            text not null
                    check (plan in ('Basic','Standard','Advanced')),
  amount_cents    bigint not null,
  creditos_ciclo  integer not null,              -- créditos que otorga cada mes
  payment_source_id text,                        -- fuente de pago (tarjeta) de Wompi
  customer_email  text,
  estado          text not null default 'pendiente' -- CORREGIDO (antes: 'activa')
                    check (estado in ('pendiente','activa','morosa','cancelada')),
  proximo_cobro   date not null default current_date,
  retry_count     integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists suscripciones_cobro on public.suscripciones (estado, proximo_cobro);

-- Historial de cobros (uno por ciclo; la referencia evita duplicados)
create table if not exists public.cobros (
  id             bigint generated always as identity primary key,
  suscripcion_id bigint references public.suscripciones(id) on delete set null,
  user_id        uuid not null references auth.users(id) on delete cascade, -- CORREGIDO (antes: sin not null ni FK)
  reference      text unique not null,           -- SUB-{suscripcion}-{AAAAMM}
  amount_cents   bigint not null,
  creditos       integer not null,
  estado         text not null default 'pendiente' -- pendiente | aprobado | rechazado
                    check (estado in ('pendiente','aprobado','rechazado')),
  wompi_txn_id   text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.suscripciones enable row level security;
alter table public.cobros        enable row level security;

drop policy if exists "suscripciones propias" on public.suscripciones;
create policy "suscripciones propias" on public.suscripciones
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "cobros propios" on public.cobros;
create policy "cobros propios" on public.cobros
  for select to authenticated using (user_id = auth.uid());
-- INSERT/UPDATE los hacen las Edge Functions con service_role.

-- (La función sumar_creditos ya existe en verifica-pagos.sql.)

-- ----------------------------------------------------------------
-- MIGRACIÓN SEGURA: si estas tablas ya existían con el archivo
-- anterior (con los dos errores descritos arriba), esto las corrige
-- sin borrar datos. Si las tablas se están creando por primera vez
-- con este archivo, este bloque simplemente no hace nada.
-- ----------------------------------------------------------------
do $$
begin
  -- 1) el default de estado ya no debe ser 'activa'
  alter table public.suscripciones alter column estado set default 'pendiente';

  -- 2) cobros.user_id debe quedar poblado antes de exigir NOT NULL
  update public.cobros c set user_id = s.user_id
    from public.suscripciones s
    where c.suscripcion_id = s.id and c.user_id is null;

  -- si después de lo anterior sigue habiendo filas sin user_id (huérfanas
  -- sin suscripción válida), no se puede exigir NOT NULL todavía: avisa.
  if exists (select 1 from public.cobros where user_id is null) then
    raise notice 'Hay cobros sin user_id que no se pudieron completar; revísalos antes de que esta migración pueda exigir NOT NULL.';
  else
    alter table public.cobros alter column user_id set not null;
  end if;
exception when undefined_column or undefined_table then
  null; -- tablas nuevas, no había nada que migrar
end $$;

-- Los CHECK nuevos (plan/estado) solo se agregan si no existían aún.
do $$
begin
  alter table public.suscripciones add constraint suscripciones_plan_check
    check (plan in ('Basic','Standard','Advanced'));
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table public.suscripciones add constraint suscripciones_estado_check
    check (estado in ('pendiente','activa','morosa','cancelada'));
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table public.cobros add constraint cobros_estado_check
    check (estado in ('pendiente','aprobado','rechazado'));
exception when duplicate_object then null;
end $$;

-- Marca la suscripción como morosa y cuenta el reintento (la usa el webhook)
create or replace function public.marcar_morosa(p_sub bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.suscripciones
     set estado = 'morosa', retry_count = retry_count + 1, updated_at = now()
   where id = p_sub;
end $$;
