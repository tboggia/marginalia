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

/* ------------------------------------------------------------------ the env */

// `''` covers file:// (hostname is empty there). It won't run from file:// anyway —
// ES modules refuse — but "not a real host" is the honest reading, so treat it as local.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0', '']);

/** 'local' when served from localhost, 'production' anywhere else (GitHub Pages, a
 *  custom domain, a LAN IP you're testing from a tablet). */
export const env = LOCAL_HOSTNAMES.has(location.hostname) ? 'local' : 'production';

const hasCredentials = Boolean(config.supabaseUrl && config.supabaseAnonKey);

/* -------------------------------------------------------------- the override */
/* Hostname alone would be wrong in both directions: you can't smoke-test the real
   backend before pushing, and you can't demo local mode from the deployed URL. So
   `?backend=supabase` / `?backend=local` wins over the hostname when present.

   It's held in sessionStorage rather than read from the URL each time because the URL
   doesn't survive: app.js strips the query string with replaceState() after handling
   ?join=, and the magic-link round trip bounces through Supabase and back. Per-tab, so
   two tabs can sit in two different modes, and it's gone when the tab closes. */
const OVERRIDE_KEY = 'marginalia:backend';

function readOverride() {
  let value = null;
  try {
    const asked = new URLSearchParams(location.search).get('backend');
    if (asked === 'supabase' || asked === 'local') {
      sessionStorage.setItem(OVERRIDE_KEY, asked);
      value = asked;
    } else {
      value = sessionStorage.getItem(OVERRIDE_KEY);
    }
  } catch {
    // Safari in private mode throws on sessionStorage. Fall back to the hostname.
    return null;
  }
  return value === 'supabase' || value === 'local' ? value : null;
}

const override = readOverride();

/* ------------------------------------------------------------------ the mode */
/* Hosted needs credentials, always — an override can't conjure a project that isn't
   configured. Given credentials, deployed means hosted and local means local, because
   the thing you almost always want on localhost is the fast no-sign-in loop and the
   ?me= two-tab flow. Ask for the other one explicitly. */
export const isHosted = () => {
  if (!hasCredentials) return false;
  if (override) return override === 'supabase';
  return env === 'production';
};

/** For the console and the footer: 'local · IndexedDB' vs 'production · Supabase',
 *  plus a marker when an override is doing the deciding. Guessing which mode you're
 *  in is the source of most "why is it asking me to sign in" confusion. */
export const describeEnv = () =>
  `${env} · ${isHosted() ? 'Supabase' : 'IndexedDB'}${override ? ` (?backend=${override})` : ''}`;
