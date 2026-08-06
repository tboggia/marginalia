/**
 * config.js — credentials, and the local-vs-deployed switch.
 *
 * There is no build step, so there are no environment variables in the usual sense:
 * nothing substitutes values at deploy time, and `process.env` doesn't exist in a
 * browser. The runtime equivalent is the hostname the app was actually served from,
 * which is what `env` below reads. Same files on your laptop and on GitHub Pages;
 * they just notice where they landed.
 *
 * The anon key belongs in here in plain text and belongs in your git history. It is
 * a public key — it identifies the project, it doesn't authorize anything. Every
 * actual permission is decided by the RLS policies in schema.sql, server-side, on
 * every single query. If leaking this key would matter, the policies are wrong.
 *
 * The key that must never appear here is the *service_role* key, which bypasses RLS
 * entirely. It has no business in a browser. Supabase shows both on the same settings
 * page, one above the other, which is how they end up in the wrong place.
 */
export const config = {
  supabaseUrl: 'https://sijnpxrfgsmuozhokxpv.supabase.co',      // https://xxxxxxxxxxxx.supabase.co
  supabaseAnonKey: 'sb_publishable_z7wMXYCnc0ttMIu9NzJWlA_8p1x_lEf',  // the anon / publishable key — NOT service_role
};

/* ------------------------------------------------------------ the local stack */
/* A third target, alongside "IndexedDB" and "the real project": Postgres, auth,
   realtime and storage running on this machine under `supabase start`. It exists so
   the backend can be exercised — magic links, invites, three accounts sharing a book,
   RLS actually refusing things — without touching the hosted project or waiting on
   a real inbox. See supabase/config.toml and ./test.sh.

   These two values are the CLI's fixed local defaults, not secrets: the same pair
   appears in every Supabase quickstart, the API only listens on 127.0.0.1, and the
   database it guards is thrown away by `supabase db reset`. Newer CLI versions have
   changed the key *format* at least once, so if hosted mode works and local doesn't,
   check these against `supabase status` first — ./test.sh compares them for you and
   warns on a mismatch rather than letting you debug an auth error that is really a
   stale constant. */
const LOCAL_STACK = {
  supabaseUrl: 'http://127.0.0.1:54321',
  supabaseAnonKey:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
};

/* ------------------------------------------------------------------ the env */

// `''` covers file:// (hostname is empty there). It won't run from file:// anyway —
// ES modules refuse — but "not a real host" is the honest reading, so treat it as local.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0', '']);

/** 'local' when served from localhost, 'production' anywhere else (GitHub Pages, a
 *  custom domain, a LAN IP you're testing from a tablet). */
export const env = LOCAL_HOSTNAMES.has(location.hostname) ? 'local' : 'production';

/* -------------------------------------------------------------- the override */
/* Hostname alone would be wrong in both directions: you can't smoke-test the real
   backend before pushing, and you can't demo local mode from the deployed URL. So
   an explicit `?backend=` wins over the hostname when present.

     ?backend=local           IndexedDB, no sign-in, the ?me= multi-tab flow
     ?backend=supabase        the hosted project named above — unchanged, and still
                              the right thing for a last check before pushing
     ?backend=supabase-local  the stack running under `supabase start`

   `supabase` deliberately still means *hosted* even on localhost, because that is
   what it has always meant and what README "Hosted" documents. The local stack is a
   new third door rather than a quiet redefinition of an existing one — the failure
   mode of getting that wrong is testing against the wrong database and believing the
   result.

   Held in sessionStorage rather than read from the URL each time because the URL
   doesn't survive: app.js strips the query string with replaceState() after handling
   ?join=, and the magic-link round trip bounces through Supabase and back. Per-tab, so
   two tabs can sit in two different modes, and it's gone when the tab closes. */
const OVERRIDE_KEY = 'marginalia:backend';
const BACKENDS = new Set(['local', 'supabase', 'supabase-local']);

function readOverride() {
  let value = null;
  try {
    const asked = new URLSearchParams(location.search).get('backend');
    if (BACKENDS.has(asked)) {
      sessionStorage.setItem(OVERRIDE_KEY, asked);
      value = asked;
    } else {
      value = sessionStorage.getItem(OVERRIDE_KEY);
    }
  } catch {
    // Safari in private mode throws on sessionStorage. Fall back to the hostname.
    return null;
  }
  return BACKENDS.has(value) ? value : null;
}

const override = readOverride();

/* ------------------------------------------------------------ which project */
/* Only ever the local stack when you asked for it by name. Nothing infers it from
   the hostname: plenty of hosted testing happens on localhost, and silently pointing
   that at an empty local database would look exactly like "all my books vanished". */
const useLocalStack = override === 'supabase-local';

if (useLocalStack) {
  config.supabaseUrl = LOCAL_STACK.supabaseUrl;
  config.supabaseAnonKey = LOCAL_STACK.supabaseAnonKey;
}

const hasCredentials = Boolean(config.supabaseUrl && config.supabaseAnonKey);

/* ------------------------------------------------------------------ the mode */
/* Hosted needs credentials, always — an override can't conjure a project that isn't
   configured. Given credentials, deployed means hosted and local means local, because
   the thing you almost always want on localhost is the fast no-sign-in loop and the
   ?me= two-tab flow. Ask for the other one explicitly. */
export const isHosted = () => {
  if (!hasCredentials) return false;
  if (override) return override !== 'local';
  return env === 'production';
};

/** For the console and the footer: 'local · IndexedDB' vs 'production · Supabase',
 *  plus a marker when an override is doing the deciding. Guessing which mode you're
 *  in is the source of most "why is it asking me to sign in" confusion — and with a
 *  third backend it matters more, not less: hosted and local-stack are both "Supabase"
 *  and look identical until you notice one of them has none of your books in it. */
export const describeEnv = () => {
  const backend = isHosted()
    ? (useLocalStack ? 'Supabase (local stack)' : 'Supabase')
    : 'IndexedDB';
  return `${env} · ${backend}${override ? ` (?backend=${override})` : ''}`;
};
