-- 01_documents_rls.sql — who can see, create and destroy a book.
--
-- The claims under test, in the order they appear:
--   read    = you are an unrevoked member, or you created it
--   create  = created_by must be you
--   delete  = owner only (social.sql narrowed this from any member)

\set ON_ERROR_STOP on
\set ash   '11111111-1111-1111-1111-111111111111'
\set robin '22222222-2222-2222-2222-222222222222'
\set jules '33333333-3333-3333-3333-333333333333'
\set kit   '44444444-4444-4444-4444-444444444444'
\set docA  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
\set docB  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

begin;

select tests.act_as_admin();

insert into documents (id, title, storage_path, sha256, created_by, page_count, format)
values
  (:'docA', 'The Red Virgin', :'ash'   || '/a1.pdf', 'hash-a', :'ash',   300, 'pdf'),
  (:'docB', 'Many-Headed Hydra', :'ash' || '/b1.epub', 'hash-b', :'ash',   0, 'epub');

insert into memberships (document_id, user_id, display_name, color) values
  (:'docA', :'ash',   'Ash',   '#E9A13B'),
  (:'docA', :'robin', 'Robin', '#3FBFC9'),
  (:'docB', :'ash',   'Ash',   '#E9A13B'),
  (:'docB', :'robin', 'Robin', '#3FBFC9');

-- ---------------------------------------------------------------------- read
select tests.section('read_documents');

select tests.act_as(:'ash');
select tests.visible('select id from documents', 2, 'owner sees both of their books');

select tests.act_as(:'robin');
select tests.visible('select id from documents', 2, 'a shared-in reader sees them too');

-- Kit has an account and no membership row. This is the entire answer to "does a
-- stranger who signs up see my library" — and it is RLS that answers it, not the
-- sign-up form, which is why README insists public sign-ups must stay on.
select tests.act_as(:'kit');
select tests.denied('select id from documents', 'a signed-in stranger sees nothing');

select tests.act_as_anon();
select tests.denied('select id from documents', 'anon sees nothing');

-- -------------------------------------------------------------- read: revoked
select tests.section('revoked membership closes the door');

select tests.act_as_admin();
update memberships set revoked_at = now()
 where document_id = :'docA' and user_id = :'robin';

select tests.act_as(:'robin');
-- is_member() gained `revoked_at is null` in social.sql, and every other policy
-- routes through it. One clause, four tables: this is that clause working.
select tests.visible('select id from documents', 1, 'a revoked reader loses that book and keeps the other');
select tests.denied(
  format('select id from documents where id = %L', :'docA'),
  'the revoked book specifically is gone');

select tests.act_as_admin();
update memberships set revoked_at = null
 where document_id = :'docA' and user_id = :'robin';

-- -------------------------------------------------------------------- create
select tests.section('create_documents');

select tests.act_as(:'kit');

-- The `or created_by = auth.uid()` clause on read_documents is not a convenience.
-- An insert with RETURNING makes Postgres evaluate the SELECT policy against the
-- returned row, and the creator's membership row is written by the *next*
-- statement — so at this instant is_member() is false. Without that clause the
-- app cannot create a document at all: it 403s on its own return value. This is
-- the test that would have caught it.
select tests.visible(
  $q$ insert into documents (title, storage_path, sha256, page_count, format)
      values ('Kit''s own book', '44444444-4444-4444-4444-444444444444/k1.pdf',
              'hash-k', 1, 'pdf')
      returning id $q$,
  1, 'creating a document can read back its own RETURNING row');

select tests.raises(
  format($q$ insert into documents (title, storage_path, sha256, created_by, page_count, format)
             values ('forged', 'x/f.pdf', 'hash-f', %L, 1, 'pdf') $q$, :'ash'),
  'row-level security',
  'cannot create a document owned by someone else');

-- -------------------------------------------------------------------- delete
select tests.section('delete_documents — owner only');

-- A forbidden delete is not an error. RLS filters the row out and reports
-- success, so the only honest assertion is on rows actually removed. deleteDocument
-- in supabase-adapter.js checks the same way and for the same reason.
select tests.act_as(:'robin');
select tests.denied(
  format('delete from documents where id = %L returning id', :'docB'),
  'a member who is not the owner deletes nothing');

select tests.act_as(:'ash');
select tests.visible(
  format('delete from documents where id = %L returning id', :'docB'),
  1, 'the owner can delete');

-- Cascade is doing real work here: memberships, progress and annotations all
-- hang off documents with `on delete cascade`, so nothing client-side has to
-- clean up after a delete.
select tests.act_as_admin();
select tests.eq(
  (select count(*) from memberships where document_id = :'docB')::text,
  '0', 'deleting a book cascades its memberships away');

rollback;
