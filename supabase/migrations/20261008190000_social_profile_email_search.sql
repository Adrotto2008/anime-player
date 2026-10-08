-- Search by exact account email without exposing auth emails through profiles.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create or replace function private.search_profiles_by_email(search_email text)
returns table(id uuid, username text, display_name text, avatar_url text, bio text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.username, p.display_name, p.avatar_url, p.bio
  from auth.users u
  join public.profiles p on p.id = u.id
  where (select auth.uid()) is not null
    and lower(u.email) = lower(trim(search_email))
  limit 1;
$$;

revoke all on function private.search_profiles_by_email(text) from public, anon;
grant execute on function private.search_profiles_by_email(text) to authenticated;

-- PostgREST-exposed invoker wrapper; email table access remains inside the private function.
create or replace function public.search_profiles_by_email(search_email text)
returns table(id uuid, username text, display_name text, avatar_url text, bio text)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.search_profiles_by_email(search_email);
$$;
revoke all on function public.search_profiles_by_email(text) from public, anon;
grant execute on function public.search_profiles_by_email(text) to authenticated;

create unique index if not exists profiles_username_unique_lower_idx
  on public.profiles (lower(btrim(username)))
  where username is not null and btrim(username) <> '';
