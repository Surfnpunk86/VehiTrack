-- ================================================================
--  AUTOFIRM VERIFICA · PAGOS (recargas de wallet con Wompi)
--  Ejecutar después de verifica-backend.sql
-- ================================================================

-- Recargas de wallet (una por intento de pago) --------------------
create table if not exists public.recargas (
  id          bigint generated always as identity primary key,
  user_id     uuid references auth.users(id) on delete set null,
  reference   text unique not null,          -- referencia enviada a Wompi
  monto_cents bigint not null,
  creditos    integer not null,              -- créditos a otorgar si se aprueba
  estado      text not null default 'pendiente', -- pendiente | aprobada | rechazada
  wompi_txn_id text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.recargas enable row level security;

drop policy if exists "recargas propias" on public.recargas;
create policy "recargas propias" on public.recargas
  for select to authenticated using (user_id = auth.uid());
-- Los INSERT/UPDATE los hacen las Edge Functions con service_role.

-- Sumar créditos al wallet (usado por el webhook al aprobarse el pago)
create or replace function public.sumar_creditos(p_user uuid, p_creditos int)
returns int language plpgsql security definer set search_path = public as $$
declare restante int;
begin
  update public.wallets set creditos = creditos + p_creditos, updated_at = now()
   where user_id = p_user returning creditos into restante;
  if not found then
    insert into public.wallets (user_id, creditos) values (p_user, p_creditos)
    on conflict (user_id) do update set creditos = public.wallets.creditos + p_creditos
    returning creditos into restante;
  end if;
  return restante;
end $$;
