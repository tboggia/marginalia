#!/usr/bin/env bash
# ./test.sh — run the SQL suite against the local Supabase stack.
#
#   ./test.sh              reset the database, then run every test
#   ./test.sh --no-reset   run the tests against the database as it stands
#   ./test.sh 03           run only the files whose name starts with 03
#
# The reset is the default because the suite asserts on seeded fixtures and on
# structural properties of a freshly migrated database. Skipping it is for the
# loop where you are editing one test file, not for deciding whether the schema
# is sound.
#
# Every test file wraps itself in begin/rollback, so nothing a test writes
# survives it. The reset is about migrations and seed data, not test isolation.

set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$root"

DB_URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"

reset=1
filter=""
for arg in "$@"; do
  case "$arg" in
    --no-reset) reset=0 ;;
    -h|--help)  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)          filter="$arg" ;;
  esac
done

bold=$'\033[1m'; red=$'\033[31m'; green=$'\033[32m'; yellow=$'\033[33m'; off=$'\033[0m'
note() { printf '%s\n' "$*" >&2; }
die()  { printf '%s%s%s\n' "$red" "$*" "$off" >&2; exit 1; }

# ------------------------------------------------------------------ preflight
# Two installers in this toolchain put their binaries somewhere PATH doesn't
# look: Docker Desktop drops docker in ~/.docker/bin without editing any shell
# rc, and Homebrew's postgresql@18 is keg-only so nothing is linked. Both then
# fail as "command not found", which reads as "not installed" or — worse, if you
# only test the daemon — "not running". Find them before concluding anything.
#
# Exported, not just set, because the supabase CLI shells out to docker itself.
want() {                       # want <binary> <dir>...
  local bin="$1"; shift
  command -v "$bin" >/dev/null 2>&1 && return 0
  local d
  for d in "$@"; do
    if [ -x "$d/$bin" ]; then
      PATH="$d:$PATH"; export PATH
      note "${yellow}note: found $bin in $d, which is not on your PATH. Using it for this run.${off}"
      return 0
    fi
  done
  return 1
}

want docker \
  "$HOME/.docker/bin" \
  "/Applications/Docker.app/Contents/Resources/bin" \
  "$HOME/.orbstack/bin" \
  /usr/local/bin /opt/homebrew/bin \
  || die \
"docker not found — not on PATH, and not in any of the usual install locations.

If Docker Desktop is installed, its CLI lives in ~/.docker/bin. Add it
permanently with:

    echo 'export PATH=\"\$HOME/.docker/bin:\$PATH\"' >> ~/.zshrc"

# Separate check, separate message: the binary existing tells you nothing about
# whether the daemon is up.
docker info >/dev/null 2>&1 || die \
"docker is installed but the daemon isn't answering. Start Docker Desktop (or
OrbStack) and wait for it to finish starting, then try again."

command -v supabase >/dev/null 2>&1 || die "supabase CLI not found. brew install supabase/tap/supabase"

want psql /opt/homebrew/opt/postgresql@18/bin /usr/local/opt/postgresql@18/bin || die \
"psql not found. Homebrew's postgresql@18 is keg-only, so its binaries are not
linked onto PATH:

    export PATH=\"/opt/homebrew/opt/postgresql@18/bin:\$PATH\"

That server is not the one being tested — the stack runs its own Postgres in
Docker on 54322. This is only about having a client to talk to it with."

if ! supabase status >/dev/null 2>&1; then
  note "${yellow}The local stack isn't up. Starting it — first run pulls images and takes a few minutes.${off}"
  # The images come from public.ecr.aws, which throttles anonymous pulls hard
  # enough that a cold start routinely dies partway with "toomanyrequests: Rate
  # exceeded". It is transient and per-IP, and every attempt keeps the layers it
  # already got, so retrying walks the remaining images down rather than
  # starting over. Nothing here is idempotency-sensitive: `supabase start` on a
  # half-started stack picks up where it stopped.
  started=0
  for attempt in 1 2 3 4 5; do
    if supabase start; then started=1; break; fi
    if [ "$attempt" -lt 5 ]; then
      note "${yellow}Image pull was throttled (attempt ${attempt}/5). Waiting 30s and resuming — already-pulled layers are kept.${off}"
      sleep 30
    fi
  done
  [ "$started" = 1 ] || die \
"supabase start failed after 5 attempts.

If the errors were 'toomanyrequests: Rate exceeded', that is the registry
throttling anonymous pulls, not a problem with this repo. Either wait a few
minutes and re-run, or authenticate to raise the limit:

    docker login

Once the images are cached locally, later runs don't pull at all."
fi

# ------------------------------------------------- config.js key sanity check
# Not a test, a courtesy. If these drift, hosted mode keeps working and local
# mode fails with an auth error that points at everything except the stale
# constant it actually is.
config_key="$(grep -o "eyJ[A-Za-z0-9_.-]\{20,\}\|sb_publishable_[A-Za-z0-9_-]\{8,\}" src/config.js | tail -1)"
live_key="$(supabase status -o env 2>/dev/null | sed -n 's/^ANON_KEY="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p')"
if [ -n "$live_key" ] && [ -n "$config_key" ] && [ "$live_key" != "$config_key" ]; then
  note "${yellow}note: LOCAL_STACK.supabaseAnonKey in src/config.js does not match this CLI's anon key."
  note "      Browser testing with ?backend=supabase-local will fail until you paste in:"
  note "      $live_key${off}"
fi

# --------------------------------------------------------------------- reset
./supabase/sync-migrations.sh || die "migration sync failed."

if [ "$reset" = 1 ]; then
  note ""
  note "${bold}Resetting the database (migrations + seed)…${off}"
  supabase db reset || die "supabase db reset failed — the migrations did not apply cleanly."
fi

# ------------------------------------------------------------------ the suite
# Results go to /dev/null and NOTICEs go to stderr, so what you see is the
# assertions rather than a page of one-row SELECT output.
run() {
  psql "$DB_URL" -v ON_ERROR_STOP=1 --quiet --no-psqlrc -o /dev/null -f "$1"
}

note ""
note "${bold}Loading helpers…${off}"
run tests/00_helpers.sql || die "tests/00_helpers.sql failed to load."

pass=0; fail=0; failed_files=()
for f in tests/[0-9]*.sql; do
  case "$f" in tests/00_*) continue ;; esac
  [ -n "$filter" ] && case "$(basename "$f")" in "$filter"*) ;; *) continue ;; esac

  note ""
  note "${bold}$(basename "$f")${off}"
  if run "$f"; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1)); failed_files+=("$f")
    note "${red}   ^ this file failed — the message above is the first failing assertion${off}"
  fi
done

# ------------------------------------------------------------------- summary
note ""
if [ "$fail" -eq 0 ] && [ "$pass" -gt 0 ]; then
  note "${green}${bold}${pass} file(s) passed.${off}"
  note ""
  note "That covers the SQL: policies, RPCs, constraints, and the structural"
  note "settings that fail silently. It does not cover the browser half — the"
  note "adapter, magic-link sign-in, the realtime socket, or signed-URL"
  note "streaming. See tests/MANUAL.md for what still needs a person."
  exit 0
elif [ "$pass" -eq 0 ] && [ "$fail" -eq 0 ]; then
  die "No test files matched${filter:+ \"$filter\"}."
else
  note "${red}${bold}${fail} file(s) failed, ${pass} passed:${off}"
  for f in "${failed_files[@]}"; do note "${red}  $f${off}"; done
  note ""
  note "Re-run one file on its own to iterate:  ./test.sh $(basename "${failed_files[0]}" | cut -c1-2) --no-reset"
  exit 1
fi
