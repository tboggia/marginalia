-- 05_merge.sql — merge_documents, the one irreversible operation in the schema.
--
-- Two people each added the same book, so there are two documents rows and
-- neither can read the other's marks. Merging repoints every annotation and
-- progress row and deletes the losing document. There is no undo.
--
-- It is only ever safe between byte-identical files. Every stored anchor — PDF
-- rects, PDF text-item indexes, EPUB CFIs — is a property of one particular
-- file, so merging across a hash mismatch would silently render highlights on
-- the wrong words. The function re-checks the hash itself rather than trusting a
-- client that already claimed a match, and that re-check is the first thing
-- tested below.

\set ON_ERROR_STOP on
\set ash   '11111111-1111-1111-1111-111111111111'
\set robin '22222222-2222-2222-2222-222222222222'
\set jules '33333333-3333-3333-3333-333333333333'
\set kit   '44444444-4444-4444-4444-444444444444'
\set docA  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
\set docC  'cccccccc-cccc-cccc-cccc-cccccccccccc'
\set docD  'dddddddd-dddd-dddd-dddd-dddddddddddd'
\set docE  'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
\set docF  'ffffffff-ffff-ffff-ffff-ffffffffffff'

begin;

select tests.act_as_admin();

-- docA and docC are the same bytes, added independently by two people.
-- docD is a different scan of the same title — a different book, here.
insert into documents (id, title, storage_path, sha256, created_by, page_count, format)
values
  (:'docA', 'The Red Virgin',  :'ash'   || '/same.pdf',  'same-bytes',  :'ash',   300, 'pdf'),
  (:'docC', 'Red Virgin, The', :'robin' || '/same.pdf',  'same-bytes',  :'robin', 300, 'pdf'),
  (:'docD', 'The Red Virgin',  :'jules' || '/other.pdf', 'other-bytes', :'jules', 302, 'pdf'),
  (:'docE', 'Hydra (mine)',    'shared/z.pdf',           'z-bytes',     :'ash',     0, 'epub'),
  (:'docF', 'Hydra (theirs)',  'shared/z.pdf',           'z-bytes',     :'robin',   0, 'epub');

insert into memberships (document_id, user_id, display_name, color) values
  (:'docA', :'ash',   'Ash',   '#E9A13B'),
  (:'docA', :'jules', 'Jules', '#3FBFC9'),   -- a reader of the losing copy only
  (:'docC', :'robin', 'Robin', '#E9A13B'),
  (:'docC', :'ash',   'Ash',   '#3FBFC9'),   -- Ash now holds both
  (:'docD', :'jules', 'Jules', '#E9A13B'),
  (:'docD', :'ash',   'Ash',   '#3FBFC9'),
  (:'docE', :'ash',   'Ash',   '#E9A13B'),
  (:'docF', :'robin', 'Robin', '#E9A13B'),
  (:'docF', :'ash',   'Ash',   '#3FBFC9');

insert into annotations (document_id, user_id, page_number, type, color, rects, text, percent) values
  (:'docA', :'ash',   12, 'highlight', '#E9A13B', '[{"x":0.1,"y":0.2,"w":0.3,"h":0.02}]'::jsonb, 'from docA', 0.04),
  (:'docA', :'jules', 40, 'highlight', '#3FBFC9', '[{"x":0.2,"y":0.2,"w":0.3,"h":0.02}]'::jsonb, 'jules on docA', 0.13),
  (:'docC', :'robin', 90, 'highlight', '#E9A13B', '[{"x":0.1,"y":0.5,"w":0.3,"h":0.02}]'::jsonb, 'from docC', 0.30);

-- Ash is further along in their own copy than in Robin's, and stopped reading
-- Robin's copy yesterday.
insert into progress (document_id, user_id, page, y_frac, percent, updated_at) values
  (:'docA', :'ash',   200, 0.5, 0.66, now()),
  (:'docC', :'ash',    50, 0.1, 0.16, now() - interval '1 day'),
  (:'docC', :'robin', 120, 0.2, 0.40, now());

-- ------------------------------------------------------------ what is refused
select tests.section('merge_documents refuses');

select tests.act_as(:'ash');

-- The whole safety argument, in one check. Two different scans of the same title
-- are never merged; the app says so rather than putting highlights on the wrong
-- words.
select tests.raises(
  format($q$ select merge_documents(%L, %L) $q$, :'docD', :'docA'),
  'different files', 'merging across a hash mismatch is refused');

select tests.raises(
  format($q$ select merge_documents(%L, %L) $q$, :'docA', :'docA'),
  'same book', 'merging a book into itself is refused');

select tests.raises(
  format($q$ select merge_documents(%L, %L) $q$, :'docA', '00000000-0000-0000-0000-000000000009'),
  'No such book', 'merging a book that does not exist is refused');

-- Because the function is security definer it bypasses the owner-only delete
-- policy. Without the created_by check, a reader shared into your book could
-- pass keep=<their copy>, drop=<yours> and destroy a book they do not own. You
-- may only ever give up a copy you created.
select tests.raises(
  format($q$ select merge_documents(%L, %L) $q$, :'docA', :'docC'),
  'only merge your own copy', 'you cannot drop a copy someone else created');

select tests.act_as(:'kit');
select tests.raises(
  format($q$ select merge_documents(%L, %L) $q$, :'docC', :'docA'),
  'Not your book', 'a stranger cannot merge two books they cannot see');

-- --------------------------------------------------------------- the merge
select tests.section('merge_documents — Ash folds their copy into Robin''s');

select tests.act_as(:'ash');

-- The storage path of the dropped copy comes back rather than being deleted
-- here: removing the storage.objects row in SQL drops the record and leaves the
-- file orphaned in the bucket, so the caller removes it through the storage API.
select tests.eq(
  merge_documents(:'docC', :'docA'),
  :'ash' || '/same.pdf',
  'returns the dropped copy''s storage path for the caller to clean up');

select tests.act_as_admin();

select tests.eq((select count(*)::text from documents where id = :'docA'),
  '0', 'the losing document is gone');

select tests.eq(
  (select count(*)::text from annotations where document_id = :'docC'),
  '3', 'every annotation from both copies is now on the surviving one');

select tests.eq(
  (select count(*)::text from annotations where text = 'jules on docA' and document_id = :'docC'),
  '1', 'a third reader''s marks move too, not just the merger''s');

-- Members are copied before annotations are repointed, so every mark lands in a
-- document its author can still read.
select tests.eq(
  (select count(*)::text from memberships where document_id = :'docC' and revoked_at is null),
  '3', 'readers of the losing copy become readers of the surviving one');

select tests.eq(
  (select count(distinct color)::text from memberships
    where document_id = :'docC' and revoked_at is null),
  '3', 'the arriving reader is given a colour nobody in this book holds');

-- Progress is one row per person per book, so someone present in both keeps
-- whichever place they reached most recently — not whichever row merged last.
select tests.eq(
  (select page::text from progress where document_id = :'docC' and user_id = :'ash'),
  '200', 'the merger keeps their furthest-forward place, not the older one');

select tests.eq(
  (select page::text from progress where document_id = :'docC' and user_id = :'robin'),
  '120', 'the surviving copy''s own reader keeps their place untouched');

-- ------------------------------------------------- the shared-path safeguard
select tests.section('a shared storage path is never handed back for deletion');

select tests.act_as(:'ash');
-- Two copies can only share a path if the same account uploaded both, which
-- putDocument's dedupe already prevents. If it ever happened, deleting that
-- object would strip the file out from under the copy we just kept.
select tests.ok(
  merge_documents(:'docF', :'docE') is null,
  'returns null when both copies point at the same object');

select tests.act_as_admin();
select tests.eq((select count(*)::text from documents where id = :'docF'),
  '1', 'and the surviving copy is still there');

rollback;
