#!/usr/bin/env bash
# Regenerate supabase/migrations/ from the SQL files at the repo root.
#
# schema.sql and social.sql stay the source of truth — they are what you paste
# into the hosted project's SQL editor, and README "Deploying" still describes
# exactly that. This script is a build step: it copies them into the layout the
# CLI's migration runner expects, so `supabase db reset` reproduces a hosted
# database from the same bytes rather than a hand-maintained second copy that
# quietly drifts.
#
# It runs automatically at the top of ./test.sh, so the two can't fall out of
# sync between a SQL edit and a test run.
#
# One transformation is applied, and it is not cosmetic: social.sql wraps itself
# in `begin; ... commit;`. That is correct for the SQL editor, where you want the
# whole file to land or none of it. The CLI's migration runner already opens its
# own transaction per file, so an inner BEGIN warns and the inner COMMIT ends the
# runner's transaction early — leaving the migration recorded as applied whether
# or not the statements after it succeeded. Stripping the outer pair hands
# transaction control to the runner, which is where it belongs here.
#
# migration.sql is deliberately NOT included. It upgrades a pre-EPUB database
# that predates schema.sql's current shape; a database built fresh from
# schema.sql must never run it. It has no meaning against a local stack that is
# reset from empty every time, so testing it needs a hosted-shaped database that
# actually is in that old state.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
out="$here/migrations"

mkdir -p "$out"
rm -f "$out"/*.sql

banner() {
  printf '%s\n' \
    "-- GENERATED FILE — DO NOT EDIT." \
    "-- Source: $1 (repo root). Regenerate with supabase/sync-migrations.sh." \
    "-- Edit the source file; this copy is overwritten on every test run." \
    ""
}

# Timestamps only have to sort correctly and stay stable across regenerations —
# they are ordering keys, not dates. schema.sql first, then social.sql, which is
# the order README "Deploying" tells you to run them in and the order social.sql
# itself asserts in its header.
banner "schema.sql" > "$out/20260101000000_schema.sql"
cat "$root/schema.sql" >> "$out/20260101000000_schema.sql"

banner "social.sql (outer begin;/commit; stripped — see sync-migrations.sh)" \
  > "$out/20260101000010_social.sql"
# Only an exact `begin;` / `commit;` on its own line, which is the outer pair.
# The `begin` inside social.sql's DO blocks carries no semicolon and is untouched.
grep -v -x -e 'begin;' -e 'commit;' "$root/social.sql" >> "$out/20260101000010_social.sql"

# Cheap guard against the strip above silently doing nothing (or too much) after
# a future edit to social.sql's structure.
if grep -q -x -e 'begin;' -e 'commit;' "$out/20260101000010_social.sql"; then
  echo "sync-migrations: outer transaction markers survived the strip — check social.sql" >&2
  exit 1
fi

echo "sync-migrations: wrote $(ls "$out" | wc -l | tr -d ' ') migration(s) from schema.sql + social.sql"
