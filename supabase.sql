-- Run once in Supabase: SQL Editor -> New query -> paste -> Run.
-- Every table is locked to the signed-in user with Row Level Security (RLS).
-- Meeting audio and full transcripts are NOT stored. Only approved records are.

create extension if not exists pgcrypto;

create table if not exists public.consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  version text not null,
  accepted_at timestamptz not null default now()
);

create table if not exists public.records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  client_id text not null,
  summary text not null default '',
  key_points jsonb not null default '[]'::jsonb,
  action_items jsonb not null default '[]'::jsonb,
  fields jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.usage_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists records_user_idx on public.records (user_id, created_at desc);
create index if not exists usage_user_idx on public.usage_log (user_id, created_at desc);

alter table public.consents  enable row level security;
alter table public.records   enable row level security;
alter table public.usage_log enable row level security;

drop policy if exists consents_select on public.consents;
drop policy if exists consents_insert on public.consents;
create policy consents_select on public.consents for select using (user_id = auth.uid());
create policy consents_insert on public.consents for insert with check (user_id = auth.uid());

drop policy if exists records_all on public.records;
create policy records_all on public.records for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists usage_select on public.usage_log;
drop policy if exists usage_insert on public.usage_log;
create policy usage_select on public.usage_log for select using (user_id = auth.uid());
create policy usage_insert on public.usage_log for insert with check (user_id = auth.uid());
-- (no update or delete policy on usage_log: users cannot erase their own usage)
