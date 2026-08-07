-- 00_helpers.sql — assertions and identity switching for the SQL suite.
--
-- Applied once per `./test.sh` run, outside a transaction, so the rest of the
-- files can use it. Everything lives in a `tests` schema that no migration
-- creates and hosted never sees.
--
-- Why this exists at all: the client is assumed hostile and never trusted to
-- filter anything, which means every security guarantee this project makes is a
-- policy in Postgres. A policy that is too permissive does not error — it just
-- works, for everyone, forever. The only way to know is to become each user in
-- turn and check what they can actually see.

drop schema if exists tests cascade;
create schema tests;

-- ------------------------------------------------------------- becoming someone
-- Two moves, and both are load-bearing.
--
-- `set local role authenticated` is the one people forget. psql connects as
-- `postgres`, a superuser, and superusers BYPASS RLS entirely — a suite that
-- skips this passes every policy test while testing no policy at all.
--
-- `request.jwt.claims` is what auth.uid() reads. In a real request PostgREST
-- sets it from the verified JWT; here we set it directly, which is the same
-- value by a shorter path. `true` scopes both to the transaction, so a rollback
-- puts the session back the way it found it.
create or replace function tests.act_as(who uuid) returns void
  language plpgsql as $$
begin
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', who::text, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';
end $$;

-- A signed-out visitor. Distinct from "some other user" and worth its own tests:
-- anon reaching a table it should not is the failure that looks like nothing.
create or replace function tests.act_as_anon() returns void
  language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  execute 'set local role anon';
end $$;

-- Back to postgres, for writing fixtures. Superuser bypasses RLS, which is
-- exactly what you want when *placing* the world — a fixture that has to satisfy
-- the policies it is testing can only ever test them tautologically.
create or replace function tests.act_as_admin() returns void
  language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $$;

-- ------------------------------------------------------------------ assertions
create or replace function tests.section(label text) returns void
  language plpgsql as $$
begin
  raise notice '';
  raise notice '-- %', label;
end $$;

create or replace function tests.ok(cond boolean, label text) returns void
  language plpgsql as $$
begin
  -- `is not true` rather than `= false`: a null condition is a broken assertion,
  -- not a passing one, and null is what a miswritten `exists` subquery returns.
  if cond is not true then
    raise exception 'FAIL: % (condition was %)', label, coalesce(cond::text, 'null');
  end if;
  raise notice '   ok  %', label;
end $$;

-- Text in, text out, and callers cast. Verbose at the call site, but the failure
-- message carries both values — "expected 1, got 3" is the whole diagnosis,
-- where a bare "condition was false" starts an investigation.
create or replace function tests.eq(actual text, expected text, label text) returns void
  language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL: % — expected %, got %',
      label, coalesce(quote_literal(expected), 'null'), coalesce(quote_literal(actual), 'null');
  end if;
  raise notice '   ok  % [%]', label, coalesce(actual, 'null');
end $$;

-- The most important assertion in the file. Half of what this schema promises is
-- that certain things are *refused*, and "it was refused" is not enough — RLS,
-- a check constraint, and a typo in a column name all raise. `expect` pins the
-- refusal to the reason we meant, so a test can't keep passing after the guard
-- it covers has been replaced by an unrelated error.
create or replace function tests.raises(stmt text, expect text, label text) returns void
  language plpgsql as $$
declare
  msg text;
begin
  begin
    execute stmt;
  exception when others then
    msg := sqlerrm;
    if expect is not null and position(lower(expect) in lower(msg)) = 0 then
      raise exception 'FAIL: % — raised %, which does not mention %',
        label, quote_literal(msg), quote_literal(expect);
    end if;
    raise notice '   ok  % [%]', label, left(msg, 70);
    return;
  end;
  raise exception 'FAIL: % — expected an error, the statement succeeded', label;
end $$;

-- RLS does not error on a forbidden read or a forbidden delete. It filters the
-- rows out and reports success. So "denied" is usually a row count, and reaching
-- for tests.raises() where the real behaviour is a silent zero would write a test
-- that fails for the wrong reason. supabase-adapter.js has the same problem and
-- solves it the same way — see the `.select('id')` on deleteDocument.
-- Both counters wrap the caller's statement in a CTE rather than a subquery.
-- That is not a style choice: half the interesting assertions here are about
-- writes ("this delete removes nothing", "this insert can read its own RETURNING
-- row"), and Postgres rejects a data-modifying statement inside a subquery —
-- "WITH clause containing a data-modifying statement must be at the top level".
-- A CTE at the top level accepts `insert`/`update`/`delete ... returning` and a
-- plain `select` alike, so callers pass the bare statement either way.
create or replace function tests.denied(query text, label text) returns void
  language plpgsql as $$
declare
  n bigint;
begin
  execute format('with _q as (%s) select count(*) from _q', query) into n;
  if n <> 0 then
    raise exception 'FAIL: % — expected 0 rows, got %', label, n;
  end if;
  raise notice '   ok  % [0 rows]', label;
exception
  -- "Reaches nothing" has two shapes, and the stronger one raises rather than
  -- returning an empty set. `anon` is granted no table privileges at all (see
  -- the grants note in schema.sql), so it is refused a step earlier than RLS —
  -- before any policy is consulted. Treating that as a failure would report the
  -- tightest possible outcome as a bug.
  --
  -- Only this one error. A typo'd column or a missing table still fails, which
  -- is the difference between an assertion and a rubber stamp.
  when insufficient_privilege then
    -- The message is printed rather than summarised because 42501 is not only
    -- ever "no grant". storage.protect_delete() raises it too, for a completely
    -- unrelated reason, and a fixed phrase here would have quietly reported
    -- that as a policy working correctly. Print what actually happened and let
    -- the reader see when it isn't the refusal they meant to assert.
    raise notice '   ok  % [refused before RLS: %]', label, left(sqlerrm, 60);
end $$;

create or replace function tests.visible(query text, expected bigint, label text) returns void
  language plpgsql as $$
declare
  n bigint;
begin
  execute format('with _q as (%s) select count(*) from _q', query) into n;
  if n <> expected then
    raise exception 'FAIL: % — expected % rows, got %', label, expected, n;
  end if;
  raise notice '   ok  % [% rows]', label, n;
end $$;

-- The suite runs as `authenticated` and `anon` for most of its life, so both need
-- to be able to call the assertions. These functions read no application data —
-- they execute whatever the caller hands them, under the caller's own role.
grant usage on schema tests to authenticated, anon;
grant execute on all functions in schema tests to authenticated, anon;
