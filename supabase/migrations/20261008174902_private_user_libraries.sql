-- Private, per-account backup of the complete Anime Player library.
-- URLs and viewing data must never be readable through social profile queries.
create table if not exists public.user_library_snapshots (
  user_id uuid primary key references auth.users(id) on delete cascade,
  snapshot jsonb not null default '{"library":{"settings":{},"series":[]},"history":[],"sync":{}}'::jsonb,
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  constraint user_library_snapshots_shape check (
    jsonb_typeof(snapshot) = 'object'
    and jsonb_typeof(snapshot->'library') = 'object'
    and jsonb_typeof(snapshot->'library'->'series') = 'array'
    and jsonb_typeof(snapshot->'history') = 'array'
    and jsonb_typeof(snapshot->'sync') = 'object'
  )
);

alter table public.user_library_snapshots enable row level security;
revoke all on public.user_library_snapshots from anon, authenticated;
grant select, insert, update, delete on public.user_library_snapshots to authenticated;

drop policy if exists user_library_snapshots_select_own on public.user_library_snapshots;
create policy user_library_snapshots_select_own
  on public.user_library_snapshots for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists user_library_snapshots_insert_own on public.user_library_snapshots;
create policy user_library_snapshots_insert_own
  on public.user_library_snapshots for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists user_library_snapshots_update_own on public.user_library_snapshots;
create policy user_library_snapshots_update_own
  on public.user_library_snapshots for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists user_library_snapshots_delete_own on public.user_library_snapshots;
create policy user_library_snapshots_delete_own
  on public.user_library_snapshots for delete to authenticated
  using ((select auth.uid()) = user_id);
