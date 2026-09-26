-- MOTOR.BY 1.8.1 — one encrypted-in-transit JSON state row per Google account.
-- Run once in Supabase Dashboard → SQL Editor → New query → Run.

create table if not exists public.motorby_user_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  schema_version integer not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.motorby_user_state enable row level security;

revoke all on table public.motorby_user_state from anon;
grant select, insert, update, delete on table public.motorby_user_state to authenticated;

drop policy if exists "motorby_select_own_state" on public.motorby_user_state;
create policy "motorby_select_own_state"
on public.motorby_user_state
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "motorby_insert_own_state" on public.motorby_user_state;
create policy "motorby_insert_own_state"
on public.motorby_user_state
for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "motorby_update_own_state" on public.motorby_user_state;
create policy "motorby_update_own_state"
on public.motorby_user_state
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "motorby_delete_own_state" on public.motorby_user_state;
create policy "motorby_delete_own_state"
on public.motorby_user_state
for delete
to authenticated
using ((select auth.uid()) = user_id);

comment on table public.motorby_user_state is
  'Private cross-device MOTOR.BY favorites, comparisons, notes, history, searches and preferences. RLS restricts every row to its auth user.';
