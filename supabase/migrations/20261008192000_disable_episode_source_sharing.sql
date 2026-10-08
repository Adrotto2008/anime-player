-- Episode URLs are private device data. Cloud stores only the per-series link pattern.
delete from public.shared_episode_sources;
revoke all on table public.shared_episode_sources from anon, authenticated;
grant select on table public.shared_episode_sources to authenticated;
drop policy if exists shared_episode_sources_authenticated_read on public.shared_episode_sources;
drop policy if exists shared_episode_sources_own_insert on public.shared_episode_sources;
drop policy if exists shared_episode_sources_own_delete on public.shared_episode_sources;

-- Older clients may still attempt source sharing. A compatibility trigger silently discards it.
create or replace function public.discard_shared_episode_source_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  return null;
end;
$$;
revoke all on function public.discard_shared_episode_source_insert() from public, anon, authenticated;
create trigger discard_shared_episode_source_insert
before insert on public.shared_episode_sources
for each row execute function public.discard_shared_episode_source_insert();
grant insert on table public.shared_episode_sources to authenticated;
create policy shared_episode_sources_own_insert
  on public.shared_episode_sources for insert to authenticated
  with check ((select auth.uid()) = submitted_by);
