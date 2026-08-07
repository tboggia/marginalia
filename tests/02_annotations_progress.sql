-- 02_annotations_progress.sql — the two tables readers actually write to.
--
--   read    = you are an unrevoked member of the document
--   write   = user_id is you, AND you are a member
--   hidden  = a departed reader's marks vanish for everyone but their author
--
-- Plus the constraints that keep a row from being nonsense in the first place,
-- which matter more here than usual: `progress` has exactly one row per person
-- per book and is upserted in place, so a bad row is not one bad row — it is
-- that reader's place in that book, permanently.

\set ON_ERROR_STOP on
\set ash   '11111111-1111-1111-1111-111111111111'
\set robin '22222222-2222-2222-2222-222222222222'
\set jules '33333333-3333-3333-3333-333333333333'
\set kit   '44444444-4444-4444-4444-444444444444'
\set docA  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
\set docB  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
\set noteA 'a11a1111-0000-0000-0000-000000000001'

begin;

select tests.act_as_admin();

insert into documents (id, title, storage_path, sha256, created_by, page_count, format)
values
  (:'docA', 'The Red Virgin', :'ash'   || '/a1.pdf',  'hash-a', :'ash',   300, 'pdf'),
  (:'docB', 'Hydra',          :'jules' || '/b1.epub', 'hash-b', :'jules',   0, 'epub');

insert into memberships (document_id, user_id, display_name, color) values
  (:'docA', :'ash',   'Ash',   '#E9A13B'),
  (:'docA', :'robin', 'Robin', '#3FBFC9'),
  (:'docB', :'jules', 'Jules', '#E9A13B');

insert into annotations (id, document_id, user_id, page_number, type, color, rects, text, percent)
values (:'noteA', :'docA', :'ash', 12, 'highlight', '#E9A13B',
        '[{"x":0.1,"y":0.2,"w":0.3,"h":0.02}]'::jsonb,
        'the commonage of the poor', 0.04);

-- --------------------------------------------------------------------- read
select tests.section('read_annotations');

select tests.act_as(:'robin');
select tests.visible('select id from annotations', 1,
  'a co-reader sees the other reader''s highlight');

select tests.act_as(:'kit');
select tests.denied('select id from annotations', 'a stranger sees no annotations');

select tests.act_as_anon();
select tests.denied('select id from annotations', 'anon sees no annotations');

-- Jules is a member of a different book. The read policy is per-document, not
-- global, so holding one book must not open another.
select tests.act_as(:'jules');
select tests.denied('select id from annotations',
  'a member of a different book sees nothing of this one');

-- -------------------------------------------------------------------- write
select tests.section('write_own_annotations');

select tests.act_as(:'robin');

select tests.visible(
  format($q$ insert into annotations (document_id, user_id, page_number, type, color, rects, percent)
             values (%L, %L, 13, 'highlight', '#3FBFC9',
                     '[{"x":0.1,"y":0.4,"w":0.2,"h":0.02}]'::jsonb, 0.05)
             returning id $q$, :'docA', :'robin'),
  1, 'a member writes their own highlight');

-- The `user_id = auth.uid()` half of the WITH CHECK. Without it any member could
-- write marks that show up under someone else's name and colour.
select tests.raises(
  format($q$ insert into annotations (document_id, user_id, page_number, type, color, rects)
             values (%L, %L, 14, 'highlight', '#E9A13B', '[]'::jsonb) $q$, :'docA', :'ash'),
  'row-level security',
  'cannot write a highlight under another reader''s name');

-- The `is_member(document_id)` half. A user id you legitimately own is not
-- authority over a document you have never been shared into.
select tests.raises(
  format($q$ insert into annotations (document_id, user_id, page_number, type, color, rects)
             values (%L, %L, 1, 'highlight', '#3FBFC9', '[]'::jsonb) $q$, :'docB', :'robin'),
  'row-level security',
  'cannot write into a book you are not a member of');

select tests.denied(
  format($q$ update annotations set note = 'hijacked' where id = %L returning id $q$, :'noteA'),
  'cannot edit another reader''s highlight');

-- ------------------------------------------------------------- shape checks
select tests.section('annotation shape constraints');

select tests.act_as(:'ash');

-- Ink is PDF-only and highlights need somewhere to be. These are the constraints
-- that keep "one table, nullable columns" from meaning "any combination of nulls".
select tests.raises(
  format($q$ insert into annotations (document_id, user_id, page_number, type, color)
             values (%L, %L, 3, 'highlight', '#E9A13B') $q$, :'docA', :'ash'),
  'shape_matches_type', 'a highlight with neither rects nor cfi is refused');

select tests.raises(
  format($q$ insert into annotations (document_id, user_id, page_number, type, color)
             values (%L, %L, 3, 'ink', '#E9A13B') $q$, :'docA', :'ash'),
  'shape_matches_type', 'ink with no strokes is refused');

select tests.raises(
  format($q$ insert into annotations (document_id, user_id, type, color, rects)
             values (%L, %L, 'highlight', '#E9A13B', '[]'::jsonb) $q$, :'docA', :'ash'),
  'unit_present', 'an annotation belonging to no page and no chapter is refused');

-- The trigger that keeps updated_at honest. The realtime feed and the outbox
-- flush both order by it; a stale value is a change the other reader never sees.
select tests.act_as_admin();
update annotations set updated_at = '2020-01-01' where id = :'noteA';
select tests.act_as(:'ash');
update annotations set note = 'a note' where id = :'noteA';
select tests.ok(
  (select updated_at > '2021-01-01' from annotations where id = :'noteA'),
  'updating a highlight bumps updated_at');

-- ------------------------------------------------------------------ hiding
select tests.section('hidden_at — a departed reader''s marks');

select tests.act_as_admin();
update annotations set hidden_at = now() where id = :'noteA';

select tests.act_as(:'robin');
select tests.denied(
  format('select id from annotations where id = %L', :'noteA'),
  'a hidden highlight disappears for everyone else');
select tests.visible('select id from annotations', 1,
  'and the co-reader is left with only their own');

-- Reversible, not destructive: the author keeps seeing their own. That is what
-- makes "take my marks with me" something re-sharing can undo.
select tests.act_as(:'ash');
select tests.visible(
  format('select id from annotations where id = %L', :'noteA'), 1,
  'the author still sees their own hidden highlight');

select tests.act_as_admin();
update annotations set hidden_at = null where id = :'noteA';

-- ---------------------------------------------------------------- progress
select tests.section('progress');

select tests.act_as(:'ash');

select tests.raises(
  format($q$ insert into progress (document_id, user_id, page, y_frac, cfi, percent)
             values (%L, %L, 4, 0.5, 'epubcfi(/6/4!/2)', 0.1) $q$, :'docA', :'ash'),
  'progress_locator_matches', 'a row claiming both a page and a CFI is refused');

select tests.raises(
  format($q$ insert into progress (document_id, user_id, percent)
             values (%L, %L, 0.1) $q$, :'docA', :'ash'),
  'progress_locator_matches', 'a row claiming neither is refused');

select tests.visible(
  format($q$ insert into progress (document_id, user_id, page, y_frac, percent)
             values (%L, %L, 12, 0.25, 0.04) returning user_id $q$, :'docA', :'ash'),
  1, 'a PDF reader stores page + y_frac');

select tests.act_as(:'robin');
select tests.raises(
  format($q$ insert into progress (document_id, user_id, page, percent)
             values (%L, %L, 9, 0.03) $q$, :'docA', :'kit'),
  'row-level security', 'cannot move someone else''s bookmark');

select tests.act_as(:'kit');
select tests.raises(
  format($q$ insert into progress (document_id, user_id, page, percent)
             values (%L, %L, 9, 0.03) $q$, :'docA', :'kit'),
  'row-level security', 'cannot store progress in a book you cannot read');

-- Everyone in a book can see how far apart you all are — that is the spine rail.
select tests.act_as(:'robin');
select tests.visible('select user_id from progress', 1,
  'a co-reader can see where the other reader is');

rollback;
