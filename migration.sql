-- migration.sql — bring an existing (pre-EPUB) Marginalia database up to the current
-- schema.sql. Run this ONCE in the Supabase SQL editor on a database that was created
-- from the older, PDF-only schema. A brand-new database should just run schema.sql and
-- skip this file.
--
-- Everything here is additive or relaxing, and written to be safe to re-run: new columns
-- use `if not exists`, constraints are dropped `if exists` before being re-added. No data
-- is dropped. Existing PDF rows keep working unchanged (they get format='pdf' and their
-- page-based locators satisfy every new constraint).

begin;

-- ---------------------------------------------------------------- documents
alter table documents add column if not exists
  format text not null default 'pdf' check (format in ('pdf', 'epub'));
alter table documents add column if not exists epub_locations jsonb;

-- ----------------------------------------------------------------- progress
-- EPUB has no fixed page, so page/y_frac must be allowed to be null and a cfi carries
-- the position instead. `percent` is what the spine rail reads for both formats.
alter table progress alter column page drop not null;
alter table progress alter column y_frac drop not null;
alter table progress add column if not exists cfi text;
alter table progress add column if not exists
  percent real not null default 0 check (percent >= 0 and percent <= 1);
alter table progress drop constraint if exists progress_locator_matches;
alter table progress add constraint progress_locator_matches check (
  (page is not null and cfi is null) or (page is null and cfi is not null)
);

-- -------------------------------------------------------------- annotations
alter table annotations alter column page_number drop not null;
alter table annotations add column if not exists spine_index int;
alter table annotations add column if not exists cfi text;
alter table annotations add column if not exists percent real;

-- The old constraint required every highlight to have rects. EPUB highlights carry a
-- cfi and no rects (rects are recomputed live at render time), so relax it.
alter table annotations drop constraint if exists shape_matches_type;
alter table annotations add constraint shape_matches_type check (
  (type = 'highlight' and (rects is not null or cfi is not null)) or
  (type = 'ink' and strokes is not null)
);

alter table annotations drop constraint if exists unit_present;
alter table annotations add constraint unit_present check (
  page_number is not null or spine_index is not null
);

create index if not exists annotations_document_spine_idx
  on annotations (document_id, spine_index) where deleted_at is null;

-- -------------------------------------------------------------- storage RLS
-- The original upload policy checked `owner = auth.uid()`, but `owner` is populated
-- server-side *after* the WITH CHECK runs, so it compared against NULL and rejected
-- every upload ("new row violates row-level security policy"). Check the path prefix
-- instead — uploads go to `${auth.uid()}/...`.
drop policy if exists upload_books on storage.objects;
create policy upload_books on storage.objects for insert
  with check (
    bucket_id = 'books'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

commit;
