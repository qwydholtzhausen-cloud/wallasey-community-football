-- Wirral Community Football — initial schema, RLS policies, and Realtime setup.
-- Run this once in the Supabase SQL Editor (Project > SQL Editor > New query).

-- ─────────────────────────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────────────────────────

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  role text not null default 'player' check (role in ('player', 'admin')),
  created_at timestamptz not null default now()
);

create table public.games (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  kickoff text not null,
  venue text not null,
  pitch text not null,
  price numeric not null default 0,
  max_players int not null default 16,
  created_at timestamptz not null default now()
);

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  player_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'unpaid' check (status in ('unpaid', 'pending', 'confirmed')),
  waiting boolean not null default false,
  created_at timestamptz not null default now(),
  unique (game_id, player_id)
);

create table public.game_stats (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  player_id uuid not null references public.profiles (id) on delete cascade,
  goals int not null default 0,
  unique (game_id, player_id)
);

create table public.clips (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  video_url text,
  game_id uuid references public.games (id) on delete set null,
  submitted_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles (id) on delete cascade,
  text text not null,
  created_at timestamptz not null default now()
);

create table public.post_likes (
  post_id uuid not null references public.posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  primary key (post_id, user_id)
);

-- ─────────────────────────────────────────────────────────────────
-- Auto-create a profile row whenever someone signs up
-- ─────────────────────────────────────────────────────────────────

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─────────────────────────────────────────────────────────────────
-- Helper: is the current user an admin?
-- ─────────────────────────────────────────────────────────────────

create function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  );
$$;

-- Stop non-admins from promoting themselves, even though they can
-- otherwise update their own profile row (e.g. to change display_name).
create function public.prevent_self_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- auth.uid() is null for SQL Editor / service-role connections, which are
  -- already fully trusted; only block a signed-in non-admin app user here.
  if new.role <> old.role and auth.uid() is not null and not public.is_admin() then
    raise exception 'Only admins can change roles';
  end if;
  return new;
end;
$$;

create trigger enforce_role_change
  before update on public.profiles
  for each row execute function public.prevent_self_role_escalation();

-- ─────────────────────────────────────────────────────────────────
-- Row Level Security
-- ─────────────────────────────────────────────────────────────────

alter table public.profiles enable row level security;
alter table public.games enable row level security;
alter table public.bookings enable row level security;
alter table public.game_stats enable row level security;
alter table public.clips enable row level security;
alter table public.posts enable row level security;
alter table public.post_likes enable row level security;

-- profiles: everyone signed in can see names; you can edit your own row
-- (role changes are blocked by the trigger above unless you're an admin)
create policy "profiles_select" on public.profiles for select using (auth.role() = 'authenticated');
create policy "profiles_insert_own" on public.profiles for insert with check (auth.uid() = id);
create policy "profiles_update_own_or_admin" on public.profiles for update
  using (auth.uid() = id or public.is_admin())
  with check (auth.uid() = id or public.is_admin());

-- games: everyone signed in can view; only admins can manage fixtures
create policy "games_select" on public.games for select using (auth.role() = 'authenticated');
create policy "games_insert_admin" on public.games for insert with check (public.is_admin());
create policy "games_update_admin" on public.games for update using (public.is_admin()) with check (public.is_admin());
create policy "games_delete_admin" on public.games for delete using (public.is_admin());

-- bookings: everyone signed in can view the team sheet; you can book/cancel
-- your own spot; you can mark your own booking "pending" (I've paid), only
-- an admin can confirm payment or edit someone else's booking
create policy "bookings_select" on public.bookings for select using (auth.role() = 'authenticated');
create policy "bookings_insert_own_or_admin" on public.bookings for insert with check (player_id = auth.uid() or public.is_admin());
create policy "bookings_delete_own_or_admin" on public.bookings for delete using (player_id = auth.uid() or public.is_admin());
create policy "bookings_update_payment" on public.bookings for update
  using (player_id = auth.uid() or public.is_admin())
  with check (public.is_admin() or (player_id = auth.uid() and status = 'pending'));

-- game_stats (goalscorers): everyone signed in can view; only admins record goals
create policy "game_stats_select" on public.game_stats for select using (auth.role() = 'authenticated');
create policy "game_stats_insert_admin" on public.game_stats for insert with check (public.is_admin());
create policy "game_stats_update_admin" on public.game_stats for update using (public.is_admin()) with check (public.is_admin());
create policy "game_stats_delete_admin" on public.game_stats for delete using (public.is_admin());

-- clips: everyone signed in can view and submit; you (or an admin) can remove yours
create policy "clips_select" on public.clips for select using (auth.role() = 'authenticated');
create policy "clips_insert_own" on public.clips for insert with check (auth.uid() = submitted_by);
create policy "clips_delete_own_or_admin" on public.clips for delete using (submitted_by = auth.uid() or public.is_admin());

-- posts + likes: everyone signed in can view and post; you (or an admin) can remove yours
create policy "posts_select" on public.posts for select using (auth.role() = 'authenticated');
create policy "posts_insert_own" on public.posts for insert with check (author_id = auth.uid());
create policy "posts_delete_own_or_admin" on public.posts for delete using (author_id = auth.uid() or public.is_admin());

create policy "post_likes_select" on public.post_likes for select using (auth.role() = 'authenticated');
create policy "post_likes_insert_own" on public.post_likes for insert with check (user_id = auth.uid());
create policy "post_likes_delete_own" on public.post_likes for delete using (user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────────
-- Waiting list — enforced server-side so it can't be raced or bypassed
-- ─────────────────────────────────────────────────────────────────

-- New bookings land on the waiting list once a game's confirmed spots are full.
create function public.bookings_set_waiting()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cap int;
  taken int;
  waiting_count int;
begin
  select max_players into cap from public.games where id = new.game_id;
  select count(*) into taken from public.bookings where game_id = new.game_id and waiting = false;
  new.waiting := taken >= cap;

  if new.waiting then
    select count(*) into waiting_count from public.bookings where game_id = new.game_id and waiting = true;
    if waiting_count >= 10 then
      raise exception 'The waiting list is full (10 max)';
    end if;
  end if;

  return new;
end;
$$;

create trigger bookings_before_insert_set_waiting
  before insert on public.bookings
  for each row execute function public.bookings_set_waiting();

-- When a confirmed spot opens up, promote whoever's been waiting longest.
create function public.bookings_promote_waiting()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.waiting = false then
    update public.bookings
    set waiting = false
    where id = (
      select id from public.bookings
      where game_id = old.game_id and waiting = true
      order by created_at asc
      limit 1
    );
  end if;
  return old;
end;
$$;

create trigger bookings_after_delete_promote_waiting
  after delete on public.bookings
  for each row execute function public.bookings_promote_waiting();

-- game_stats isn't foreign-keyed to bookings (a goal tally and a
-- booking are recorded independently), so removing someone's booking
-- never cleaned up their goals for that game on its own.
create function public.bookings_cleanup_stats()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.game_stats where game_id = old.game_id and player_id = old.player_id;
  return old;
end;
$$;

create trigger bookings_after_delete_cleanup_stats
  after delete on public.bookings
  for each row execute function public.bookings_cleanup_stats();

-- ─────────────────────────────────────────────────────────────────
-- Line-up — admin-assigned team (white/red) per booking. Naturally
-- scoped to one game and reset for the next, since it's just a
-- column on the game-specific booking row.
-- ─────────────────────────────────────────────────────────────────

alter table public.bookings add column team text check (team in ('white', 'red'));

create function public.prevent_non_admin_team_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.team is distinct from old.team and auth.uid() is not null and not public.is_admin() then
    raise exception 'Only admins can set line-up teams';
  end if;
  return new;
end;
$$;

create trigger enforce_team_change
  before update on public.bookings
  for each row execute function public.prevent_non_admin_team_change();

-- ─────────────────────────────────────────────────────────────────
-- Owner role — a tier above admin. Admins can promote players to
-- admin, but only the owner can touch an existing admin's role or
-- delete an admin's account.
-- ─────────────────────────────────────────────────────────────────

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('player', 'admin', 'owner'));

-- owner counts as admin everywhere the app already checks is_admin()
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role in ('admin', 'owner')
  );
$$;

create function public.is_owner()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'owner'
  );
$$;

create or replace function public.prevent_self_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_role text;
begin
  if new.role = old.role then
    return new;
  end if;

  -- SQL Editor / service-role connections are already fully trusted
  if auth.uid() is null then
    return new;
  end if;

  select role into caller_role from public.profiles where id = auth.uid();

  if caller_role = 'owner' then
    return new;
  end if;

  if caller_role = 'admin' then
    if old.role <> 'player' then
      raise exception 'Only the owner can change an admin''s role';
    end if;
    if new.role <> 'admin' then
      raise exception 'Admins can only promote players to admin';
    end if;
    return new;
  end if;

  raise exception 'Only admins can change roles';
end;
$$;

-- ─────────────────────────────────────────────────────────────────
-- Club settings — team names/colours and the manual "most goals in
-- a game" shoutout, editable by admins instead of hardcoded. Single
-- row enforced via the boolean primary key trick (id must be true).
-- ─────────────────────────────────────────────────────────────────

create table public.club_settings (
  id boolean primary key default true check (id),
  team_white_name text not null default 'Whites',
  team_white_color text not null default '#EEF4FC',
  team_red_name text not null default 'Reds',
  team_red_color text not null default '#E42A36',
  record_holder_name text,
  record_goals int,
  record_note text,
  updated_at timestamptz not null default now()
);

insert into public.club_settings (id) values (true);

alter table public.club_settings enable row level security;

create policy "club_settings_select" on public.club_settings for select using (auth.role() = 'authenticated');
create policy "club_settings_update_admin" on public.club_settings for update using (public.is_admin()) with check (public.is_admin());

-- Final team score per game, for the Reds v Whites head-to-head table.
-- Independent of individual goal tallies (own goals / unknown scorers
-- happen), so admins enter it directly rather than it being derived.
alter table public.games add column team_white_score int;
alter table public.games add column team_red_score int;

-- ─────────────────────────────────────────────────────────────────
-- Awards — free-form admin-managed shoutouts (Goal of the Season,
-- Player of the Season, etc). Deliberately just title/value/note text
-- rather than fixed columns per award type, so admins aren't limited
-- to whatever awards were thought of when this was built.
-- Supersedes club_settings.record_* (left in place, unused, rather
-- than dropped - not worth the migration risk for existing data).
-- ─────────────────────────────────────────────────────────────────

create table public.awards (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  value text not null,
  note text,
  created_at timestamptz not null default now()
);

alter table public.awards enable row level security;

create policy "awards_select" on public.awards for select using (auth.role() = 'authenticated');
create policy "awards_insert_admin" on public.awards for insert with check (public.is_admin());
create policy "awards_delete_admin" on public.awards for delete using (public.is_admin());

-- ─────────────────────────────────────────────────────────────────
-- Realtime — so the team sheet updates live as people book/cancel
-- ─────────────────────────────────────────────────────────────────

alter publication supabase_realtime add table public.bookings;

-- ─────────────────────────────────────────────────────────────────
-- One-time data fix — recompute `waiting` for every existing booking
-- based on booking order vs each game's max_players. Bookings made
-- before the waiting-list trigger existed never had this computed.
-- ─────────────────────────────────────────────────────────────────

with ranked as (
  select
    b.id,
    row_number() over (partition by b.game_id order by b.created_at asc) as rn,
    g.max_players
  from public.bookings b
  join public.games g on g.id = b.game_id
)
update public.bookings b
set waiting = (ranked.rn > ranked.max_players)
from ranked
where b.id = ranked.id;

-- ─────────────────────────────────────────────────────────────────
-- Co-owner role — full admin-equivalent capability everywhere
-- (is_admin() now includes it), but protected from regular admins
-- exactly like owner is. Only the owner can promote someone to
-- co-owner, or change/remove a co-owner's role. Co-owners have the
-- same authority over *existing* admins that a regular admin does
-- (i.e. none - still owner-only), not expanded owner-level authority.
-- ─────────────────────────────────────────────────────────────────

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('player', 'admin', 'co-owner', 'owner'));

create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role in ('admin', 'co-owner', 'owner')
  );
$$;

create or replace function public.prevent_self_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_role text;
begin
  if new.role = old.role then
    return new;
  end if;

  if auth.uid() is null then
    return new;
  end if;

  select role into caller_role from public.profiles where id = auth.uid();

  if caller_role = 'owner' then
    return new;
  end if;

  if caller_role in ('admin', 'co-owner') then
    if old.role <> 'player' then
      raise exception 'Only the owner can change that role';
    end if;
    if new.role <> 'admin' then
      raise exception 'You can only promote a player to admin';
    end if;
    return new;
  end if;

  raise exception 'Only admins can change roles';
end;
$$;

-- ─────────────────────────────────────────────────────────────────
-- Community pot — auto contribution per game is computed client-side
-- from confirmed payments vs pitch cost (nothing to store), so this
-- only needs a place for the pitch cost itself and admin's manual
-- entries (socials, sponsorship, equipment spend, etc).
-- ─────────────────────────────────────────────────────────────────

alter table public.games add column pitch_cost numeric not null default 55;

create table public.pot_entries (
  id uuid primary key default gen_random_uuid(),
  amount numeric not null,
  description text not null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.pot_entries enable row level security;

create policy "pot_entries_select" on public.pot_entries for select using (auth.role() = 'authenticated');
create policy "pot_entries_insert_admin" on public.pot_entries for insert with check (public.is_admin());
create policy "pot_entries_delete_admin" on public.pot_entries for delete using (public.is_admin());

-- ─────────────────────────────────────────────────────────────────
-- Man of the Match voting — one vote per player per game, changeable
-- (upsert on game_id+voter_id) until the app-side voting window
-- closes. Tallies aren't hidden at the DB level (kept simple, same
-- trust level as the rest of the app) - the client just doesn't
-- render them until the window's closed.
-- ─────────────────────────────────────────────────────────────────

create table public.motm_votes (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  voter_id uuid not null references public.profiles (id) on delete cascade,
  candidate_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (game_id, voter_id)
);

alter table public.motm_votes enable row level security;

create policy "motm_votes_select" on public.motm_votes for select using (auth.role() = 'authenticated');

create policy "motm_votes_insert_own" on public.motm_votes for insert with check (
  voter_id = auth.uid()
  and exists (
    select 1 from public.bookings b
    where b.game_id = motm_votes.game_id and b.player_id = voter_id
      and b.status = 'confirmed' and b.waiting = false
  )
  and exists (
    select 1 from public.bookings b
    where b.game_id = motm_votes.game_id and b.player_id = candidate_id
      and b.status = 'confirmed' and b.waiting = false
  )
);

create policy "motm_votes_update_own" on public.motm_votes for update
  using (voter_id = auth.uid())
  with check (
    voter_id = auth.uid()
    and exists (
      select 1 from public.bookings b
      where b.game_id = motm_votes.game_id and b.player_id = candidate_id
        and b.status = 'confirmed' and b.waiting = false
    )
  );

create policy "motm_votes_delete_own_or_admin" on public.motm_votes for delete using (voter_id = auth.uid() or public.is_admin());

-- ─────────────────────────────────────────────────────────────────
-- Club feed reactions — the feed itself is mostly derived client-side
-- from existing tables (games, profiles, pot_entries, clips), not
-- stored. item_key is a synthetic string built by the client (e.g.
-- "game-<id>-fulltime", "motm-<id>", "pot-150", "join-<id>",
-- "clip-<id>") rather than a foreign key, since feed rows aren't all
-- the same underlying type.
-- ─────────────────────────────────────────────────────────────────

create table public.feed_reactions (
  id uuid primary key default gen_random_uuid(),
  item_key text not null,
  emoji text not null,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (item_key, emoji, user_id)
);

alter table public.feed_reactions enable row level security;

create policy "feed_reactions_select" on public.feed_reactions for select using (auth.role() = 'authenticated');
create policy "feed_reactions_insert_own" on public.feed_reactions for insert with check (user_id = auth.uid());
create policy "feed_reactions_delete_own" on public.feed_reactions for delete using (user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────────
-- Push notifications. One row per browser/device that's granted
-- permission (someone using the app on their phone and laptop gets
-- two rows, both get pushed to). Sending only ever happens from the
-- server (service_role key, via Route Handlers) since it needs the
-- VAPID private key - RLS here only governs who can register/remove
-- their own device.
-- ─────────────────────────────────────────────────────────────────

alter table public.profiles add column push_opt_in boolean not null default true;

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth_key text not null,
  created_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;

create policy "push_subscriptions_select_own" on public.push_subscriptions for select using (user_id = auth.uid());
create policy "push_subscriptions_insert_own" on public.push_subscriptions for insert with check (user_id = auth.uid());
create policy "push_subscriptions_delete_own" on public.push_subscriptions for delete using (user_id = auth.uid());

-- Generic "have we already pushed for this?" ledger, reused by the daily
-- cron for both MOTM-winner and Player-of-the-Month announcements, so a
-- cron run that fires more than once around the same boundary can't send
-- the same push twice. No RLS policies on purpose - only the service_role
-- key (server-side cron) ever touches this table.
create table public.notified_events (
  event_key text primary key,
  notified_at timestamptz not null default now()
);

alter table public.notified_events enable row level security;

-- ─────────────────────────────────────────────────────────────────
-- Block new bookings for a player who still owes money from a past
-- game (same definition as the admin console's "Overdue" section:
-- an unconfirmed, non-waiting booking on a game whose date has
-- passed). Enforced in the RLS policy itself, not just the UI, so it
-- can't be bypassed - admins can still add an overdue player to a
-- game manually if they choose to override it.
-- ─────────────────────────────────────────────────────────────────

create or replace function public.has_overdue_payment(check_player_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.bookings b
    join public.games g on g.id = b.game_id
    where b.player_id = check_player_id
      and b.waiting = false
      and b.status != 'confirmed'
      and g.date < (now() at time zone 'Europe/London')::date
  );
$$;

drop policy if exists "bookings_insert_own_or_admin" on public.bookings;
create policy "bookings_insert_own_or_admin" on public.bookings for insert with check (
  (player_id = auth.uid() and not public.has_overdue_payment(auth.uid()))
  or public.is_admin()
);

-- ─────────────────────────────────────────────────────────────────
-- Fixture draft/confirm - a new fixture is created unpublished with
-- placeholder details, invisible to players, until an admin actually
-- fills in the real venue/date/etc and hits "Confirm & post fixture".
-- That first save is also what triggers the new-fixture push, instead
-- of it firing instantly with today's date and "New venue".
-- Default true so every existing fixture is unaffected by this change.
-- ─────────────────────────────────────────────────────────────────

alter table public.games add column published boolean not null default true;

drop policy if exists "games_select" on public.games;
create policy "games_select" on public.games for select using (published = true or public.is_admin());

-- Pitch fee has gone from £55 to £50 - new default for future fixtures.
-- Existing upcoming (not yet played) fixtures still at the old £55
-- default are bumped down too; past games are left as the historical
-- record of what was actually paid.
alter table public.games alter column pitch_cost set default 50;
update public.games set pitch_cost = 50 where pitch_cost = 55 and date >= current_date;

-- ─────────────────────────────────────────────────────────────────
-- MOTM voting eligibility was gated on payment status ("confirmed"),
-- not just "did they actually play" - payment confirmation is an admin
-- action that often lags well behind kickoff, and voting closes only
-- hours after it, so this was likely blocking people who genuinely
-- played from voting or being voted for.
-- ─────────────────────────────────────────────────────────────────

drop policy if exists "motm_votes_insert_own" on public.motm_votes;
create policy "motm_votes_insert_own" on public.motm_votes for insert with check (
  voter_id = auth.uid()
  and exists (
    select 1 from public.bookings b
    where b.game_id = motm_votes.game_id and b.player_id = voter_id and b.waiting = false
  )
  and exists (
    select 1 from public.bookings b
    where b.game_id = motm_votes.game_id and b.player_id = candidate_id and b.waiting = false
  )
);

drop policy if exists "motm_votes_update_own" on public.motm_votes;
create policy "motm_votes_update_own" on public.motm_votes for update
  using (voter_id = auth.uid())
  with check (
    voter_id = auth.uid()
    and exists (
      select 1 from public.bookings b
      where b.game_id = motm_votes.game_id and b.player_id = candidate_id and b.waiting = false
    )
  );

-- ─────────────────────────────────────────────────────────────────
-- Archiving derived feed items (full-time scores, MOTM winners, pot
-- milestones, new joiners) - these aren't real rows, so there's
-- nothing to delete. item_key matches the same synthetic string the
-- feed already uses for reactions. Admin-only, reversible (a row
-- here just means "hidden", removing it un-hides).
-- ─────────────────────────────────────────────────────────────────

create table public.feed_hidden_items (
  item_key text primary key,
  hidden_by uuid references public.profiles (id) on delete set null,
  hidden_at timestamptz not null default now()
);

alter table public.feed_hidden_items enable row level security;

create policy "feed_hidden_items_select" on public.feed_hidden_items for select using (auth.role() = 'authenticated');
create policy "feed_hidden_items_insert_admin" on public.feed_hidden_items for insert with check (public.is_admin());
create policy "feed_hidden_items_delete_admin" on public.feed_hidden_items for delete using (public.is_admin());

-- ─────────────────────────────────────────────────────────────────
-- Admin activity log - who confirmed a payment, added/published a
-- fixture, changed a role, etc. Useful once there's more than one
-- admin/co-owner, so two people don't duplicate work or wonder what
-- already happened. Immutable (no update/delete policy) and
-- admin-only to read, since it can reference other players by name.
-- ─────────────────────────────────────────────────────────────────

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles (id) on delete set null,
  action text not null,
  details text,
  created_at timestamptz not null default now()
);

alter table public.audit_log enable row level security;

create policy "audit_log_select_admin" on public.audit_log for select using (public.is_admin());
create policy "audit_log_insert_admin" on public.audit_log for insert with check (public.is_admin());

-- Who confirmed a payment and when, tracked on the booking itself rather
-- than the audit log - payment confirmations happen too often (~16/week
-- per fixture) to belong in a log meant for rare, otherwise-invisible
-- actions, but the attribution is still worth keeping on hand.
alter table public.bookings add column confirmed_by uuid references public.profiles (id) on delete set null;
alter table public.bookings add column confirmed_at timestamptz;

-- Structured category on manual pot entries, so spend/income can actually
-- be grouped reliably (e.g. for a future finances dashboard) instead of
-- guessing from freeform description text. Existing rows default to
-- 'other' since there's no way to infer their real category retroactively.
alter table public.pot_entries add column category text not null default 'other'
  check (category in ('pitch', 'socials', 'equipment', 'sponsorship', 'other'));

-- ─────────────────────────────────────────────────────────────────
-- Team fairness ratings. Two separate tables, not one, because
-- visibility is genuinely different: a player can see (and set) their
-- own self-rating, admins can see it too (needed for the fallback
-- logic below), but no player - including the one being rated - can
-- ever see an admin rating. Admin ratings are shared across all
-- admins/co-owners (one row per player, last write wins) rather than
-- per-admin, so there's one agreed view of the squad.
--
-- Effective rating for fairness calculations = admin rating if one
-- exists, else the player's own self-rating, else unrated.
-- ─────────────────────────────────────────────────────────────────

create table public.player_self_ratings (
  player_id uuid primary key references public.profiles (id) on delete cascade,
  fitness int not null check (fitness between 1 and 5),
  attack int not null check (attack between 1 and 5),
  defence int not null check (defence between 1 and 5),
  position text not null check (position in ('keeper', 'defence', 'midfield', 'attack')),
  updated_at timestamptz not null default now()
);

alter table public.player_self_ratings enable row level security;

create policy "self_ratings_select" on public.player_self_ratings for select using (player_id = auth.uid() or public.is_admin());
create policy "self_ratings_insert_own" on public.player_self_ratings for insert with check (player_id = auth.uid());
create policy "self_ratings_update_own" on public.player_self_ratings for update using (player_id = auth.uid()) with check (player_id = auth.uid());

create table public.player_admin_ratings (
  player_id uuid primary key references public.profiles (id) on delete cascade,
  fitness int not null check (fitness between 1 and 5),
  attack int not null check (attack between 1 and 5),
  defence int not null check (defence between 1 and 5),
  position text not null check (position in ('keeper', 'defence', 'midfield', 'attack')),
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.player_admin_ratings enable row level security;

create policy "admin_ratings_select_admin" on public.player_admin_ratings for select using (public.is_admin());
create policy "admin_ratings_insert_admin" on public.player_admin_ratings for insert with check (public.is_admin());
create policy "admin_ratings_update_admin" on public.player_admin_ratings for update using (public.is_admin()) with check (public.is_admin());

-- Default venue/kickoff for the "+ Fixture" button, editable in Club
-- settings instead of always starting from the "New venue" placeholder
-- and a hardcoded 19:00.
alter table public.club_settings add column default_venue text not null default 'New venue';
alter table public.club_settings add column default_kickoff text not null default '19:00';

-- Same reasoning extended to the rest of the "+ Fixture" defaults that were
-- previously hardcoded in the client (price, pitch format, squad size).
alter table public.club_settings add column default_price numeric not null default 5;
alter table public.club_settings add column default_pitch text not null default '8-a-side';
alter table public.club_settings add column default_max_players int not null default 16;

-- push_opt_in defaulted to true, so every brand-new profile looked
-- "opted in" before ever granting real browser permission or
-- registering a push_subscriptions row - misleading if read directly
-- (the UI already cross-checks against a real subscription for
-- anything it displays, but the raw flag itself was just wrong).
-- Flip the default going forward, then one-time-correct every
-- existing profile to match reality: true only if they actually have
-- a live subscription, false otherwise.
alter table public.profiles alter column push_opt_in set default false;

update public.profiles p
set push_opt_in = false
where not exists (select 1 from public.push_subscriptions s where s.user_id = p.id);

update public.profiles p
set push_opt_in = true
where exists (select 1 from public.push_subscriptions s where s.user_id = p.id);

-- Tracks when the "fixture update" WhatsApp digest was last generated, so
-- the digest can report "N bookings since the last update" and which
-- fixtures moved the most - reusing the same admin-copies-formatted-text
-- pattern as the lineup WhatsApp button, not a new messaging integration.
alter table public.club_settings add column last_fixture_update_at timestamptz;

-- Whichever method actually produced a game's saved Team Sheet
-- ("generated" via Apply this split, "manual" via Edit line-up -> Save,
-- including a generated split that got hand-tweaked afterward, since
-- that's what players actually played), plus its balance score at the
-- moment it was saved. Lets the club see, once results are in, whether
-- generated splits really do produce closer games than picking by eye -
-- see the balance-history feature.
alter table public.games add column team_method text check (team_method in ('generated', 'manual'));
alter table public.games add column team_balance_score int;

-- ─────────────────────────────────────────────────────────────────
-- Award media (image/video upload on admin-created awards). Images are
-- compressed client-side before upload; video has a client-side size cap
-- - both deliberate given the free tier's 1GB total / 50MB per-file
-- limits. Bucket is public (read) since award media is just celebratory
-- club content, no sensitivity - write/delete restricted to admins.
-- ─────────────────────────────────────────────────────────────────

alter table public.awards add column image_url text;
alter table public.awards add column video_url text;

insert into storage.buckets (id, name, public) values ('award-media', 'award-media', true);

create policy "award_media_read" on storage.objects for select using (bucket_id = 'award-media');
create policy "award_media_admin_insert" on storage.objects for insert with check (bucket_id = 'award-media' and public.is_admin());
create policy "award_media_admin_delete" on storage.objects for delete using (bucket_id = 'award-media' and public.is_admin());

-- ─────────────────────────────────────────────────────────────────
-- Direct message inbox. One-way admin -> player nudges (payment
-- reminders etc) for players who joined online and aren't reachable
-- via the club WhatsApp group. Deliberately not a chat - recipients
-- can only read + mark their own rows read, never insert or reply.
-- ─────────────────────────────────────────────────────────────────

create table public.admin_messages (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  sender_id uuid references public.profiles(id) on delete set null,
  message text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

alter table public.admin_messages enable row level security;

create policy "admin_messages_select" on public.admin_messages for select using (recipient_id = auth.uid() or public.is_admin());
create policy "admin_messages_insert_admin" on public.admin_messages for insert with check (public.is_admin());
create policy "admin_messages_update_own_read" on public.admin_messages for update
  using (recipient_id = auth.uid())
  with check (recipient_id = auth.uid());

-- Stamped whenever the Team Sheet is saved (manual edit or applying a
-- generated split) - drives the Line-up nav "something's new" dot, since
-- unlike a finished game there's no other reliable timestamp for "the
-- lineup just changed."
alter table public.games add column team_set_at timestamptz;

-- Nav "something's new" dots feature (Feed/Results/Line-up) removed
-- 2026-08-12 - kept misfiring (stuck lit) even after fixing the
-- underlying pretend-UTC/real-epoch axis mismatch, and the user judged
-- it more likely to confuse than help. team_set_at only ever existed to
-- drive it.
alter table public.games drop column team_set_at;

-- ─────────────────────────────────────────────────────────────────
-- Score prediction game. Booked players only (deliberate - turns
-- predicting into an incentive to actually book, and means the prize
-- is only ever contested by people who showed up), score-only (no MOTM
-- guessing - see the design notes in memory for why that was dropped).
-- Enforced at the RLS layer, not just the UI: you can only insert/update
-- a prediction for a game you're actually booked on (confirmed spot,
-- not waiting list) and only before that game's kickoff - both real
-- integrity rules, not just UX guardrails, since players could
-- otherwise submit or adjust a guess after watching the game start.
-- ─────────────────────────────────────────────────────────────────

create table public.score_predictions (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  player_id uuid not null references public.profiles(id) on delete cascade,
  predicted_white int not null check (predicted_white >= 0),
  predicted_red int not null check (predicted_red >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (game_id, player_id)
);

alter table public.score_predictions enable row level security;

-- Select is unrestricted (any authenticated user) rather than own-only -
-- the app itself withholds other players' individual guesses from the UI
-- until a game's scored (same client-side gating pattern as MOTM tally
-- staying hidden until voting closes), so there's no integrity reason to
-- restrict this at the RLS layer too.
create policy "score_predictions_select" on public.score_predictions for select using (auth.role() = 'authenticated');

create policy "score_predictions_insert_own" on public.score_predictions for insert with check (
  player_id = auth.uid()
  and exists (
    select 1 from public.bookings b
    where b.game_id = score_predictions.game_id and b.player_id = auth.uid() and b.waiting = false
  )
  and exists (
    select 1 from public.games g
    where g.id = score_predictions.game_id and (g.date + g.kickoff::time) > (now() at time zone 'Europe/London')
  )
);

create policy "score_predictions_update_own" on public.score_predictions for update
  using (player_id = auth.uid())
  with check (
    player_id = auth.uid()
    and exists (
      select 1 from public.games g
      where g.id = score_predictions.game_id and (g.date + g.kickoff::time) > (now() at time zone 'Europe/London')
    )
  );

-- ─────────────────────────────────────────────────────────────────
-- Pot-exempt bookings - a booking can stay "confirmed" (real spot,
-- never wrongly flagged overdue, all existing status logic untouched)
-- while being excluded from that game's pot income, for two real cases:
-- a prediction-league prize winner's free game, and a booking carried
-- over from an already-paid-for game (counting it again would double
-- the income). A straightforward refund where the player is removed
-- from the game entirely needs no schema change at all - the pot is
-- computed live from existing bookings, so deleting the booking already
-- correctly drops that income.
-- No RLS change needed - the existing bookings_update_payment policy
-- already lets an admin update any column via its `public.is_admin()`
-- check.
-- ─────────────────────────────────────────────────────────────────
alter table public.bookings add column pot_exempt_reason text check (pot_exempt_reason in ('prize', 'carried_over', 'other'));

-- ─────────────────────────────────────────────────────────────────
-- Real bug: the day-5-warning/day-7-removal payment window (see
-- app/api/cron/frequent/route.ts) was measured from bookings.created_at
-- for every unpaid booking - correct for someone who booked straight
-- into a real spot, but wrong for someone promoted off the waiting
-- list. Their created_at is from whenever they originally joined the
-- waiting list, potentially days earlier, so promotion could hand them
-- a payment window already most of the way to expired (reported case:
-- 5 days on the waiting list, promoted, only 2 of the intended 7 days
-- left to pay). The clock should start when they actually got a real,
-- payable spot, not whenever the row was first created.
-- ─────────────────────────────────────────────────────────────────
alter table public.bookings add column promoted_at timestamptz;

create or replace function public.bookings_promote_waiting()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.waiting = false then
    update public.bookings
    set waiting = false, promoted_at = now()
    where id = (
      select id from public.bookings
      where game_id = old.game_id and waiting = true
      order by created_at asc
      limit 1
    );
  end if;
  return old;
end;
$$;

-- ─────────────────────────────────────────────────────────────────
-- One-time backfill: the trigger above only sets promoted_at going
-- forward, so any booking promoted off the waiting list *before* this
-- migration ran is still sitting on promoted_at = null - exactly the
-- state that reproduces the original bug (reported case: someone
-- removed for "7 days unpaid" who'd actually only had a real spot for
-- 2). There's no reliable way to recover the real historical
-- promotion time from stored data alone, so the safe call for anyone
-- currently exposed to this gap (still unpaid, not on the waiting
-- list, no promoted_at yet) is to start their window fresh from now -
-- it never shortens anyone's grace period, only ever extends it.
-- ─────────────────────────────────────────────────────────────────
update public.bookings
set promoted_at = now()
where waiting = false and status = 'unpaid' and promoted_at is null;

-- ─────────────────────────────────────────────────────────────────
-- Player tabs (Admin console). Regroups the existing Overdue data by
-- player instead of one row per booking, split into "owed" (unpaid,
-- real debt) vs "pending" (already marked paid, just awaiting admin
-- confirmation - never treated as owed, same rule the day-5 warning
-- already follows). A pot-exempt booking (prize/carried-over/other)
-- is real either way and must never count as owed - fixing that here
-- at the source (has_overdue_payment) rather than just client-side,
-- since this function is what the booking-block RLS actually enforces.
-- Without this fix, a comped booking left in a non-confirmed status
-- could wrongly block that player from booking their next game.
-- ─────────────────────────────────────────────────────────────────
create or replace function public.has_overdue_payment(check_player_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.bookings b
    join public.games g on g.id = b.game_id
    where b.player_id = check_player_id
      and b.waiting = false
      and b.status != 'confirmed'
      and b.pot_exempt_reason is null
      and g.date < (now() at time zone 'Europe/London')::date
  );
$$;

-- ─────────────────────────────────────────────────────────────────
-- Admin drag-and-drop pitch positions. Keyed by player_id:
-- { "<player_id>": { "x": 0-100, "y": 0-100 } }. A player missing
-- from this map (new booking since the last "lock in", or the map
-- itself is null) falls back to the auto-generated formationSlots()
-- layout for that one player, same as before this existed.
-- ─────────────────────────────────────────────────────────────────
alter table public.games add column lineup_positions jsonb;
