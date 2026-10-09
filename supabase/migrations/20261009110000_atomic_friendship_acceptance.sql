-- Create both friendship edges as part of the request update transaction.
-- The trigger uses a private function so clients cannot call a SECURITY DEFINER
-- RPC directly; friend_requests RLS still decides who may change request state.
-- Remove the orphan edge produced by the old two-step accept flow when a later
-- rejection overwrote the request status. Keep a pair if any request was accepted.
delete from public.friendships f
where exists (
  select 1
  from public.friend_requests r
  where r.status in ('rejected', 'cancelled')
    and ((r.sender_id = f.user_id and r.receiver_id = f.friend_id)
      or (r.sender_id = f.friend_id and r.receiver_id = f.user_id))
)
and not exists (
  select 1
  from public.friend_requests r
  where r.status = 'accepted'
    and ((r.sender_id = f.user_id and r.receiver_id = f.friend_id)
      or (r.sender_id = f.friend_id and r.receiver_id = f.user_id))
);

create or replace function private.add_friendship_edges_on_accept()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'pending' and new.status = 'accepted' then
    if (select auth.uid()) is distinct from new.receiver_id then
      raise exception 'Solo chi riceve la richiesta può accettarla.' using errcode = '42501';
    end if;

    insert into public.friendships (user_id, friend_id)
    values (new.sender_id, new.receiver_id),
           (new.receiver_id, new.sender_id)
    on conflict (user_id, friend_id) do nothing;
  end if;

  return new;
end;
$$;

revoke all on function private.add_friendship_edges_on_accept() from public, anon, authenticated;

drop trigger if exists friend_requests_create_friendship on public.friend_requests;
create trigger friend_requests_create_friendship
  after update of status on public.friend_requests
  for each row
  execute function private.add_friendship_edges_on_accept();
