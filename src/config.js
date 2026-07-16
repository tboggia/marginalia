/**
 * config.js — the one file you edit to go from "on my laptop" to "on a URL".
 *
 * Leave these blank and the app runs exactly as it does now: everything in
 * IndexedDB, one browser, no sign-in, a second tab standing in for your partner.
 * Fill them in and the same code talks to Postgres instead. Nothing else changes.
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
  supabaseUrl: 'https://sijnpxrfgsmuozhokxpv.supabase.co/rest/v1/',      // https://xxxxxxxxxxxx.supabase.co
  supabaseAnonKey: 'sb_publishable_z7wMXYCnc0ttMIu9NzJWlA_8p1x_lEf',  // the anon / publishable key — NOT service_role
};

export const isHosted = () =>
  Boolean(config.supabaseUrl && config.supabaseAnonKey);
