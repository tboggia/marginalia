-- GENERATED FILE — DO NOT EDIT.
-- Source: social.sql (outer begin;/commit; stripped — see sync-migrations.sh) (repo root). Regenerate with supabase/sync-migrations.sh.
-- Edit the source file; this copy is overwritten on every test run.

-- social.sql — the social layer for Marginalia.
--
-- Run this AFTER schema.sql, in the Supabase SQL editor. A database created before this
-- file existed should run migration.sql instead, which contains everything here plus the
-- older catch-up steps.
--
-- What this file changes, in one paragraph: a book used to be for exactly two people, and
-- the cap was enforced in join_document. It is now for as many people as the owner shares
-- it with. Sharing is two-step — a *connection* between two accounts is the handshake, a
-- per-book *grant* is what actually shares — so taking one book back does not unfriend
-- anyone. Revoking a grant never deletes anything: the membership row stays, marked
-- revoked, which is what lets resharing pick up exactly where it left off.
--
-- The security model is unchanged in kind. Every read still routes through is_member(),
-- and the client is still never trusted to filter anything.


-- ============================================================================
-- profiles — who someone is, independent of any one book
-- ============================================================================
-- Until now a display name and color existed only inside `memberships`, per document.
-- That was enough when the only question was "what color is the other person in this
-- book", and is not enough to render a list of people you read with.
--
-- The per-book `memberships.color` stays authoritative *within* a book — two readers of
-- the same book must not share a color, and that can only be resolved per book. The
-- profile color is the preference that resolution starts from.
create table if not exists profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Reader',
  color        text not null default '#E9A13B',
  updated_at   timestamptz not null default now()
);

alter table profiles enable row level security;

-- Every account needs a profile row the moment it exists, or the first person to connect
-- with a brand-new user sees a blank in their people list.
create or replace function ensure_profile() returns trigger
  language plpgsql security definer
  set search_path = public as $$
begin
  insert into profiles (user_id, display_name)
  values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data->>'name'), ''),
      split_part(new.email, '@', 1),
      'Reader'
    )
  )
  on conflict (user_id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function ensure_profile();

-- Backfill accounts that predate the trigger.
insert into profiles (user_id, display_name)
select id, coalesce(nullif(trim(raw_user_meta_data->>'name'), ''), split_part(email, '@', 1), 'Reader')
from auth.users
on conflict (user_id) do nothing;


-- ============================================================================
-- connections — the handshake, symmetric, stored once
-- ============================================================================
-- Stored with user_a < user_b so a pair has exactly one row whichever direction it was
-- created from. Without the ordering constraint you get two rows for one relationship and
-- every query needs an OR.
create table if not exists connections (
  user_a       uuid not null references auth.users(id) on delete cascade,
  user_b       uuid not null references auth.users(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete cascade,
  status       text not null default 'accepted' check (status in ('pending', 'accepted')),
  created_at   timestamptz not null default now(),
  primary key (user_a, user_b),
  constraint ordered_pair check (user_a < user_b)
);

create index if not exists connections_user_b_idx on connections (user_b);

alter table connections enable row level security;


-- ============================================================================
-- invites — replaces the single documents.invite_code column
-- ============================================================================
-- The old design put one code on the documents row: no expiry, no per-invitee token, no
-- revocation short of rotating the only code, and no record of who used it. That was
-- survivable when the two-reader cap meant a spent link opened nothing. With the cap gone,
-- the token itself has to carry the limits.
create table if not exists invites (
  code        text primary key default encode(gen_random_bytes(8), 'hex'),
  created_by  uuid not null references auth.users(id) on delete cascade default auth.uid(),
  -- 'connect' links two accounts and shares no book. 'book' grants one book and links the
  -- accounts too, so the people list is never populated with someone you can't see.
  kind        text not null check (kind in ('connect', 'book')),
  document_id uuid references documents(id) on delete cascade,
  max_uses    int  not null default 1 check (max_uses > 0),
  uses        int  not null default 0,
  expires_at  timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  constraint book_invite_has_doc check ((kind = 'book') = (document_id is not null))
);

create index if not exists invites_created_by_idx on invites (created_by);

alter table invites enable row level security;

-- Migrate the existing per-document codes so links already sent keep working. They become
-- multi-use book invites, because that is what they were: the old cap lived in the
-- function, not the code.
--
-- Guarded on the column existing, because there are two histories to support. A database
-- built from schema.sql has invite_code; one brought forward with migration.sql never got
-- it, since that file predates invites entirely. Referencing a missing column would abort
-- the whole transaction for the second group.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'documents' and column_name = 'invite_code'
  ) then
    insert into invites (code, created_by, kind, document_id, max_uses, uses)
    select d.invite_code, d.created_by, 'book', d.id, 1000, 0
    from documents d
    where d.invite_code is not null
    on conflict (code) do nothing;

    alter table documents drop column invite_code;
  end if;
end $$;


-- ============================================================================
-- memberships — a lifecycle, so revoking is not a delete
-- ============================================================================
-- Keeping the row is the whole trick. It is what makes resharing resume rather than
-- restart, and it keeps every annotation's author resolvable after they have gone.
alter table memberships add column if not exists shared_by  uuid references auth.users(id);
-- shared_by is a record of who let you in, not a dependency on them still being here, so
-- it must not cascade — losing the person would otherwise lose the membership and every
-- mark hanging off it. A plain reference has the opposite problem: it blocks the deletion
-- of the account it points at outright. Dropping to null is the reading that matches what
-- the column means. See delete_account below.
--
-- Stated as a drop-and-add rather than on the column above, because a database that
-- already has the column got it without the rule and would never see a change there.
alter table memberships drop constraint if exists memberships_shared_by_fkey;
alter table memberships add constraint memberships_shared_by_fkey
  foreign key (shared_by) references auth.users(id) on delete set null;
alter table memberships add column if not exists revoked_at timestamptz;
-- Set at revoke time from the answer to "do your marks stay behind?". True means the
-- remaining readers keep seeing this person's highlights; false hides them from everyone
-- but their author, reversibly.
alter table memberships add column if not exists left_marks boolean not null default true;

create index if not exists memberships_active_idx
  on memberships (document_id) where revoked_at is null;


-- ============================================================================
-- annotations — reversible hiding
-- ============================================================================
-- The denormalized half of `left_marks`. This could be an RLS subquery against
-- memberships instead, and it would be correct, but it would be paid on every annotation
-- read. revoke_share sets it in bulk, share_document clears it, and the read path stays
-- the flat filter the client already uses.
alter table annotations add column if not exists hidden_at timestamptz;

create index if not exists annotations_visible_idx
  on annotations (document_id) where deleted_at is null and hidden_at is null;


-- ============================================================================
-- Helpers
-- ============================================================================
-- Revoked membership is no membership. This one line is what actually removes a revoked
-- reader's access: every other policy in schema.sql already routes through is_member, so
-- the document, its annotations, its progress and its storage object all close at once.
create or replace function is_member(doc uuid) returns boolean
  language sql security definer stable
  set search_path = public as $$
  select exists (
    select 1 from memberships m
    where m.document_id = doc
      and m.user_id = auth.uid()
      and m.revoked_at is null
  )
$$;

create or replace function are_connected(other uuid) returns boolean
  language sql security definer stable
  set search_path = public as $$
  select exists (
    select 1 from connections c
    where c.status = 'accepted'
      and c.user_a = least(auth.uid(), other)
      and c.user_b = greatest(auth.uid(), other)
  )
$$;

-- Used only by read_profiles: you can see the name of someone you are in a book with even
-- if the connection itself was later removed, because their name is already on their
-- highlights in front of you.
create or replace function shares_a_book(other uuid) returns boolean
  language sql security definer stable
  set search_path = public as $$
  select exists (
    select 1
    from memberships mine
    join memberships theirs on theirs.document_id = mine.document_id
    where mine.user_id = auth.uid() and mine.revoked_at is null
      and theirs.user_id = other and theirs.revoked_at is null
  )
$$;

-- A reader's color has to be unique inside a book, and the palette is the six values in
-- app.js COLORS. Start from what they asked for, fall back to the first free one, and if
-- a book somehow holds more than six readers, let it repeat rather than fail the join.
create or replace function pick_color(doc uuid, preferred text) returns text
  language plpgsql security definer stable
  set search_path = public as $$
declare
  palette text[] := array['#E9A13B', '#3FBFC9', '#E87CB0', '#9E90EA', '#7FBF3F', '#EE7F5C'];
  taken   text[];
  c       text;
begin
  select coalesce(array_agg(color), '{}') into taken
  from memberships where document_id = doc and revoked_at is null;

  if preferred is not null and not (preferred = any(taken)) then
    return preferred;
  end if;

  foreach c in array palette loop
    if not (c = any(taken)) then return c; end if;
  end loop;

  return coalesce(preferred, palette[1]);
end $$;


-- ============================================================================
-- RLS
-- ============================================================================
drop policy if exists read_profiles on profiles;
create policy read_profiles on profiles for select
  using (user_id = auth.uid() or are_connected(user_id) or shares_a_book(user_id));

drop policy if exists write_own_profile on profiles;
create policy write_own_profile on profiles for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Connections are only ever created by redeem_invite, which is security definer. There is
-- deliberately no insert policy: a client that could insert its own connection row could
-- attach itself to any account it knew the id of.
drop policy if exists read_connections on connections;
create policy read_connections on connections for select
  using (user_a = auth.uid() or user_b = auth.uid());

drop policy if exists delete_own_connection on connections;
create policy delete_own_connection on connections for delete
  using (user_a = auth.uid() or user_b = auth.uid());

-- You can see and manage the invites you made. You can never read one by code — that is
-- what redeem_invite is for, and it is the only way across the gap.
--
-- The document check is what keeps "only the owner decides who reads this" true. Without
-- it, adding a reader is owner-only through share_document but wide open through a link:
-- any member could mint a book invite and let in whoever they liked.
drop policy if exists manage_own_invites on invites;
create policy manage_own_invites on invites for all
  using (created_by = auth.uid())
  with check (
    created_by = auth.uid()
    and (
      document_id is null
      or exists (select 1 from documents d
                 where d.id = document_id and d.created_by = auth.uid())
    )
  );

-- Hide the marks of a reader who left and took them with them. Their own rows stay
-- visible to them, which is what makes the hiding reversible rather than destructive.
drop policy if exists read_annotations on annotations;
create policy read_annotations on annotations for select
  using (is_member(document_id) and (hidden_at is null or user_id = auth.uid()));

-- Deleting a book used to be `is_member(id)` — any of the two readers could destroy it and
-- cascade the other's annotations. That was a defensible symmetry for a pair and is not
-- one for a group. Only the owner can delete; everyone else leaves, which the existing
-- write_own_membership policy already permits.
drop policy if exists delete_documents on documents;
create policy delete_documents on documents for delete using (created_by = auth.uid());

-- Storage deletion has to follow the same rule, or a non-owner could strip the file out
-- from under a book they merely read.
drop policy if exists delete_books on storage.objects;
create policy delete_books on storage.objects for delete
  using (
    bucket_id = 'books'
    and exists (
      select 1 from documents d
      where d.storage_path = storage.objects.name and d.created_by = auth.uid()
    )
  );


-- ============================================================================
-- Invites: creation and redemption
-- ============================================================================
-- Replaces join_document. Redemption can't be a plain insert for the same reason as
-- before: you cannot see a document you are not yet in, so you could never name its id.
-- The function reads with policies suspended, which is exactly why it takes a code.
-- The output columns are named invite_kind/doc_id rather than kind/document_id because a
-- RETURNS TABLE column name is in scope inside the body and would collide with the
-- invites columns of the same name.
create or replace function redeem_invite(code text, name text default null)
  returns table (invite_kind text, doc_id uuid)
  language plpgsql security definer
  set search_path = public as $$
declare
  inv       invites%rowtype;
  me        uuid := auth.uid();
  my_color  text;
begin
  select * into inv from invites i where i.code = redeem_invite.code;

  if inv.code is null then
    raise exception 'That invite link is not valid.' using errcode = '22023';
  end if;
  if inv.revoked_at is not null then
    raise exception 'That invite link has been turned off.' using errcode = '22023';
  end if;
  if inv.expires_at is not null and inv.expires_at < now() then
    raise exception 'That invite link has expired.' using errcode = '22023';
  end if;
  if inv.created_by = me then
    raise exception 'That is your own invite link.' using errcode = '22023';
  end if;

  -- Being removed from a book sticks. Without this, anyone the owner revoked could click
  -- an old link and put themselves straight back in — the membership row survives a
  -- revoke by design, and the upsert below would clear revoked_at. Getting back in has to
  -- be an act by the owner (share_document), never something the removed reader can do.
  if inv.kind = 'book' and exists (
    select 1 from memberships m
    where m.document_id = inv.document_id and m.user_id = me and m.revoked_at is not null)
  then
    raise exception 'You were removed from this book. Ask whoever added it to share it again.'
      using errcode = '42501';
  end if;

  -- Spend a use only for someone who isn't already in. A re-clicked link has to stay
  -- harmless, which it was before and still needs to be. `revoked_at is null` matters:
  -- a revoked row is not "already in", and treating it as such would hand out a free
  -- redemption on a spent link.
  if inv.uses >= inv.max_uses
     and not (inv.kind = 'book' and exists (
       select 1 from memberships m
       where m.document_id = inv.document_id and m.user_id = me and m.revoked_at is null))
     and not (inv.kind = 'connect' and exists (
       select 1 from connections c
       where c.user_a = least(me, inv.created_by) and c.user_b = greatest(me, inv.created_by)))
  then
    raise exception 'That invite link has already been used.' using errcode = '22023';
  end if;

  if name is not null and trim(name) <> '' then
    update profiles set display_name = trim(name), updated_at = now()
    where user_id = me and display_name = 'Reader';
  end if;

  -- Both kinds connect the two accounts. A book invite that didn't would leave you
  -- reading alongside somebody your people list can't name.
  insert into connections (user_a, user_b, requested_by, status)
  values (least(me, inv.created_by), greatest(me, inv.created_by), inv.created_by, 'accepted')
  on conflict (user_a, user_b) do update set status = 'accepted';

  if inv.kind = 'book' then
    select p.color into my_color from profiles p where p.user_id = me;

    insert into memberships (document_id, user_id, display_name, color, shared_by)
    values (
      inv.document_id,
      me,
      coalesce((select display_name from profiles where user_id = me), 'Reader'),
      pick_color(inv.document_id, my_color),
      inv.created_by
    )
    on conflict (document_id, user_id) do update
      set revoked_at = null, shared_by = inv.created_by;

    -- Rejoining restores anything they had hidden on the way out.
    update annotations a set hidden_at = null
    where a.document_id = inv.document_id and a.user_id = me and a.hidden_at is not null;
  end if;

  update invites i set uses = i.uses + 1 where i.code = redeem_invite.code;

  return query select inv.kind, inv.document_id;
end $$;

revoke all on function redeem_invite(text, text) from public, anon;
grant execute on function redeem_invite(text, text) to authenticated;

-- join_document is gone. Anything still calling it should call redeem_invite.
drop function if exists join_document(text, text);


-- ============================================================================
-- Sharing and revoking
-- ============================================================================
-- Granting straight to a connected account, no link round trip. Requires an existing
-- connection: this is the "connecting is the handshake, the grant is the share" rule, and
-- it is the reason a client cannot hand a book to an arbitrary user id.
create or replace function share_document(doc uuid, target uuid)
  returns void
  language plpgsql security definer
  set search_path = public as $$
declare
  target_color text;
begin
  -- Owner-only, matching delete_documents and the invites policy. Any member being able
  -- to add readers would make "who can see this book" something no single person
  -- controls, and it would contradict what the share sheet tells non-owners.
  if (select created_by from documents where id = doc) <> auth.uid() then
    raise exception 'Only the person who added this book can share it.' using errcode = '42501';
  end if;
  if not are_connected(target) then
    raise exception 'You are not connected to that person.' using errcode = '42501';
  end if;

  select color into target_color from profiles where user_id = target;

  insert into memberships (document_id, user_id, display_name, color, shared_by)
  values (
    doc,
    target,
    coalesce((select display_name from profiles where user_id = target), 'Reader'),
    pick_color(doc, target_color),
    auth.uid()
  )
  on conflict (document_id, user_id) do update
    set revoked_at = null, shared_by = auth.uid();

  -- Resharing resumes: whatever they hid on the way out comes back, along with anything
  -- they wrote while they were away.
  update annotations a set hidden_at = null
  where a.document_id = doc and a.user_id = target and a.hidden_at is not null;
end $$;

revoke all on function share_document(uuid, uuid) from public, anon;
grant execute on function share_document(uuid, uuid) to authenticated;

-- Never deletes. The membership row is marked, not removed, and the annotations are
-- hidden at most. `leave_marks` answers "do this reader's highlights stay visible to
-- everyone else" — chosen by whoever is ending the share, which is the owner when they
-- revoke someone and the reader themselves when they leave.
create or replace function revoke_share(doc uuid, target uuid, leave_marks boolean default true)
  returns void
  language plpgsql security definer
  set search_path = public as $$
declare
  owner uuid;
begin
  select created_by into owner from documents where id = doc;
  if owner is null then
    raise exception 'No such book.' using errcode = '22023';
  end if;
  -- The owner can remove anyone; anyone can remove themselves.
  if auth.uid() <> owner and auth.uid() <> target then
    raise exception 'Only the owner can remove another reader.' using errcode = '42501';
  end if;
  if target = owner then
    raise exception 'The owner cannot be removed from their own book.' using errcode = '42501';
  end if;

  update memberships m
     set revoked_at = now(), left_marks = leave_marks
   where m.document_id = doc and m.user_id = target;

  if leave_marks then
    update annotations a set hidden_at = null
    where a.document_id = doc and a.user_id = target and a.hidden_at is not null;
  else
    update annotations a set hidden_at = now()
    where a.document_id = doc and a.user_id = target and a.hidden_at is null;
  end if;
end $$;

revoke all on function revoke_share(uuid, uuid, boolean) from public, anon;
grant execute on function revoke_share(uuid, uuid, boolean) to authenticated;

-- Who is (or was) in this book. Returns revoked rows too, so the share sheet can offer to
-- put someone back without re-inviting them.
create or replace function list_shares(doc uuid)
  returns table (user_id uuid, name text, color text, revoked_at timestamptz,
                 left_marks boolean, is_owner boolean)
  language sql security definer stable
  set search_path = public as $$
  select m.user_id,
         coalesce(p.display_name, m.display_name),
         m.color,
         m.revoked_at,
         m.left_marks,
         (m.user_id = d.created_by)
  from memberships m
  join documents d on d.id = m.document_id
  left join profiles p on p.user_id = m.user_id
  where m.document_id = doc and is_member(doc)
  order by (m.user_id = d.created_by) desc, m.joined_at
$$;

revoke all on function list_shares(uuid) from public, anon;
grant execute on function list_shares(uuid) to authenticated;

-- The people list: everyone you are connected to, and how many books you actually share.
create or replace function list_connections()
  returns table (user_id uuid, name text, color text, status text, book_count bigint)
  language sql security definer stable
  set search_path = public as $$
  with peers as (
    select case when c.user_a = auth.uid() then c.user_b else c.user_a end as peer, c.status
    from connections c
    where c.user_a = auth.uid() or c.user_b = auth.uid()
  )
  select peers.peer,
         coalesce(p.display_name, 'Reader'),
         coalesce(p.color, '#E9A13B'),
         peers.status,
         (select count(*)
            from memberships mine
            join memberships theirs on theirs.document_id = mine.document_id
           where mine.user_id = auth.uid() and mine.revoked_at is null
             and theirs.user_id = peers.peer and theirs.revoked_at is null)
  from peers
  left join profiles p on p.user_id = peers.peer
  order by 5 desc, 2
$$;

revoke all on function list_connections() from public, anon;
grant execute on function list_connections() to authenticated;


-- ============================================================================
-- Duplicate detection and merge
-- ============================================================================
-- Two people who each uploaded the same book have two documents rows and no way to read
-- each other's marks. Merging fixes that, and is only ever safe when the files are
-- byte-identical: every stored anchor — pdf rects, pdf text-item indexes, epub CFIs — is a
-- property of one particular file. A different scan of the same book is a different book
-- here, and the honest answer is to say so rather than move highlights onto the wrong words.
create or replace function find_duplicate(doc uuid, target uuid)
  returns uuid
  language sql security definer stable
  set search_path = public as $$
  select d2.id
  from documents d1
  join documents d2 on d2.sha256 = d1.sha256 and d2.id <> d1.id
  join memberships m on m.document_id = d2.id and m.user_id = target and m.revoked_at is null
  where d1.id = doc and is_member(doc)
  limit 1
$$;

revoke all on function find_duplicate(uuid, uuid) from public, anon;
grant execute on function find_duplicate(uuid, uuid) to authenticated;

-- The other side of the same question, and the one that drives the UI: books you hold
-- twice, because you added your own copy and were later shared someone else's of the
-- same file. Only pairs you can actually act on are returned — `mine` is always a copy
-- you created, which is the only kind merge_documents will let you give up.
create or replace function find_my_duplicates()
  returns table (mine uuid, mine_title text, theirs uuid, theirs_title text, owner_name text)
  language sql security definer stable
  set search_path = public as $$
  select d1.id, d1.title, d2.id, d2.title, coalesce(p.display_name, 'Someone')
  from memberships m1
  join documents d1   on d1.id = m1.document_id
  join memberships m2 on m2.user_id = auth.uid() and m2.revoked_at is null
  join documents d2   on d2.id = m2.document_id
  left join profiles p on p.user_id = d2.created_by
  where m1.user_id = auth.uid() and m1.revoked_at is null
    and d1.created_by =  auth.uid()
    and d2.created_by <> auth.uid()
    and d1.sha256 = d2.sha256
  order by d1.title
$$;

revoke all on function find_my_duplicates() from public, anon;
grant execute on function find_my_duplicates() to authenticated;

-- Returns the storage path of the dropped document so the caller can remove the object
-- through the storage API. Deleting the storage.objects row here would drop the record and
-- orphan the file itself.
-- Who may call this, and why it is narrower than it looks:
--
-- The merge is always performed by the person giving up their copy, never by the person
-- whose copy survives. That falls out of two facts. You cannot see a document you are not
-- a member of, so the sharer can't name the other copy's id — only the person who now
-- holds both can. And because this function is security definer it bypasses the
-- owner-only delete policy, so without the created_by check below, a reader who was
-- shared into your book could pass keep=<their copy>, drop=<yours> and delete a book they
-- do not own. You may only ever drop a copy you created.
create or replace function merge_documents(keep uuid, drop_id uuid)
  returns text
  language plpgsql security definer
  set search_path = public as $$
declare
  keep_hash  text;
  drop_hash  text;
  drop_path  text;
  keep_path  text;
  drop_owner uuid;
  m          record;
begin
  select sha256, storage_path into keep_hash, keep_path from documents where id = keep;
  select sha256, storage_path, created_by into drop_hash, drop_path, drop_owner
  from documents where id = drop_id;

  if keep_hash is null or drop_hash is null then
    raise exception 'No such book.' using errcode = '22023';
  end if;
  if keep = drop_id then
    raise exception 'That is the same book.' using errcode = '22023';
  end if;
  if keep_hash <> drop_hash then
    raise exception 'Those are different files. Merging them would put every highlight in the wrong place.'
      using errcode = '22023';
  end if;
  if not is_member(keep) or not is_member(drop_id) then
    raise exception 'Not your book.' using errcode = '42501';
  end if;
  if drop_owner <> auth.uid() then
    raise exception 'You can only merge your own copy into someone else''s.' using errcode = '42501';
  end if;

  -- Members first, so the annotations that follow land inside a document their authors
  -- can still read. One at a time rather than an insert-select: pick_color reads the
  -- memberships of `keep`, and rows inserted by a single statement aren't visible to it,
  -- so a set-based insert could hand two arriving readers the same color.
  for m in
    select user_id, display_name, color from memberships
    where document_id = drop_id and revoked_at is null
  loop
    insert into memberships (document_id, user_id, display_name, color, shared_by)
    values (keep, m.user_id, m.display_name, pick_color(keep, m.color), auth.uid())
    on conflict (document_id, user_id) do nothing;
  end loop;

  update annotations set document_id = keep where document_id = drop_id;

  -- Progress is one row per person per book, so a person present in both keeps whichever
  -- place they reached most recently.
  insert into progress (document_id, user_id, page, y_frac, cfi, percent, updated_at)
  select keep, p.user_id, p.page, p.y_frac, p.cfi, p.percent, p.updated_at
  from progress p where p.document_id = drop_id
  on conflict (document_id, user_id) do update
    set page = excluded.page, y_frac = excluded.y_frac, cfi = excluded.cfi,
        percent = excluded.percent, updated_at = excluded.updated_at
    where progress.updated_at < excluded.updated_at;

  delete from documents where id = drop_id;

  -- Null tells the caller to leave the bucket alone. The two copies can only share a
  -- path if they were uploaded by the same account (the path is uid/hash.ext), which
  -- putDocument's dedupe already prevents — but deleting that object would strip the
  -- file out from under the copy we just kept, so it is worth being sure.
  if drop_path = keep_path then return null; end if;
  return drop_path;
end $$;

revoke all on function merge_documents(uuid, uuid) from public, anon;
grant execute on function merge_documents(uuid, uuid) to authenticated;


-- ============================================================================
-- rotate_invite, generalized
-- ============================================================================
-- Turning off a link no longer means rotating the only code a book has. Revoking one
-- invite leaves every other link to that book working, and kicks nobody out.
drop function if exists rotate_invite(uuid);

create or replace function revoke_invite(invite_code text)
  returns void
  language plpgsql security definer
  set search_path = public as $$
begin
  update invites set revoked_at = now()
  where code = invite_code and created_by = auth.uid() and revoked_at is null;
  if not found then
    raise exception 'No such invite.' using errcode = '22023';
  end if;
end $$;

revoke all on function revoke_invite(text) from public, anon;
grant execute on function revoke_invite(text) to authenticated;


-- ============================================================================
-- Deleting an account
-- ============================================================================
-- The one hard delete in the app. Everything else here is reversible on purpose — a
-- revoke marks a membership rather than removing it, a removed highlight tombstones
-- rather than vanishes — because everything else is about one book and can be undone by
-- sharing it again. This is not: the account is the thing being removed, so keeping a
-- reversible shadow of it would be keeping the account.
--
-- What goes: the profile, every connection, every invite they minted, and every
-- highlight, note and reading position they wrote — in every book, including books they
-- were only ever a reader of. None of that is listed below, because all of it hangs off
-- an `on delete cascade` to auth.users. The function only handles what does *not*
-- cascade, and its last statement is what sets the rest going.
--
-- What stays: books they added that someone else is still reading. Taking those would
-- delete other people's marks, which is the one thing leaving is not allowed to do.
-- documents.created_by deliberately has no cascade — a book losing its owner silently is
-- worse than a delete that refuses — so ownership is handed over first, to whoever joined
-- earliest. Not to nobody: every owner check in this file (share_document, revoke_share,
-- delete_documents, delete_books, manage_own_invites) reads created_by, and a null there
-- is a book that can never be shared, deleted, or even left.
--
-- Storage is not touched here. Deleting a storage.objects row drops the record and
-- orphans the file itself, same as in merge_documents — the caller removes the objects
-- through the storage API first, using account_deletion_plan below, while the documents
-- rows that authorize that removal still exist.

-- What deleting your account would do to each book you added, and the paths the client
-- has to clear out of the bucket before calling delete_account. Split the same way the
-- function splits it, but the function re-derives its own answer rather than taking this
-- one back as a parameter: the client is not trusted to decide which books get deleted.
create or replace function account_deletion_plan()
  returns table (document_id uuid, title text, storage_path text, action text)
  language sql security definer stable
  set search_path = public as $$
  select d.id, d.title, d.storage_path,
         case
           when exists (
             select 1 from memberships m
             where m.document_id = d.id
               and m.user_id <> auth.uid()
               and m.revoked_at is null
           ) then 'handover'
           else 'delete'
         end
  from documents d
  where d.created_by = auth.uid()
  order by d.title
$$;

revoke all on function account_deletion_plan() from public, anon;
grant execute on function account_deletion_plan() to authenticated;

-- delete_account runs as this function's owner — `postgres`, both in the SQL editor and
-- in the CLI's migration runner — and auth.users belongs to supabase_auth_admin. Locally
-- postgres is a superuser and this grant is a formality; on a hosted project it is what
-- makes the last line of the function possible at all. Wrapped because a role that cannot
-- issue the grant also has no way of being told that it couldn't.
do $$
begin
  execute 'grant delete on table auth.users to postgres';
exception when others then
  raise notice 'social.sql: could not grant delete on auth.users to postgres (%). delete_account() will fail with a permissions error until someone who can runs that grant.', sqlerrm;
end $$;

-- Takes no arguments, and that is the security model. There is no account id to pass and
-- therefore none to tamper with: it deletes auth.uid() and nothing else, so the worst a
-- hostile client can do with it is delete itself.
create or replace function delete_account() returns void
  language plpgsql security definer
  set search_path = public as $$
declare
  me   uuid := auth.uid();
  heir uuid;
  d    record;
begin
  if me is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  for d in select id from documents where created_by = me loop
    -- Earliest joiner, with the id as a tiebreak so a book whose readers arrived in the
    -- same transaction still hands over deterministically. Revoked readers are not
    -- candidates: they cannot see the book, and handing it to them would let them back in.
    select m.user_id into heir
    from memberships m
    where m.document_id = d.id and m.user_id <> me and m.revoked_at is null
    order by m.joined_at, m.user_id
    limit 1;

    if heir is null then
      -- Nobody else is reading it. Cascades to its memberships, progress, annotations
      -- and invites; the bucket object is the caller's to remove, and already gone by
      -- the time this runs if they followed account_deletion_plan.
      delete from documents where id = d.id;
    else
      update documents set created_by = heir where id = d.id;
    end if;
  end loop;

  -- storage.objects.owner references auth.users in some versions of the storage schema
  -- and not others, without a cascade where it does — one row pointing at this account
  -- is enough to block the delete below. This clears the attribution, not the object:
  -- the bytes now belong to whoever the book was handed to. Guarded on the column
  -- existing, the same way the invite_code migration near the top of this file is, and
  -- on the privilege, because the storage schema is not this function owner's to write.
  begin
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'storage' and table_name = 'objects' and column_name = 'owner'
    ) then
      execute 'update storage.objects set owner = null where owner = $1' using me;
    end if;
  exception when others then
    raise notice 'delete_account: could not clear storage ownership (%). If auth.users has a foreign key from storage.objects.owner, the delete below will fail.', sqlerrm;
  end;

  -- Everything else in the paragraph at the top of this section happens here, by cascade.
  delete from auth.users where id = me;
end $$;

revoke all on function delete_account() from public, anon;
grant execute on function delete_account() to authenticated;


-- ============================================================================
-- Grants
-- ============================================================================
-- See the long note in schema.sql: a policy decides which rows a role sees, but
-- the role needs the table privilege before any policy is consulted, and
-- Supabase's default privileges no longer supply it. The three tables this file
-- adds need the same treatment as the four in schema.sql.
--
-- schema.sql's four are re-granted here too. Not redundancy — this file is also
-- the forward migration for a database that was built before the grants were
-- written down, and that database has policies on documents/annotations that no
-- client can currently get past. Granting is idempotent, so it costs a
-- re-running database nothing.
grant select, insert, update, delete
  on profiles, connections, invites,
     documents, memberships, progress, annotations
  to authenticated;


-- ============================================================================
-- Realtime
-- ============================================================================
-- Wrapped because ALTER PUBLICATION ... ADD TABLE errors if the table is already a
-- member, and this file has to stay safe to re-run.
do $$
begin
  alter publication supabase_realtime add table connections;
exception when duplicate_object then null;
end $$;

-- memberships was already in the publication but had no replica identity. Realtime only
-- applies RLS to a table when this is set, so until now every subscriber was receiving
-- every membership row in the table regardless of policy. This is a fix, not a new
-- requirement — see the note at schema.sql:172.
alter table memberships  replica identity full;
alter table connections  replica identity full;

