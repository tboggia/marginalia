-- seed.sql — applied by `supabase db reset` after every migration, on a fresh
-- database. Two jobs: create the storage bucket the app expects, and create four
-- accounts so both the SQL suite and the browser have identities to work with.
--
-- Nothing here ships to the hosted project. On hosted you create the bucket by
-- hand (README "Deploying" step 4) and accounts arrive through sign-up.

-- --------------------------------------------------------------- the bucket
-- PRIVATE, matching hosted. A public bucket makes every storage policy in
-- schema.sql pure decoration, since anyone handed a filename could download the
-- book directly — so tests/07_storage.sql asserts `public = false` rather than
-- trusting this line to stay right.
insert into storage.buckets (id, name, public)
values ('books', 'books', false)
on conflict (id) do nothing;

-- --------------------------------------------------------------- the people
-- Fixed UUIDs, because the tests hard-code them and a fixture that changes
-- between runs is a fixture that can't assert anything. Readable on purpose:
-- a failure message naming 2222…2222 should tell you it was Robin's.
--
--   1111…  ash    — usually the owner
--   2222…  robin  — usually the reader who gets shared in and revoked
--   3333…  jules  — the third reader, which is the case a two-person design never had
--   4444…  kit    — a signed-in stranger, never a member of anything.
--                   Kit is the whole point: RLS is what stops an account with no
--                   membership row from seeing your books, not a closed sign-up form.
--
-- `encrypted_password` is empty and there is no password login. The app signs in
-- with `signInWithOtp` only, and locally those magic links land in the CLI's mail
-- catcher (`supabase status` prints its URL). Because GoTrue matches an existing
-- account by email, signing in as ash@marginalia.test in the browser lands you on
-- *this* row — so the browser and the SQL suite are looking at the same people.
--
-- If your CLI's GoTrue has drifted and this insert errors on an unknown column,
-- that is what it is: fix the column list here, not in a migration. Nothing in
-- schema.sql or social.sql depends on it.
insert into auth.users (
  instance_id, id, aud, role, email,
  encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'authenticated', 'authenticated', 'ash@marginalia.test', '', now(),
   '{"provider":"email","providers":["email"]}', '{"name":"Ash"}',
   now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222',
   'authenticated', 'authenticated', 'robin@marginalia.test', '', now(),
   '{"provider":"email","providers":["email"]}', '{"name":"Robin"}',
   now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333333',
   'authenticated', 'authenticated', 'jules@marginalia.test', '', now(),
   '{"provider":"email","providers":["email"]}', '{"name":"Jules"}',
   now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '44444444-4444-4444-4444-444444444444',
   'authenticated', 'authenticated', 'kit@marginalia.test', '', now(),
   '{"provider":"email","providers":["email"]}', '{"name":"Kit"}',
   now(), now(), '', '', '', '')
on conflict (id) do nothing;

-- The email identity row. Sign-in works without it in some GoTrue versions and
-- not others, and its column list is the part of the auth schema that has moved
-- most — so a drift here degrades browser sign-in rather than failing the seed
-- and taking the whole SQL suite down with it.
do $$
begin
  insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  select u.id::text, u.id,
         jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
         'email', now(), now()
  from auth.users u
  where u.email like '%@marginalia.test'
  on conflict do nothing;
exception when others then
  raise notice 'seed: auth.identities insert skipped (%). Magic-link sign-in as a seeded user may create a second account instead; the SQL suite is unaffected.', sqlerrm;
end $$;

-- Profiles are not seeded. social.sql's on_auth_user_created trigger writes one
-- per account, and letting it do so here means the seed also verifies the
-- trigger fires — tests/06_structure.sql asserts all four profiles exist.
