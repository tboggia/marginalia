-- 08_account_deletion.sql — leaving for good.
--
-- The one hard delete in the app, and the only place where "nothing is ever really
-- deleted" stops being true. Every other ending here is a mark on a row: a revoked
-- membership is still a membership, a removed highlight is a tombstone with a
-- deleted_at. All of that is so re-sharing can resume rather than restart. An
-- account has nothing to resume into, so it goes.
--
-- Two halves, and the second is the one worth testing. Everything hanging off an
-- `on delete cascade` to auth.users is Postgres's problem and is asserted here
-- mostly to prove the cascades are actually there. What isn't Postgres's problem
-- is a book the departing account added that other people are still reading:
-- deleting it would take their highlights with it, and leaving it is only possible
-- if someone else becomes its owner. `documents.created_by` has no cascade for
-- exactly that reason, so a missing hand-over is not a silent orphan — it is a
-- foreign key violation, and the account cannot leave at all.

\set ON_ERROR_STOP on
\set ash   '11111111-1111-1111-1111-111111111111'
\set robin '22222222-2222-2222-2222-222222222222'
\set jules '33333333-3333-3333-3333-333333333333'
\set kit   '44444444-4444-4444-4444-444444444444'
\set docA  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
\set docB  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
\set docC  'cccccccc-cccc-cccc-cccc-cccccccccccc'

begin;

select tests.act_as_admin();

-- Ash added two books and reads a third.
--   docA — Ash's, shared with Robin and Jules. Stays: two people are still in it.
--   docB — Ash's, nobody else. Goes.
--   docC — Robin's, Ash was shared in. Stays, minus everything Ash wrote in it.
insert into documents (id, title, storage_path, sha256, created_by, page_count, format)
values
  (:'docA', 'The Red Virgin', :'ash'   || '/a1.pdf',  'hash-a', :'ash',   300, 'pdf'),
  (:'docB', 'Hydra',          :'ash'   || '/b1.epub', 'hash-b', :'ash',     0, 'epub'),
  (:'docC', 'The Dispossessed', :'robin' || '/c1.pdf', 'hash-c', :'robin', 400, 'pdf');

-- joined_at is explicit and ordered, because the hand-over goes to whoever joined
-- earliest and a fixture where three rows share now() cannot assert which that is.
insert into memberships (document_id, user_id, display_name, color, shared_by, joined_at) values
  (:'docA', :'ash',   'Ash',   '#E9A13B', null,    now() - interval '3 days'),
  (:'docA', :'robin', 'Robin', '#3FBFC9', :'ash',  now() - interval '2 days'),
  (:'docA', :'jules', 'Jules', '#E87CB0', :'ash',  now() - interval '1 day'),
  (:'docB', :'ash',   'Ash',   '#E9A13B', null,    now() - interval '3 days'),
  (:'docC', :'robin', 'Robin', '#E9A13B', null,    now() - interval '5 days'),
  (:'docC', :'ash',   'Ash',   '#3FBFC9', :'robin', now() - interval '4 days');

insert into annotations (document_id, user_id, page_number, type, color, rects, text, percent)
values
  (:'docA', :'ash',   12, 'highlight', '#E9A13B', '[{"x":0.1,"y":0.2,"w":0.3,"h":0.02}]'::jsonb, 'the commonage of the poor', 0.04),
  (:'docA', :'robin', 12, 'highlight', '#3FBFC9', '[{"x":0.1,"y":0.5,"w":0.3,"h":0.02}]'::jsonb, 'a second reader''s mark',    0.04),
  (:'docC', :'ash',    7, 'highlight', '#3FBFC9', '[{"x":0.2,"y":0.3,"w":0.2,"h":0.02}]'::jsonb, 'in someone else''s book',   0.02),
  (:'docC', :'robin',  7, 'highlight', '#E9A13B', '[{"x":0.2,"y":0.7,"w":0.2,"h":0.02}]'::jsonb, 'the owner''s own mark',     0.02);

insert into progress (document_id, user_id, page, percent) values
  (:'docA', :'ash',   40, 0.13),
  (:'docA', :'robin', 12, 0.04),
  (:'docC', :'ash',    7, 0.02);

insert into connections (user_a, user_b, requested_by, status) values
  (least(:'ash'::uuid, :'robin'::uuid), greatest(:'ash'::uuid, :'robin'::uuid), :'ash', 'accepted'),
  (least(:'ash'::uuid, :'jules'::uuid), greatest(:'ash'::uuid, :'jules'::uuid), :'ash', 'accepted'),
  (least(:'robin'::uuid, :'jules'::uuid), greatest(:'robin'::uuid, :'jules'::uuid), :'robin', 'accepted');

insert into invites (code, created_by, kind, document_id) values
  ('ash-connect-code', :'ash',   'connect', null),
  ('ash-book-code',    :'ash',   'book',    :'docA'),
  ('robin-book-code',  :'robin', 'book',    :'docC');

-- ------------------------------------------------------------------ the plan
select tests.section('account_deletion_plan — what it would cost');

select tests.act_as(:'ash');

select tests.visible('select * from account_deletion_plan()', 2,
  'the plan covers the two books Ash added, and not the one Ash only reads');

select tests.eq(
  (select action from account_deletion_plan() where document_id = :'docA'),
  'handover', 'a book someone else is still reading is handed over');

select tests.eq(
  (select action from account_deletion_plan() where document_id = :'docB'),
  'delete', 'a book nobody else is reading is deleted');

-- The client removes these from the bucket before calling delete_account, while the
-- documents rows that authorize the removal still exist. A plan that did not carry
-- the path would leave the file behind with nothing pointing at it.
select tests.eq(
  (select storage_path from account_deletion_plan() where document_id = :'docB'),
  :'ash' || '/b1.epub', 'the plan carries the storage path of every book it deletes');

-- Revoked readers are not readers. A book whose only other member was removed has
-- nobody to hand it to, and hand-over to someone who was thrown out would be a way
-- back in.
select tests.act_as_admin();
update memberships set revoked_at = now() where document_id = :'docA' and user_id = :'jules';
update memberships set revoked_at = now() where document_id = :'docA' and user_id = :'robin';
select tests.act_as(:'ash');
select tests.eq(
  (select action from account_deletion_plan() where document_id = :'docA'),
  'delete', 'a book whose readers were all revoked has nobody to hand it to');
select tests.act_as_admin();
update memberships set revoked_at = null where document_id = :'docA';
select tests.act_as(:'ash');

-- ------------------------------------------------------------------- the deed
select tests.section('delete_account — what actually happens');

select delete_account();

-- Ash no longer exists, so nothing below can be asserted as Ash.
select tests.act_as_admin();

select tests.eq((select count(*)::text from auth.users where id = :'ash'),
  '0', 'the account row is gone');
select tests.eq((select count(*)::text from profiles where user_id = :'ash'),
  '0', 'the profile went with it');

select tests.section('books');

select tests.eq((select count(*)::text from documents where id = :'docB'),
  '0', 'the book nobody else was reading is gone');

select tests.eq((select count(*)::text from documents where id = :'docA'),
  '1', 'the book two other people are reading is still here');

-- Robin joined a day before Jules. Handing a shared book to nobody is not an option:
-- every owner check in social.sql reads created_by, so a null there is a book that can
-- never be shared, deleted, or even left.
select tests.eq(
  (select created_by from documents where id = :'docA')::text, :'robin',
  'ownership passed to the reader who joined earliest');

select tests.eq((select count(*)::text from documents where id = :'docC'),
  '1', 'a book Ash only read is untouched');

select tests.section('memberships');

select tests.eq((select count(*)::text from memberships where user_id = :'ash'),
  '0', 'every membership Ash held is gone');

select tests.eq((select count(*)::text from memberships where document_id = :'docA'),
  '2', 'the two remaining readers keep their places in the handed-over book');

-- shared_by records who let you in, not a dependency on them still being here. Without
-- `on delete set null` on that foreign key, these two rows alone would have refused the
-- whole deletion, and the account could never leave.
select tests.eq(
  (select count(*)::text from memberships where document_id = :'docA' and shared_by is null),
  '2', 'the readers Ash invited stay, with no one recorded as having invited them');

select tests.section('marks');

select tests.eq((select count(*)::text from annotations where user_id = :'ash'),
  '0', 'Ash''s highlights are gone from every book, including books Ash did not own');

select tests.eq((select count(*)::text from annotations where document_id = :'docC'),
  '1', 'Robin''s highlight in Robin''s own book survives');

select tests.eq((select count(*)::text from annotations where document_id = :'docA'),
  '1', 'Robin''s highlight in the handed-over book survives');

select tests.eq((select count(*)::text from progress where user_id = :'ash'),
  '0', 'Ash''s reading positions are gone');

select tests.eq((select count(*)::text from progress where document_id = :'docA'),
  '1', 'Robin''s reading position is not');

select tests.section('the social layer');

select tests.eq(
  (select count(*)::text from connections where user_a = :'ash' or user_b = :'ash'),
  '0', 'every connection Ash was part of is gone');

select tests.eq(
  (select count(*)::text from connections where user_a = :'robin' or user_b = :'robin'),
  '1', 'Robin and Jules are still connected to each other');

select tests.eq((select count(*)::text from invites where created_by = :'ash'),
  '0', 'links Ash minted stop existing, including the one to the handed-over book');

select tests.eq((select count(*)::text from invites where created_by = :'robin'),
  '1', 'Robin''s link is untouched');

-- ------------------------------------------------------------------- who may
select tests.section('who can call it');

-- There is no account id to pass, and that is the security model: the function deletes
-- auth.uid() and nothing else, so the worst a hostile client can do with it is leave.
select tests.eq(
  (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'delete_account' and p.pronargs = 0),
  '1', 'delete_account takes no arguments, so there is no one else to aim it at');

select tests.act_as_anon();
select tests.raises('select delete_account()', 'permission denied',
  'a signed-out visitor cannot call it');
select tests.raises('select * from account_deletion_plan()', 'permission denied',
  'nor read what it would do');

rollback;
