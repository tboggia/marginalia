-- 04_sharing_revoking.sql — grants, and taking them back.
--
-- The phase-9 split under test: a *connection* links two accounts and shares no
-- book; a *grant* shares one book with someone you are already connected to.
-- Keeping them separate is what makes "remove someone from this book" and "stop
-- knowing this person" two different actions — so share_document requiring an
-- existing connection is not a formality, it is the thing that stops a client
-- handing a book to an arbitrary user id it happened to learn.
--
-- Revoking never deletes. The membership row is marked, the annotations are
-- hidden at most, and both are reversible. That is what lets re-sharing resume
-- rather than restart.

\set ON_ERROR_STOP on
\set ash   '11111111-1111-1111-1111-111111111111'
\set robin '22222222-2222-2222-2222-222222222222'
\set jules '33333333-3333-3333-3333-333333333333'
\set kit   '44444444-4444-4444-4444-444444444444'
\set docA  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

begin;

select tests.act_as_admin();

insert into documents (id, title, storage_path, sha256, created_by, page_count, format)
values (:'docA', 'The Red Virgin', :'ash' || '/a1.pdf', 'hash-a', :'ash', 300, 'pdf');

insert into memberships (document_id, user_id, display_name, color)
values (:'docA', :'ash', 'Ash', '#E9A13B');

-- Connections are only ever written by redeem_invite, which is security definer.
-- There is deliberately no insert policy — a client that could write its own
-- connection row could attach itself to any account whose id it knew. Fixtures
-- go in as postgres for exactly that reason.
insert into connections (user_a, user_b, requested_by, status) values
  (least(:'ash'::uuid, :'robin'::uuid), greatest(:'ash'::uuid, :'robin'::uuid), :'ash', 'accepted'),
  (least(:'ash'::uuid, :'jules'::uuid), greatest(:'ash'::uuid, :'jules'::uuid), :'ash', 'accepted');

-- --------------------------------------------------------------- share_document
select tests.section('share_document — owner only, connection required');

select tests.act_as(:'ash');
select tests.raises(
  format($q$ select share_document(%L, %L) $q$, :'docA', :'kit'),
  'not connected to that person',
  'you cannot share with someone you are not connected to');

select share_document(:'docA', :'robin');
select tests.visible(
  format($q$ select 1 from memberships where document_id = %L and user_id = %L
                and revoked_at is null $q$, :'docA', :'robin'),
  1, 'the owner shares with a connected account');

select tests.eq(
  (select shared_by from memberships where document_id = :'docA' and user_id = :'robin')::text,
  :'ash', 'the membership records who shared it');

-- Robin is now a reader. A reader passing the book on would make "who can see
-- this" something no single person controls, and would contradict what the share
-- sheet tells non-owners.
select tests.act_as(:'robin');
select tests.raises(
  format($q$ select share_document(%L, %L) $q$, :'docA', :'jules'),
  'Only the person who added this book',
  'a reader cannot share the book onward');

select tests.act_as(:'ash');
select share_document(:'docA', :'jules');

-- Three readers, three colours, resolved per book. The profile colour is only
-- ever the preference this starts from.
select tests.eq(
  (select count(distinct color)::text from memberships
    where document_id = :'docA' and revoked_at is null),
  '3', 'three readers of one book hold three different colours');

-- ----------------------------------------------------------------- revoking
select tests.section('revoke_share — who may end a share');

select tests.act_as(:'kit');
select tests.raises(
  format($q$ select revoke_share(%L, %L, true) $q$, :'docA', :'robin'),
  'Only the owner can remove another reader',
  'a stranger cannot remove a reader');

select tests.act_as(:'robin');
select tests.raises(
  format($q$ select revoke_share(%L, %L, true) $q$, :'docA', :'jules'),
  'Only the owner can remove another reader',
  'one reader cannot remove another');

select tests.act_as(:'ash');
select tests.raises(
  format($q$ select revoke_share(%L, %L, true) $q$, :'docA', :'ash'),
  'owner cannot be removed',
  'the owner cannot be removed from their own book');

-- Leaving is the same call the share sheet makes on someone else, which is why
-- leaveDocument in the adapter goes through revoke_share rather than deleting a
-- membership row.
select tests.act_as(:'jules');
select revoke_share(:'docA', :'jules', true);
select tests.act_as_admin();
select tests.eq(
  (select revoked_at is not null from memberships
    where document_id = :'docA' and user_id = :'jules')::text,
  'true', 'a reader can always remove themselves');

-- ------------------------------------------------------- marks, kept or taken
select tests.section('leave_marks — do your highlights stay?');

select tests.act_as_admin();
insert into annotations (document_id, user_id, page_number, type, color, rects, percent)
values (:'docA', :'robin', 20, 'highlight', '#3FBFC9',
        '[{"x":0.1,"y":0.3,"w":0.2,"h":0.02}]'::jsonb, 0.07);

select tests.act_as(:'ash');
select revoke_share(:'docA', :'robin', false);   -- they took their marks with them

-- Checked as postgres: hidden_at is exactly what Ash can no longer see, so
-- asking Ash whether it is set would always answer no and prove nothing.
select tests.act_as_admin();
select tests.visible(
  format($q$ select 1 from annotations where user_id = %L and hidden_at is not null $q$, :'robin'),
  1, 'taking your marks stamps hidden_at rather than deleting anything');

select tests.act_as(:'ash');
select tests.denied(
  format($q$ select id from annotations where user_id = %L $q$, :'robin'),
  'the remaining readers no longer see them');

-- Nothing was deleted, so sharing the book again brings every one of them back,
-- along with the old reading position. This is the claim README makes under
-- "Leaving a book", and it is the reason revoke is a column write.
select share_document(:'docA', :'robin');
select tests.visible(
  format($q$ select id from annotations where user_id = %L $q$, :'robin'),
  1, 're-sharing brings the hidden marks straight back');

select tests.act_as_admin();
select tests.eq(
  (select revoked_at is null from memberships where document_id = :'docA' and user_id = :'robin')::text,
  'true', 're-sharing clears the revocation rather than making a new row');

-- ---------------------------------------------------------------- list_shares
select tests.section('list_shares');

select tests.act_as(:'ash');

-- Revoked rows come back too, so the share sheet can offer to put someone back
-- without minting a fresh invite.
select tests.visible(format($q$ select * from list_shares(%L) $q$, :'docA'), 3,
  'every reader who is or was in the book is listed');

select tests.eq(
  (select count(*)::text from list_shares(:'docA') where revoked_at is not null),
  '1', 'the reader who left is listed as revoked');

select tests.eq(
  (select user_id::text from list_shares(:'docA') where is_owner),
  :'ash', 'exactly the owner is flagged as owner');

select tests.act_as(:'kit');
select tests.denied(format($q$ select * from list_shares(%L) $q$, :'docA'),
  'a stranger cannot list who reads a book');

-- ----------------------------------------------------------- list_connections
select tests.section('list_connections');

select tests.act_as(:'ash');

select tests.visible('select * from list_connections()', 2,
  'the People screen shows both connections');

-- Books in common counts *current* grants, not connections. Jules left the book
-- but stayed connected — which is the whole point of keeping the two separate.
select tests.eq(
  (select book_count::text from list_connections() where user_id = :'robin'::uuid),
  '1', 'a connection you share a book with counts it');

select tests.eq(
  (select book_count::text from list_connections() where user_id = :'jules'::uuid),
  '0', 'a connection who left the book still shows, with no books in common');

rollback;
