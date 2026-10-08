-- Keep full episode sources out of cloud snapshots, even when an older client syncs.
create or replace function public.strip_episode_source_urls_from_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  compact_series jsonb;
begin
  if jsonb_typeof(new.snapshot #> '{library,series}') = 'array' then
    select coalesce(jsonb_agg(
      jsonb_set(
        series - 'sourcePattern',
        '{episodes}',
        coalesce((
          select jsonb_agg(episode - 'sources' - 'sourcePattern' order by episode_order)
          from jsonb_array_elements(coalesce(series->'episodes', '[]'::jsonb)) with ordinality as items(episode, episode_order)
        ), '[]'::jsonb)
      )
      || case
        when series ? 'sourcePattern' then jsonb_build_object('sourcePattern', series->'sourcePattern')
        when tg_op = 'UPDATE' then coalesce((
          select jsonb_build_object('sourcePattern', old_series->'sourcePattern')
          from jsonb_array_elements(coalesce(old.snapshot #> '{library,series}', '[]'::jsonb)) old_series
          where old_series->>'id' = series->>'id' and old_series ? 'sourcePattern'
          limit 1
        ), '{}'::jsonb)
        else '{}'::jsonb
      end
      order by series_order
    ), '[]'::jsonb)
    into compact_series
    from jsonb_array_elements(new.snapshot #> '{library,series}') with ordinality as items(series, series_order);

    new.snapshot := jsonb_set(new.snapshot, '{library,series}', compact_series, true);
  end if;
  return new;
end;
$$;

revoke all on function public.strip_episode_source_urls_from_snapshot() from public, anon, authenticated;

drop trigger if exists strip_episode_source_urls_from_snapshot on public.user_library_snapshots;
create trigger strip_episode_source_urls_from_snapshot
before insert or update of snapshot on public.user_library_snapshots
for each row execute function public.strip_episode_source_urls_from_snapshot();

-- Sanitize existing snapshots immediately.
update public.user_library_snapshots set snapshot = snapshot where true;
