-- Either participant may remove their own friendship row.
drop policy if exists friendships_delete on public.friendships;
create policy friendships_delete
  on public.friendships for delete to authenticated
  using ((select auth.uid()) = user_id or (select auth.uid()) = friend_id);
