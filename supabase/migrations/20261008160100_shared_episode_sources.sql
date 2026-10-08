create table if not exists public.shared_episode_sources (
  id uuid primary key default gen_random_uuid(),
  external_id text not null,
  season_number integer not null check (season_number >= 1),
  episode_number integer not null check (episode_number >= 0),
  source_url text not null check (length(source_url) <= 2048 and source_url ~* '^https?://'),
  submitted_by uuid not null references auth.users(id) on delete cascade,
  verified_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint shared_episode_sources_identity_url_key unique (external_id, season_number, episode_number, source_url)
);

create index if not exists shared_episode_sources_lookup_idx
  on public.shared_episode_sources (external_id, season_number, episode_number);

alter table public.shared_episode_sources enable row level security;
revoke all on public.shared_episode_sources from anon, authenticated;
grant select, insert, delete on public.shared_episode_sources to authenticated;

drop policy if exists shared_episode_sources_authenticated_read on public.shared_episode_sources;
create policy shared_episode_sources_authenticated_read
  on public.shared_episode_sources for select to authenticated
  using (true);

drop policy if exists shared_episode_sources_own_insert on public.shared_episode_sources;
create policy shared_episode_sources_own_insert
  on public.shared_episode_sources for insert to authenticated
  with check ((select auth.uid()) = submitted_by);

drop policy if exists shared_episode_sources_own_delete on public.shared_episode_sources;
create policy shared_episode_sources_own_delete
  on public.shared_episode_sources for delete to authenticated
  using ((select auth.uid()) = submitted_by);
