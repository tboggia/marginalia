# Deploying

About 30 minutes, most of it waiting on Supabase. Free tier covers a small reading
group by roughly four orders of magnitude.

The order matters: **do the backend first.** Static hosting takes five minutes and is
the easy half, but a URL with no backend gives everyone their own separate private
library that shares nothing. It'll look like it works. It won't.

---

## 1. Supabase (the half that matters)

1. Create a project at [supabase.com](https://supabase.com). Save the database
   password somewhere; you won't need it for this, but you'll want it eventually.
2. **SQL Editor** → paste all of `schema.sql` → Run. It should report success with no
   rows. This creates the reader's own tables, RLS policies, and storage policies.
3. **SQL Editor** → paste all of `social.sql` → Run, in a second statement after
   `schema.sql` has already run. This adds `profiles`, `connections`, `invites`, the
   sharing and revocation functions, and the realtime fix described below. Bringing an
   existing pre-social database forward: run `migration.sql` first if you haven't
   already (it predates invites entirely), then `social.sql` — it detects which case
   you're in and adjusts what it migrates accordingly.
4. **Storage** → New bucket → name it `books` → **leave "Public bucket" OFF.** If you
   turn it on, anyone who guesses a filename downloads your books, and the storage
   policies in `schema.sql` become decoration.
5. **Authentication → URL Configuration** → set **Site URL** to your deployed URL, and
   add it to **Redirect URLs** too. Magic links bounce to the site root if the URL
   they were issued for isn't listed. This is the single most common thing to get
   wrong, and it fails quietly.
6. **Project Settings → API** → copy the **Project URL** and the **anon / publishable**
   key into `src/config.js`.

> **The `anon` key is public and belongs in your git history.** It identifies the
> project; it authorizes nothing. Permissions are decided by RLS, server-side, on
> every query.
>
> **The `service_role` key bypasses RLS completely and must never touch a browser.**
> Supabase shows both keys on the same page, one under the other. That is how they
> end up in the wrong place.

### Check the policies before you trust them

Worth ten minutes, because an over-permissive `using` clause doesn't error — it just
works, for everyone, forever. In the SQL editor:

```sql
-- Should return zero rows. If it returns your annotations, RLS is off somewhere.
set role anon;
select * from annotations;
select * from profiles;
select * from connections;
reset role;
```

Then sign in as a third account in a private window and confirm you can't see the book
until you're actually shared into it — and that you can't see someone's profile or
connections unless you're connected to them or share a book with them.

Two Postgres-side checks worth running once, since a missing one fails silently rather
than with an error:

```sql
-- Should return 'f' for all four. A row here means the realtime socket is broadcasting
-- that table's changes to every subscriber regardless of RLS.
select relname, relreplident = 'f' as full_identity
from pg_class where relname in ('annotations','progress','memberships','connections');
```

```sql
-- redeem_invite, share_document, and revoke_share should all show prosecdef = true
-- (security definer). If any come back false, RLS applies to the function's own
-- queries and it will 403 on the exact gap it exists to cross.
select proname, prosecdef from pg_proc
where proname in ('redeem_invite','share_document','revoke_share','merge_documents');
```

---

## 2. Static hosting

Any static host. The app is plain files — no build, no server, no Node.

**Cloudflare Pages / Netlify:** drag this folder onto their deploy page. Done. Set a
custom domain if you want a URL you can remember.

**GitHub Pages:** see the section below — it has a couple of specifics worth knowing.

**Your own box:** `python3 -m http.server` behind Caddy or nginx. It must be **HTTPS** —
`navigator.clipboard` (the invite button) and service workers both require a secure
context. `localhost` is exempt; your VPS's bare IP is not.

Nothing here needs a build step, but if you later add one, that's the moment to move
`config.js` to an env var. Not before — you'd be protecting a public key.

---

## 2b. GitHub Pages specifically

It's a good fit: Pages serves static files, and this app is static files. No build step,
no Actions workflow needed. Push and set Settings → Pages → deploy from branch → `main`
→ `/ (root)`. Your URL is `https://<you>.github.io/<repo>/`.

Two files in this folder exist for Pages:

- **`.nojekyll`** — empty, and must stay empty. It's a flag. Pages runs everything
  through Jekyll by default, which silently drops files and folders beginning with `_`.
  Nothing here starts with `_` today; this stops that from becoming a mystery later.
- **`.gitignore`** — excludes `*.pdf` and `*.epub`. Read the comment in it before you
  override that.

### The subpath is already handled

Project sites live at `/<repo>/`, not `/`. That prefix is what usually breaks a static
app. This one is fine: every path in `index.html` and every import is relative, and the
invite link is built from `location.origin + location.pathname`, so it comes out as
`https://you.github.io/marginalia/?join=...` rather than dropping the repo name.
Verified under a simulated subpath. Don't "fix" either of those into an absolute `/`.

If you use the `<you>.github.io` repo instead of a project repo, you're at the root and
none of this applies.

### Free plan means a public repo

Pages is free for public repositories; private repos need Pro or above. Note that
**the published site is public either way** — even on Pro, `config.js` is downloadable
by anyone who visits. That's fine. It holds the anon key, which is public by design, and
RLS is what actually stops strangers reading your margin.

What a public repo *does* change:

- **Never commit the book.** `.gitignore` covers PDF and EPUB. A public repo makes a
  committed book a copyrighted work published to the internet under your name, and git
  history keeps it after you delete the file. Books go in the Supabase bucket.
- **Never commit `service_role`.** Same reason, much worse. It bypasses RLS. If it ever
  lands in a public repo, rotate it in Supabase immediately — scrubbing the history is
  not enough, because public repos are scraped for keys within minutes.

### Set the Supabase URLs to the full path

In Authentication → URL Configuration, Site URL and Redirect URLs must include the repo
path and the trailing slash:

```
https://<you>.github.io/<repo>/
```

Not `https://<you>.github.io`. A magic link issued for a URL that isn't listed bounces to
the root and 404s, with no error explaining why. This is the single most likely thing to
cost you an evening.

HTTPS is on by default on `github.io`, so the clipboard-based invite button works.

### Limits

A recommended 1 GB repo limit, a 1 GB published-site limit, and a soft 100 GB/month
bandwidth limit. Irrelevant for a small reading group and a few hundred KB of JS — as
long as the books stay out of the repo. If you commit a 40 MB scan and everyone
re-reads it, you're suddenly using Pages as a CDN for a book, which is both against the
point and against the terms.

---

## 3. Reading together

There's no cap on readers anymore, and two things are worth telling people before they
use it: only the person who adds a book decides who else reads it, and links are
single-use with a two-week expiry rather than living forever.

**Sharing a book you added:**

1. Sign in, upload the PDF or EPUB, hit **Invite**.
2. If the person you want is already in your People list, add them straight from the
   share sheet — no link needed. Otherwise, **Copy invite link** and send it.
3. They open it, sign in, and land in the book. The link is now spent — a second click
   on it is refused with a readable message, not a silent no-op. If it leaks before
   they use it, open the share sheet and copy a fresh one; the old one just expires.

**Connecting without sharing a book yet:** the **People** button (next to "Add a book")
has its own "Invite someone" link. Whoever opens it is connected to you with nothing
shared — connecting is the handshake, sharing a specific book is a separate step from
the share sheet once you're connected.

**Being shared a book you didn't add:** you can read, highlight, and leave whenever you
like, but you can't invite anyone else into it or remove another reader — only the owner
can. The share sheet shows you which one you are.

**The same book twice:** if you add a book someone has already shared with you, and the
files are byte-identical, your shelf offers a merge — your copy folds into theirs and
every highlight either of you made lands exactly where it already was. Different scans
of the same title are never merged.

---

## What you'll hit

| Symptom | Cause |
|---|---|
| Magic link lands on the site root, not the book | The URL isn't in **Redirect URLs**. Add it including the path. |
| Sign-in works, book list is empty | Uploaded before the membership row was written. Check `memberships`. |
| Book 404s or hangs on load | Bucket isn't named `books`, or the storage policies didn't run. |
| EPUB downloads but never renders | The fetch of the signed URL failed — check the console for a CORS or 4xx error. The app deliberately downloads the bytes itself and hands epub.js an ArrayBuffer: given a URL ending in `.epub?token=...`, epub.js misreads the query string and treats the book as an unpacked directory, requesting `META-INF/container.xml` from the wrong path. Don't "simplify" it back to passing the URL. |
| Highlights save but the other person never sees them | Realtime isn't publishing. Re-run the `alter publication` lines. |
| Realtime works but leaks | `replica identity full` didn't run. Without it the socket ignores RLS. |
| Invite button does nothing | Not HTTPS. Clipboard needs a secure context; it falls back to a prompt. |
| Invite button is greyed out, with a tooltip | You're not the owner of the open book. Only the person who added it can share it — ask them, or use the share sheet's "Add someone you're connected to" if you're already connected and they've shared it with you. |
| "That invite link has already been used" on a link that's never been clicked | It's expired (two weeks by default) or was revoked. Mint a new one from the share sheet. |
| Someone you removed gets back in on their old link | Shouldn't happen — `redeem_invite` checks for a revoked membership before honoring a link. If it does, `social.sql` didn't fully apply; re-run it. |
| The merge banner never appears for an obvious duplicate | `find_my_duplicates` only matches on exact `sha256`. Two different scans of the same title, or a re-exported PDF, are different bytes and are never offered a merge — this is intentional, not a bug. |

---

## Before you put a real book in it

- **Rate-limit `redeem_invite`.** It's the one function reachable by any signed-in
  user with nothing but a guessed string, and it's a guessing oracle. 64 bits is a
  lot to guess, but Supabase's built-in rate limits are worth turning on.
- **Public sign-ups have to stay on.** This is a real change from the two-person
  design, which used to recommend disabling them once both people had registered —
  that advice now directly breaks the product: every new person you invite, connect
  or share a book with needs to be able to create an account first. RLS is what
  actually keeps a stranger with an account from seeing your books, not a closed
  signup form — an account with no membership row sees nothing, same as before.
  If you want to restrict *who* can sign up at all (not just who can see your
  books), Supabase supports allow-listing by email domain under Authentication →
  Providers → email, which doesn't have this problem.
- **Storage has no quota per user.** Fine for a household or a small reading group;
  worth watching once a book is genuinely shared with more than a couple of people.
