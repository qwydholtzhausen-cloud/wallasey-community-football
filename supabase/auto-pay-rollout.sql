-- Auto-payments rollout (Monzo). Run once in the Supabase SQL editor,
-- BEFORE flipping MONZO_MATCHING_LIVE to true. Safe to re-run.
-- Checked against the live database on 4 Oct 2026: none of these existed
-- yet (bookings.confirmed_at already did).

-- 1. Each player's 5-character bank reference.
create or replace function public.generate_payment_code()
returns text
language plpgsql
as $$
declare
  chars text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  code text;
  taken boolean;
begin
  loop
    code := '';
    for i in 1..5 loop
      code := code || substr(chars, floor(random() * length(chars) + 1)::int, 1);
    end loop;
    select exists(select 1 from public.profiles where payment_code = code) into taken;
    exit when not taken;
  end loop;
  return code;
end;
$$;

alter table public.profiles add column if not exists payment_code text unique;
update public.profiles set payment_code = public.generate_payment_code() where payment_code is null;
-- New members get one automatically. (A column default rather than editing
-- handle_new_user, whose live version has changed since schema.sql.)
alter table public.profiles alter column payment_code set default public.generate_payment_code();
alter table public.profiles alter column payment_code set not null;

-- 2. Marks a booking the bank feed confirmed (shows "paid via Monzo").
alter table public.bookings add column if not exists auto_confirmed boolean not null default false;

-- 3. The connected Monzo account (one row). Server-only: no policies, so
--    only the service role can read it.
create table if not exists public.monzo_tokens (
  id boolean primary key default true check (id),
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table public.monzo_tokens add column if not exists account_id text;
alter table public.monzo_tokens add column if not exists webhook_registered boolean not null default false;
alter table public.monzo_tokens enable row level security;

-- 4. Every payment that came in, matched or not. Admins can see them all
--    (Payments → "Couldn't be confirmed automatically").
create table if not exists public.monzo_transactions (
  id text primary key,
  amount_pence int not null,
  code text,
  player_id uuid references public.profiles (id) on delete set null,
  outcome text not null check (outcome in ('confirmed', 'unmatched')),
  reason text,
  matched_booking_ids uuid[],
  created_at timestamptz not null default now()
);
alter table public.monzo_transactions enable row level security;
drop policy if exists "monzo_transactions_select_admin" on public.monzo_transactions;
create policy "monzo_transactions_select_admin" on public.monzo_transactions for select using (public.is_admin());

-- Check: should return one row per member, each with a 5-character code.
select display_name, payment_code from public.profiles order by display_name limit 5;
