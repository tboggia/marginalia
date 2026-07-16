# Deploying

About 30 minutes, most of it waiting on Supabase. Free tier covers two people reading
books by roughly four orders of magnitude.

The order matters: **do the backend first.** Static hosting takes five minutes and is
the easy half, but a URL with no backend gives you and your partner two separate
private libraries that share nothing. It'll look like it works. It won't.

---

## 1. Supabase (the half that matters)

1. Create a project at [supabase.com](https://supabase.com). Save the database
   password somewhere; you won't need it for this, but you'll want it eventually.
2. **SQL Editor** → paste all of `schema.sql` → Run. It should report success with no
   rows. This creates four tables, ten RLS policies, and the invite functions.
3. **Storage** → New bucket → name it `books` → **leave "Public bucket" OFF.** If you
   turn it on, anyone who guesses a filename downloads your books, and the storage
   policies in `schema.sql` become decoration.
4. **Authentication → URL Configuration** → set **Site URL** to your deployed URL, and
   add it to **Redirect URLs** too. Magic links bounce to the site root if the URL
   they were issued for isn't listed. This is the single most common thing to get
   wrong, and it fails quietly.
5. **Project Settings → API** → copy the **Project URL** and the **anon / publishable**
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
reset role;
```

Then sign in as a third account in a private window and confirm you can't see the book.

---

## 2. Static hosting

Any static host. The app is plain files — no build, no server, no Node.

**Cloudflare Pages / Netlify:** drag the `shared-reader` folder onto their deploy page.
Done. Set a custom domain if you want a URL you can remember.

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
bandwidth limit. Irrelevant for two people and a few hundred KB of JS — as long as the
books stay out of the repo. If you commit a 40 MB scan and both re-read it, you're
suddenly using Pages as a CDN for a book, which is both against the point and against
the terms.

---

## 3. Reading together

1. You sign in, upload the PDF or EPUB, hit **Invite**, and send the link.
2. Your partner opens it, signs in, and lands in the book.
3. The link is now spent. `join_document` caps a book at two readers, so a leaked
   link opens nothing once you're both in. If a link leaks *before* they use it,
   `select rotate_invite('<document-id>')` issues a new one — it kicks nobody out,
   it only stops future joins.

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

---

## Before you put a real book in it

- **Rate-limit `join_document`.** It's the one function reachable by any signed-in
  user, and it's a guessing oracle. 64 bits is a lot to guess, but Supabase's
  built-in rate limits are worth turning on.
- **Turn off public sign-ups**, or anyone can make an account on your project. They
  can't see your books — RLS handles that — but they're in your user table and your
  quota. Authentication → Providers → email → disable sign-ups once you've both
  registered. This is the cheapest security win available.
- **Storage has no quota per user.** It's you and one other person, so this is fine
  until it isn't.
