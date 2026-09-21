-- ================================================================
--  VEHITRACK · BASE DE DATOS Y SEGURIDAD
--  Ejecutar una vez en Supabase → SQL Editor → Run.
-- ================================================================

-- 1) WALLET: saldo de créditos por usuario -----------------------
create table if not exists public.wallets (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  creditos   integer not null default 0,
  plan       text,
  updated_at timestamptz not null default now()
);

-- 2) CONSULTAS: historial de informes + caché por placa ----------
create table if not exists public.consultas (
  id         bigint generated always as identity primary key,
  user_id    uuid references auth.users(id) on delete set null,
  placa      text not null,
  doc_type   text,
  doc_number text,
  payload    jsonb not null,
  source     text,               -- 'placapi' | 'cache'
  costo      integer not null default 1,
  created_at timestamptz not null default now()
);
create index if not exists consultas_placa_fecha on public.consultas (placa, created_at desc);
create index if not exists consultas_user_fecha  on public.consultas (user_id, created_at desc);

-- 3) SEGURIDAD (RLS) ---------------------------------------------
alter table public.wallets   enable row level security;
alter table public.consultas enable row level security;

-- El usuario solo puede LEER su propio saldo y sus propias consultas.
drop policy if exists "wallet propio" on public.wallets;
create policy "wallet propio" on public.wallets
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "consultas propias" on public.consultas;
create policy "consultas propias" on public.consultas
  for select to authenticated using (user_id = auth.uid());

-- Nadie escribe desde el cliente: los INSERT/UPDATE los hace la
-- Edge Function con la llave service_role (que salta RLS).

-- 4) COBRO ATÓMICO DE CRÉDITOS -----------------------------------
--    Descuenta solo si hay saldo suficiente. Devuelve el saldo
--    restante, o -1 si no alcanza.
create or replace function public.consumir_credito(p_user uuid, p_costo int)
returns int language plpgsql security definer set search_path = public as $$
declare restante int;
begin
  update public.wallets
     set creditos = creditos - p_costo, updated_at = now()
   where user_id = p_user and creditos >= p_costo
  returning creditos into restante;
  if not found then return -1; end if;
  return restante;
end $$;

-- Reintegra el crédito si la consulta al proveedor falló.
create or replace function public.reintegrar_credito(p_user uuid, p_costo int)
returns int language plpgsql security definer set search_path = public as $$
declare restante int;
begin
  update public.wallets
     set creditos = creditos + p_costo, updated_at = now()
   where user_id = p_user
  returning creditos into restante;
  return coalesce(restante, 0);
end $$;

-- 5) CREAR WALLET AUTOMÁTICO AL REGISTRARSE ----------------------
create or replace function public.crear_wallet()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.wallets (user_id, creditos) values (new.id, 0)
  on conflict (user_id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.crear_wallet();

-- ================================================================
--  Para cargar créditos a un usuario (ej. tras pagar el plan de
--  1.000 créditos), corre — reemplazando el correo:
--
--    update public.wallets set creditos = creditos + 1000, plan = 'Suscripción 1000'
--    where user_id = (select id from auth.users where email = 'cliente@correo.com');
--
--  (Más adelante esto lo hará automáticamente el webhook de Wompi.)
-- ================================================================
