-- Local stand-in for the parts of a Supabase database these migrations rely on: the auth schema,
-- auth.uid(), the extensions schema and the Supabase roles. Used only by run-local.sh.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

do $$ begin
  create role anon nologin;
exception when duplicate_object then null; end $$;
do $$ begin
  create role authenticated nologin;
exception when duplicate_object then null; end $$;
do $$ begin
  create role service_role nologin bypassrls;
exception when duplicate_object then null; end $$;
do $$ begin
  create role supabase_auth_admin nologin;
exception when duplicate_object then null; end $$;

grant usage on schema extensions to anon, authenticated, service_role;
-- Supabase's own default privileges for postgres in public: everything is granted to the API roles
-- unless a migration revokes it. Mirroring them here means the tests catch a missing revoke.
grant all on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role, supabase_auth_admin;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  email_confirmed_at timestamptz
);

create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- Phase 8: Auth's session tables (suspension and staff removal end every session) and the last sign-in time.
alter table auth.users add column if not exists last_sign_in_at timestamptz;
create table if not exists auth.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create table if not exists auth.refresh_tokens (
  id bigserial primary key,
  user_id varchar(255),
  session_id uuid references auth.sessions (id) on delete cascade,
  revoked boolean not null default false
);
