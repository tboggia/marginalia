-- 03_invites.sql — the one door through the read barrier.
--
-- write_own_membership lets you insert your own membership row, and
-- read_documents means you can never learn the id of a document you are not
-- already in. redeem_invite is the security-definer function built to cross that
-- gap, which makes it the single most security-sensitive entry point in the
-- schema: it is reachable by any signed-in user holding nothing but a guessed
-- string. Every limit it enforces is tested here, because none of them are
-- enforced anywhere else.
--
-- Codes are spelled out rather than generated so a failure names the invite it
-- was. In production they are 8 random bytes from gen_random_bytes.

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

-- ------------------------------------------------------------------ minting
select tests.section('who may mint an invite');

select tests.act_as(:'ash');

-- created_by is left to its default so the default is under test too.
insert into invites (code, kind)                  values ('conn-ash-01', 'connect');
insert into invites (code, kind, document_id)     values ('book-ash-01', 'book', :'docA');
insert into invites (code, kind, expires_at)      values ('conn-old-01', 'connect', now() - interval '1 day');
insert into invites (code, kind)                  values ('conn-off-01', 'connect');

select tests.eq((select created_by from invites where code = 'conn-ash-01')::text, :'ash',
  'created_by defaults to the minting account');

-- Sharing a book is owner-only, and a link is just another way to add a reader.
-- Without the documents check on the insert policy, adding readers would be
-- owner-only through share_document and wide open through a link.
select tests.act_as_admin();
insert into memberships (document_id, user_id, display_name, color)
values (:'docA', :'robin', 'Robin', '#3FBFC9');

select tests.act_as(:'robin');
select tests.raises(
  format($q$ insert into invites (code, kind, document_id) values ('book-rob-01', 'book', %L) $q$, :'docA'),
  'row-level security',
  'a reader who is not the owner cannot mint a book invite');

-- A connect invite carries no document, so anyone may mint one for themselves.
insert into invites (code, kind) values ('conn-rob-01', 'connect');
select tests.ok(true, 'anyone can mint a connect invite for themselves');

-- Invites are never readable by code. That is the entire reason redeem_invite
-- has to exist — if a client could select one, it could read the document id out
-- of it and skip the function.
select tests.act_as(:'kit');
select tests.denied($q$ select code from invites where code = 'conn-ash-01' $q$,
  'you cannot read someone else''s invite, even knowing the code');

-- ---------------------------------------------------------------- redeeming
select tests.section('redeem_invite — connect');

select tests.act_as(:'kit');
select * from redeem_invite('conn-ash-01', null);

select tests.visible(
  format($q$ select 1 from connections
              where user_a = least(%L::uuid, %L::uuid) and user_b = greatest(%L::uuid, %L::uuid)
                and status = 'accepted' $q$, :'ash', :'kit', :'ash', :'kit'),
  1, 'redeeming a connect invite links the two accounts');

-- Single-use by default. A leaked link that is never clicked goes dead on its
-- own; one already spent is refused with something a person can read.
select tests.act_as(:'jules');
select tests.raises($q$ select * from redeem_invite('conn-ash-01', null) $q$,
  'already been used', 'a spent single-use link is refused');

-- Re-clicking your own redeemed link has to stay harmless — people do it, and
-- it must not consume a second use or error at them.
select tests.act_as(:'kit');
select * from redeem_invite('conn-ash-01', null);
select tests.ok(true, 're-clicking a link you already redeemed is a no-op');

select tests.act_as(:'ash');
select tests.raises($q$ select * from redeem_invite('conn-ash-01', null) $q$,
  'your own invite', 'you cannot redeem your own link');

select tests.act_as(:'jules');
select tests.raises($q$ select * from redeem_invite('conn-old-01', null) $q$,
  'expired', 'an expired link is refused');

select tests.raises($q$ select * from redeem_invite('no-such-code', null) $q$,
  'not valid', 'an unknown code is refused');

-- ------------------------------------------------------------------ revoking
select tests.section('revoke_invite');

select tests.act_as(:'robin');
select tests.raises($q$ select revoke_invite('conn-off-01') $q$,
  'No such invite', 'you cannot revoke an invite you did not mint');

select tests.act_as(:'ash');
select revoke_invite('conn-off-01');

select tests.act_as(:'jules');
select tests.raises($q$ select * from redeem_invite('conn-off-01', null) $q$,
  'turned off', 'a revoked link stops working');

-- Revoking one link leaves every other link to the same book alone — the whole
-- reason invites became rows instead of a single column on documents.
select tests.act_as(:'jules');
select * from redeem_invite('book-ash-01', null);
select tests.ok(true, 'revoking one invite does not disturb another');

-- ------------------------------------------------------------- redeem: book
select tests.section('redeem_invite — book');

select tests.visible(
  format($q$ select 1 from memberships where document_id = %L and user_id = %L
                and revoked_at is null $q$, :'docA', :'jules'),
  1, 'a book invite puts the reader in the book');

-- Both kinds connect the accounts. A book invite that didn't would leave you
-- reading alongside someone your People screen cannot name.
select tests.visible(
  format($q$ select 1 from connections
              where user_a = least(%L::uuid, %L::uuid) and user_b = greatest(%L::uuid, %L::uuid) $q$,
         :'ash', :'jules', :'ash', :'jules'),
  1, 'a book invite also connects the two accounts');

-- No two readers of one book may share a colour. Jules's profile colour is the
-- palette default, which Ash holds; the next palette entry is Robin's. So
-- pick_color has to walk past both, not just past the first collision.
select tests.eq(
  (select color from memberships where document_id = :'docA' and user_id = :'jules'),
  '#E87CB0', 'pick_color walks past every taken colour, not just the first');

-- ------------------------------------------------- redeem: a removed reader
select tests.section('a revoked reader cannot let themselves back in');

select tests.act_as_admin();
update memberships set revoked_at = now()
 where document_id = :'docA' and user_id = :'jules';
-- Give the link a use left, so the refusal below can only come from the revoke
-- check and not from the link being spent.
update invites set max_uses = 10 where code = 'book-ash-01';

select tests.act_as(:'jules');
-- Without this check the removed reader walks straight back in through the same
-- idempotency that makes a re-clicked link harmless for everyone else: the
-- membership row survives a revoke by design, and the upsert would clear
-- revoked_at. Getting back in has to be an act by the owner.
select tests.raises($q$ select * from redeem_invite('book-ash-01', null) $q$,
  'removed from this book', 'a removed reader cannot rejoin on their old link');

select tests.act_as_admin();
select tests.eq(
  (select revoked_at is not null from memberships
    where document_id = :'docA' and user_id = :'jules')::text,
  'true', 'the refused rejoin left the membership revoked');

rollback;
