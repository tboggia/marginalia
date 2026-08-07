-- 07_storage.sql — the bucket, which is where the actual books live.
--
-- Three policies, each with a non-obvious shape:
--   upload  is checked against the path PREFIX, not storage.objects.owner
--   read    joins back to documents and asks is_member
--   delete  is owner-only (social.sql narrowed it from any member)
--
-- And one setting: the bucket must be private. A public bucket makes all three
-- policies decoration, because anyone handed or guessing a filename downloads
-- the book directly without ever touching them.

\set ON_ERROR_STOP on
\set ash   '11111111-1111-1111-1111-111111111111'
\set robin '22222222-2222-2222-2222-222222222222'
\set kit   '44444444-4444-4444-4444-444444444444'
\set docA  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

begin;

select tests.act_as_admin();

select tests.section('the bucket');

select tests.eq((select count(*)::text from storage.buckets where id = 'books'),
  '1', 'a bucket named books exists');

-- The policies below are only load-bearing while this is false.
select tests.eq((select public::text from storage.buckets where id = 'books'),
  'false', 'the books bucket is private');

-- Uploads are content-addressed under the uploader's own id: ${auth.uid()}/<sha>.<ext>
insert into documents (id, title, storage_path, sha256, created_by, page_count, format)
values (:'docA', 'The Red Virgin', :'ash' || '/hash-a.pdf', 'hash-a', :'ash', 300, 'pdf');

insert into memberships (document_id, user_id, display_name, color) values
  (:'docA', :'ash',   'Ash',   '#E9A13B'),
  (:'docA', :'robin', 'Robin', '#3FBFC9');

-- ------------------------------------------------------------------- upload
select tests.section('upload_books — the path prefix carries the identity');

select tests.act_as(:'ash');

-- Why the prefix and not `owner`: on an INSERT into storage.objects, `owner` is
-- populated server-side *after* the WITH CHECK runs, so `owner = auth.uid()`
-- compares against NULL and rejects every upload with "new row violates
-- row-level security policy". The first path segment already carries the
-- identity, so it is what the policy reads.
select tests.visible(
  format($q$ insert into storage.objects (bucket_id, name)
             values ('books', %L) returning id $q$, :'ash' || '/hash-a.pdf'),
  1, 'you can upload under your own id');

select tests.raises(
  format($q$ insert into storage.objects (bucket_id, name) values ('books', %L) $q$,
         :'robin' || '/smuggled.pdf'),
  'row-level security', 'you cannot upload into another account''s folder');

select tests.raises(
  $q$ insert into storage.objects (bucket_id, name) values ('books', 'loose.pdf') $q$,
  'row-level security', 'you cannot upload to the bucket root');

-- --------------------------------------------------------------------- read
select tests.section('read_books — membership, via the documents row');

-- Reads go through signed URLs rather than downloaded bytes, so this policy is
-- what decides whether a URL can be minted at all.
select tests.act_as(:'robin');
select tests.visible(
  $q$ select id from storage.objects where bucket_id = 'books' $q$,
  1, 'a co-reader can reach the book''s object');

select tests.act_as(:'kit');
select tests.denied(
  $q$ select id from storage.objects where bucket_id = 'books' $q$,
  'a stranger cannot reach the object even knowing the path');

select tests.act_as_anon();
select tests.denied(
  $q$ select id from storage.objects where bucket_id = 'books' $q$,
  'anon cannot reach the object');

-- Revoking a reader closes the storage object too, not just the database rows.
-- Every policy routes through is_member, which is the point of putting the
-- revoked_at clause in one function instead of in each policy.
select tests.act_as_admin();
update memberships set revoked_at = now() where document_id = :'docA' and user_id = :'robin';

select tests.act_as(:'robin');
select tests.denied(
  $q$ select id from storage.objects where bucket_id = 'books' $q$,
  'a revoked reader loses the file, not just the annotations');

select tests.act_as_admin();
update memberships set revoked_at = null where document_id = :'docA' and user_id = :'robin';

-- ------------------------------------------------------------------- delete
select tests.section('delete_books — owner only');

-- A non-owner deleting the object would strip the file out from under a book
-- they merely read. The database-side delete_documents policy says owner-only;
-- if storage disagreed, the book would survive with nothing to render.
--
-- storage.protect_delete() refuses every direct SQL delete from this table
-- unless `storage.allow_delete_query` is set, to stop a stray statement
-- orphaning files the Storage API would have cleaned up. It is an accident
-- guard, not the security boundary — RLS is the security boundary — and the
-- Storage API sets this same flag on its own connection before deleting. So the
-- test sets it too: without it the trigger refuses everyone, and both
-- assertions below would "pass" while proving nothing about the policy.
--
-- It raises with errcode 42501, the same code as a missing grant, which is
-- exactly how it disguised itself as a passing test once already.
select set_config('storage.allow_delete_query', 'true', true);

select tests.act_as(:'robin');
select tests.denied(
  format($q$ delete from storage.objects where name = %L returning id $q$, :'ash' || '/hash-a.pdf'),
  'a reader who is not the owner cannot delete the file');

select tests.act_as(:'ash');
select tests.visible(
  format($q$ delete from storage.objects where name = %L returning id $q$, :'ash' || '/hash-a.pdf'),
  1, 'the owner can delete the file');

rollback;
