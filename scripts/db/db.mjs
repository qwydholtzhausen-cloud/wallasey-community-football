// npm run test:db - a throwaway copy of the club database: real Postgres (PGlite, in memory)
// built from supabase/schema.sql, with stand-ins for the Supabase pieces
// (auth.uid(), roles, storage) so the real triggers, functions and
// row-level security run as they do live.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const SCHEMA = new URL("../../supabase/schema.sql", import.meta.url).pathname;

const SHIM = `
create schema if not exists auth;
create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb, created_at timestamptz default now());
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon')
$$;
create schema if not exists storage;
create table storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, created_at timestamptz default now());
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/') $$;
alter table storage.objects enable row level security;
do $$ begin
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
exception when duplicate_object then null; end $$;
`;

// Split SQL into statements, respecting $$...$$ / $tag$ bodies, quotes and comments.
export function splitSql(sql) {
  const out = [];
  let cur = "", i = 0, dollar = null, q = false;
  while (i < sql.length) {
    const ch = sql[i];
    if (dollar) {
      if (sql.startsWith(dollar, i)) { cur += dollar; i += dollar.length; dollar = null; continue; }
      cur += ch; i++; continue;
    }
    if (q) { cur += ch; if (ch === "'") q = false; i++; continue; }
    if (ch === "-" && sql[i + 1] === "-") { const e = sql.indexOf("\n", i); i = e < 0 ? sql.length : e; continue; }
    if (ch === "'") { q = true; cur += ch; i++; continue; }
    if (ch === "$") { const m = sql.slice(i).match(/^\$[A-Za-z_]*\$/); if (m) { dollar = m[0]; cur += dollar; i += dollar.length; continue; } }
    if (ch === ";") { if (cur.trim()) out.push(cur.trim()); cur = ""; i++; continue; }
    cur += ch; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export async function makeDb({ verbose = false } = {}) {
  const db = new PGlite();
  await db.exec(SHIM);
  const failures = [];
  for (const stmt of splitSql(readFileSync(SCHEMA, "utf8"))) {
    try { await db.exec(stmt); }
    catch (e) { failures.push({ stmt: stmt.slice(0, 120).replace(/\s+/g, " "), err: e.message }); }
  }
  // Supabase's default grants to signed-in users.
  await db.exec(`
    grant usage on schema public, auth, storage to anon, authenticated, service_role;
    grant all on all tables in schema public to authenticated, service_role;
    grant all on all sequences in schema public to authenticated, service_role;
    grant execute on all functions in schema public to authenticated, anon, service_role;
    grant execute on all functions in schema auth to authenticated, anon, service_role;
  `);
  if (verbose) for (const f of failures) console.log("SCHEMA SKIP:", f.err, "::", f.stmt);
  return { db, failures };
}

// Run fn as a signed-in user (RLS applies), like a request from the app.
export async function as(db, userId, fn) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${userId}', false); select set_config('request.jwt.claim.role', 'authenticated', false);`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`); }
}
