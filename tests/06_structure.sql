-- 06_structure.sql — the settings that fail silently.
--
-- Everything here is a property of the database rather than a behaviour, and
-- every one of them is invisible when wrong. A missing `replica identity full`
-- does not error: the realtime socket simply starts broadcasting every row
-- change to every subscriber regardless of RLS, and the app looks perfect. A
-- function that lost `security definer` does not error either — it 403s on the
-- exact gap it exists to cross, which reads as "invite links are broken today".
--
-- README tells you to run these by hand once, in the SQL editor. Here they are
-- as assertions, so they run every time instead of the once you remembered to.

\set ON_ERROR_STOP on

begin;

select tests.section('replica identity — realtime respects RLS only if you ask');

-- 'f' is FULL. Anything else and the socket ignores every policy above it.
-- memberships was in the publication from the start but did not get this until
-- social.sql: a real leak in the original schema, not a gap this feature filled.
select tests.eq((select relreplident::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relname = 'annotations'), 'f',
  'annotations has replica identity full');
select tests.eq((select relreplident::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relname = 'progress'), 'f',
  'progress has replica identity full');
select tests.eq((select relreplident::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relname = 'memberships'), 'f',
  'memberships has replica identity full');
select tests.eq((select relreplident::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relname = 'connections'), 'f',
  'connections has replica identity full');

select tests.section('publication membership');

select tests.eq(
  (select count(*)::text from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename in ('annotations', 'progress', 'memberships', 'connections')),
  '4', 'all four tables are published to supabase_realtime');

select tests.section('security definer — the functions that cross a barrier');

-- redeem_invite reads invites with RLS suspended so it can find a document you
-- cannot see. is_member queries memberships from inside a memberships policy,
-- which would recurse forever otherwise. If any of these come back false, the
-- function applies RLS to its own queries and fails at the one job it has.
select tests.eq((select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.prosecdef
                    and p.proname in ('redeem_invite', 'share_document', 'revoke_share',
                                      'revoke_invite', 'merge_documents', 'is_member',
                                      'are_connected', 'shares_a_book', 'pick_color',
                                      'list_shares', 'list_connections',
                                      'find_duplicate', 'find_my_duplicates', 'ensure_profile',
                                      'account_deletion_plan', 'delete_account')),
  '16', 'every barrier-crossing function is security definer');

-- A security definer function with a mutable search_path is a privilege
-- escalation waiting for someone to create a shadowing object earlier in the
-- path. Every one of these pins it.
select tests.eq(
  (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and (p.proconfig is null or not (p.proconfig @> array['search_path=public']))),
  '0', 'every security definer function pins its search_path');

select tests.section('row level security is on');

select tests.eq(
  (select count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relrowsecurity
      and c.relname in ('documents', 'memberships', 'progress', 'annotations',
                        'profiles', 'connections', 'invites')),
  '7', 'RLS is enabled on all seven tables');

select tests.section('the two-reader design is actually gone');

-- Not housekeeping. join_document enforced the old two-reader cap and would
-- happily let someone in without any of redeem_invite's expiry, single-use or
-- revoked-reader checks — a live one is a second front door with no lock.
select tests.eq(
  (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('join_document', 'rotate_invite')),
  '0', 'join_document and rotate_invite no longer exist');

select tests.eq(
  (select count(*)::text from information_schema.columns
    where table_schema = 'public' and table_name = 'documents' and column_name = 'invite_code'),
  '0', 'the single per-document invite_code column is gone');

select tests.section('the profile trigger fires on sign-up');

-- Every account needs a profile the moment it exists, or the first person to
-- connect with a brand-new user sees a blank in their People list. The seed
-- creates accounts and nothing else, so a profile here can only have come from
-- on_auth_user_created.
select tests.eq(
  (select count(*)::text from profiles p join auth.users u on u.id = p.user_id
    where u.email like '%@marginalia.test'),
  '4', 'every seeded account got a profile without one being written');

select tests.section('anon reaches nothing');

select tests.act_as_anon();

-- The README's own check, over every table rather than the three it lists. A
-- table that answers anon is one where RLS is off or a policy is missing, and
-- both look like a working app right up until they don't.
do $$
declare
  t text;
  n bigint;
begin
  foreach t in array array['documents', 'memberships', 'progress', 'annotations',
                           'profiles', 'connections', 'invites']
  loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      if n <> 0 then
        raise exception 'FAIL: anon read % row(s) from %', n, t;
      end if;
      raise notice '   ok  anon reads 0 rows from %', t;
    exception when insufficient_privilege then
      -- Even stricter than the policy: no SELECT grant at all. Also a pass.
      raise notice '   ok  anon has no SELECT grant on % at all', t;
    end;
  end loop;
end $$;

rollback;
