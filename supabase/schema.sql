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
