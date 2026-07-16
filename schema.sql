-- Marginalia — Postgres schema for Supabase.
-- Run in the SQL editor. Then create a PRIVATE storage bucket named "books".
--
-- The security model is entirely RLS. The client is assumed to be hostile and is
-- never trusted to filter anything. Two rules, applied to every table:
--   read  -> rows belonging to a document you are a member of
--   write -> only rows where user_id = auth.uid()

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- documents
create table documents (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  storage_path text not null,
  page_count   int  not null default 0,
  format       text not null default 'pdf' check (format in ('pdf', 'epub')),
  -- Cache of epub.js's book.locations.save() — the character-index walk that backs
  -- percentageFromCfi/cfiFromPercentage is a full-book pass, worth avoiding on every open.
  epub_locations jsonb,
  -- If someone re-uploads a different scan of the same book, every stored anchor is
  -- now pointing at the wrong words. Compare this on load and refuse rather than
  -- render 400 highlights in the wrong places.
  sha256       text not null,
  created_by   uuid not null references auth.users(id) default auth.uid(),
  created_at   timestamptz not null default now()
);

-- -------------------------------------------------------------- memberships
create table memberships (
  document_id  uuid not null references documents(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  display_name text not null,
  color        text not null default '#E9A13B',
  joined_at    timestamptz not null default now(),
  primary key (document_id, user_id)
);

create index on memberships (user_id);

-- ----------------------------------------------------------------- progress
-- One row per person per book. This is the entire "keep my place" feature.
-- PDF locates with page+y_frac; EPUB has no fixed page, so it locates with a CFI
-- instead. `percent` is populated by both formats and is what the spine rail and
-- "how far apart are we" comparisons actually read — see annotations.percent below.
create table progress (
  document_id uuid not null references documents(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  page        int,
  y_frac      real check (y_frac is null or (y_frac >= 0 and y_frac <= 1)),
  cfi         text,
  percent     real not null default 0 check (percent >= 0 and percent <= 1),
  updated_at  timestamptz not null default now(),
  primary key (document_id, user_id),
  constraint page_check check (page is null or page > 0),
  constraint progress_locator_matches check (
    (page is not null and cfi is null) or (page is null and cfi is not null)
  )
);

-- -------------------------------------------------------------- annotations
-- One table for highlights, notes, and ink. The read pattern is always
-- "everything on page N", and joining three tables for two users is ceremony.
-- EPUB rows have no page_number (there is no fixed page); they group by spine_index
-- instead (the chapter/spine-item they belong to — the same coarse role page_number
-- plays for PDF) and anchor precisely with a cfi rather than rects+text_anchor. Ink is
-- PDF-only: reflowable text has no fixed geometry for a stroke to stay put against, so
-- no epub annotation ever has type 'ink'. See README "known gaps".
create table annotations (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade default auth.uid(),
  page_number int,
  spine_index int,
  type        text not null check (type in ('highlight', 'ink')),
  color       text not null,
  -- All geometry is normalized to [0,1] against the unrotated page at scale 1.
  -- No pixel value is ever stored. See PLAN.md §2. EPUB highlights carry no stored
  -- rects at all — they're recomputed live from the cfi at render time, since a
  -- chapter's layout (and therefore any pre-stored rect) changes with font size.
  rects       jsonb,        -- highlight (pdf): [{x,y,w,h}]
  strokes     jsonb,        -- ink (pdf only): [{color,width,points:[[x,y,pressure]]}]
  text        text,         -- the quoted sentence, for search and export
  text_anchor jsonb,        -- pdf: {itemStart,offsetStart,itemEnd,offsetEnd}
  cfi         text,         -- epub: the anchor itself, not a repair channel
  percent     real,         -- shared spine-rail position, both formats populate it
  note        text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Soft delete: undo is a column write, and the realtime feed can carry removals.
  deleted_at  timestamptz,
  constraint page_number_check check (page_number is null or page_number > 0),
  constraint unit_present check (page_number is not null or spine_index is not null),
  constraint shape_matches_type check (
    (type = 'highlight' and (rects is not null or cfi is not null)) or
    (type = 'ink' and strokes is not null)
  )
);

create index on annotations (document_id, page_number) where deleted_at is null;
create index on annotations (document_id, spine_index) where deleted_at is null;
create index on annotations (document_id, updated_at);

create or replace function touch_updated_at() returns trigger
  language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger annotations_touch before update on annotations
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------- RLS
alter table documents   enable row level security;
alter table memberships enable row level security;
alter table progress    enable row level security;
alter table annotations enable row level security;

-- A security definer function, because a membership policy that queries memberships
-- recurses forever. This is the standard Supabase escape hatch for the pattern.
create or replace function is_member(doc uuid) returns boolean
  language sql security definer stable
  set search_path = public as $$
  select exists (
    select 1 from memberships m
    where m.document_id = doc and m.user_id = auth.uid()
  )
$$;

create policy read_documents on documents for select using (is_member(id));
create policy create_documents on documents for insert with check (created_by = auth.uid());

create policy read_members on memberships for select using (is_member(document_id));
-- You may only ever write your own membership row. Invites are handled by a separate
-- token flow, not by letting clients insert rows for other people.
create policy write_own_membership on memberships for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy read_progress on progress for select using (is_member(document_id));
create policy write_own_progress on progress for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and is_member(document_id));

create policy read_annotations on annotations for select using (is_member(document_id));
create policy write_own_annotations on annotations for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and is_member(document_id));

-- ----------------------------------------------------------------- realtime
alter publication supabase_realtime add table annotations;
alter publication supabase_realtime add table progress;
alter publication supabase_realtime add table memberships;

-- Realtime respects RLS only when this is set. Without it, the socket leaks every
-- row in the table to every subscriber, and the policies above are decoration.
alter table annotations replica identity full;
alter table progress    replica identity full;

-- -------------------------------------------------------------- storage RLS
-- Run after creating the private "books" bucket.
create policy read_books on storage.objects for select
  using (
    bucket_id = 'books'
    and exists (
      select 1 from documents d
      where d.storage_path = storage.objects.name and is_member(d.id)
    )
  );

create policy upload_books on storage.objects for insert
  with check (bucket_id = 'books' and owner = auth.uid());


-- ============================================================================
-- Invites — "usable by someone with the right URL"
-- ============================================================================
-- 8 random bytes = 64 bits of code. Hex so it survives a URL, an iMessage, and
-- being read aloud over the phone.
alter table documents
  add column invite_code text unique not null default encode(gen_random_bytes(8), 'hex');

-- Joining can't be a plain insert: write_own_membership lets you insert your own
-- row, but read_documents means you can't see a document you're not yet in, so you
-- could never find its id. A security definer function is the only way across that
-- gap — it reads documents with the policies suspended, which is exactly why it must
-- take a code rather than an id, and must be the only such function.
create or replace function join_document(code text, name text default 'Reader')
  returns uuid
  language plpgsql security definer
  set search_path = public as $$
declare
  doc_id uuid;
  readers int;
begin
  select id into doc_id from documents where invite_code = code;
  if doc_id is null then
    raise exception 'That invite link is not valid.' using errcode = '22023';
  end if;

  -- Already in? Idempotent, so a re-clicked link is harmless.
  if exists (select 1 from memberships m
             where m.document_id = doc_id and m.user_id = auth.uid()) then
    return doc_id;
  end if;

  -- A book is for two people. The cap is what makes a leaked link stop mattering
  -- the moment the second reader is in: after that, the link opens nothing.
  select count(*) into readers from memberships where document_id = doc_id;
  if readers >= 2 then
    raise exception 'This book already has two readers.' using errcode = '22023';
  end if;

  insert into memberships (document_id, user_id, display_name, color)
  values (doc_id, auth.uid(), coalesce(nullif(trim(name), ''), 'Reader'), '#3FBFC9');

  return doc_id;
end $$;

revoke all on function join_document(text, text) from public, anon;
grant execute on function join_document(text, text) to authenticated;

-- Rotating the code kicks nobody out; it only stops future joins.
create or replace function rotate_invite(doc uuid) returns text
  language plpgsql security definer
  set search_path = public as $$
declare code text;
begin
  if not is_member(doc) then
    raise exception 'Not your book.' using errcode = '42501';
  end if;
  code := encode(gen_random_bytes(8), 'hex');
  update documents set invite_code = code where id = doc;
  return code;
end $$;

revoke all on function rotate_invite(uuid) from public, anon;
grant execute on function rotate_invite(uuid) to authenticated;
