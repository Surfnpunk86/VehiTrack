-- ================================================================
--  AUTOFIRM VERIFICA · SUSCRIPCIONES (débito automático con Wompi)
--  Ejecutar después de verifica-backend.sql y verifica-pagos.sql
-- ================================================================

-- Suscripción activa por usuario/plan -----------------------------
create table if not exists public.suscripciones (
  id              bigint generated always as identity primary key,
  user_id         uuid references auth.users(id) on delete cascade,
  plan            text not null,                 -- Basic | Standard | Advanced
  amount_cents    bigint not null,
  creditos_ciclo  integer not null,              -- créditos que otorga cada mes
  payment_source_id text,                        -- fuente de pago (tarjeta) de Wompi
  customer_email  text,
  estado          text not null default 'activa',-- activa | morosa | cancelada
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
  user_id        uuid,
  reference      text unique not null,           -- SUB-{suscripcion}-{AAAAMM}
  amount_cents   bigint not null,
  creditos       integer not null,
  estado         text not null default 'pendiente', -- pendiente | aprobado | rechazado
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

-- Marca la suscripción como morosa y cuenta el reintento (la usa el webhook)
create or replace function public.marcar_morosa(p_sub bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.suscripciones
     set estado = 'morosa', retry_count = retry_count + 1, updated_at = now()
   where id = p_sub;
end $$;
