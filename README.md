# Marginalia

A PDF and EPUB reader for people who aren't in the same room, reading together.

Each of you keeps your own place. Each of you has a color. Highlights and typed notes
show up in everyone's copy — stylus ink too, on PDFs. A rail down the left edge shows the
whole book with every reader on it and how far apart you all are.

A book starts with just you. Whoever adds it owns it, and only they decide who else can
read along — everyone else can leave, but only the owner can invite or remove. See
"Reading with other people" below for how sharing and connections actually work.


## Two modes

Nothing else changes between them. That's what the store adapter is for.

**Which one you get is decided by where the app is served from.** There's no build step,
so there are no environment variables in the usual sense — `src/config.js` reads
`location.hostname` instead, which is the runtime equivalent:

| Served from | Mode | Identity |
|---|---|---|
| `localhost` / `127.0.0.1` | Local — IndexedDB | `?me=` query param |
| anything else (GitHub Pages, a custom domain, a LAN IP) | Hosted — Supabase | the signed-in session |

Hosted also requires credentials in `src/config.js`; without them you get local mode
everywhere, which is what a fresh clone does.

To force one explicitly — testing the real backend before pushing, or demoing local mode
from the deployed URL — add `?backend=supabase` or `?backend=local`. It sticks for the rest
of the tab (`sessionStorage`), because the URL doesn't survive: the app strips the query
string after handling `?join=`, and the magic-link round trip bounces through Supabase and
back. Open a new tab to drop it.

The console logs which mode it picked on every boot (`Marginalia: local · IndexedDB`).

### Local (default on localhost)
Everything in IndexedDB, one browser, no sign-in. Good for trying it, and for building on.


#### Run it

No build step, but it does need to be served (ES modules don't load from `file://`):

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Drop in a DRM-free PDF or EPUB. Everything lives in IndexedDB on your machine until you
connect a backend.

#### Be several people

Identity comes from a `?me=` parameter, so each tab is its own reader:

- `http://localhost:8000/?me=ash`
- `http://localhost:8000/?me=robin`
- `http://localhost:8000/?me=jules`

Open the same book in all of them. Highlight in one and watch it land in the rest. A
`BroadcastChannel` stands in for the realtime socket, so the multi-reader flow is real
before the backend exists — same code path, different transport. Local mode has no
concept of invites or connections (there's only ever one browser), so every `?me=` tab
just joins the book directly — the People screen and share sheet are inert here, with a
"needs a backend" message where they'd otherwise do something.

**`?me=` is local-mode only.** In hosted mode identity comes from the signed-in session,
and the parameter is ignored (with a console warning) — a silently-ignored `?me=` looks
exactly like a broken sign-in. If you're on a deployed URL and want the multi-tab flow, add
`?backend=local`.

### Hosted (default on any deployed URL)
The same code talks to Postgres — sign-in, real sync across devices, invite links,
sharing a book with more than one other person. Fill in `src/config.js` and see
"Deploying" below. Live version at
[tboggia.github.io/marginalia](https://tboggia.github.io/marginalia/).

To exercise it from your laptop before pushing, open
`http://localhost:8000/?backend=supabase`. Note that magic-link sign-in will only complete
if `http://localhost:8000` is listed under Supabase's Authentication → URL Configuration →
Redirect URLs.


## Reading with other people

Hosted mode only — this whole section is inert in local mode, since there's only ever
one browser and no accounts to connect.

Two ideas, kept separate on purpose: a **connection** links two accounts and shares no
book; a **grant** shares one specific book with someone you're already connected to.
Connecting alone gets you nothing to read — it's the handshake that makes grants
possible, and it's why removing someone from a book doesn't have to mean disconnecting
from them entirely, or the other way round.

**People** (the button beside "Add a book") is where connections live. Send an invite
link from there and whoever opens it is connected to you — no book attached. Each
person's row shows how many books you actually hold in common; open it to see which
ones.

**Invite**, inside a book, shares that specific book. It's owner-only: whoever added the
book is the only one who can add or remove other readers. Everyone else can leave, but
can't invite anyone else in, and can't remove another reader — the share sheet (the same
Invite button) shows you which one you are. If the person you're inviting is already
connected to you, you can add them straight from the share sheet with no link at all.

**Leaving a book** — by choice, or removed by the owner — asks one question: do your
highlights stay? *Leave them* keeps your marks visible to everyone still reading, though
you stop seeing anyone else's and they stop seeing yours. *Take them* hides them from
everyone else, reversibly — nothing is deleted, and sharing the book with you again
brings every one of them straight back, along with your old reading position.

**The same book, twice.** If you add a book someone else has already added, and the two
files are byte-identical, you'll be offered a merge on your shelf — your copy folds into
theirs, every highlight either of you made lands exactly where it already was, because
the bytes are the same. Two different scans of the same title are never merged; the app
says so rather than silently putting your highlights on the wrong words. See "Backend
architecture" below for why identical bytes is the whole safety argument.

**Invite links expire.** Two weeks, one use, by default — there's no cap on how many
readers a book can hold anymore, so unlike the old two-reader design, a spent link isn't
automatically harmless. If one leaks before it's used, the share sheet can mint another;
the old one just stops working.


## Controls

| | |
|---|---|
| `V` | Select — drag over text, pick a color, or add a note |
| Click a highlight | Opens it — read or edit the note, or **Remove highlight** |
| `×` in the margin | Removes that highlight. Your own only, and it removes it for everyone reading |
| `D` | Draw — for a mouse or trackpad. PDF only, see below |
| `E` | Erase — your own ink only. PDF only, see below |
| A stylus | Always draws, in any mode. You didn't pick it up to scroll. |
| A finger | Always scrolls, in any mode. This is also why palms are rejected. |

## What's real and what isn't

**Working, and tested in a real browser:** rendering, virtualized scroll (a 900-page book
keeps ~5 canvases alive), per-reader progress with restore, text selection → highlights,
notes, stylus ink with pressure, erase, per-reader color, the spine, and live sync between
two readers via `BroadcastChannel` in local mode.

**Written, and structurally verified, but never run against a live project:** the
Supabase backend, `schema.sql` and `social.sql` both. Every statement parses against
PostgreSQL's own grammar and the app boots cleanly in hosted mode (auth gate, adapter
load, invite handling all exercised against a fake project), and the group-spread rail
math (the part that draws the gap between more than two readers) is checked against the
old two-person code across 200,000 randomized cases and is exactly equivalent at N=2. But
no query in either file has hit a real database, and nobody has watched three real
accounts share a book at once. Assume an afternoon of small breakage on first run — check
the RLS by hand and run through the checks under "Deploying" below before trusting it
with a real book.

**Known gaps:** scanned PDFs with no text layer can be inked but not highlighted — see
"Books with no text layer" below for what the reader does about it. Highlights stop at the page edge (PDF) or
the chapter edge (EPUB). No undo beyond deleting. **No ink on EPUB, by design, not an
oversight:** ink's whole value is that every reader sees a stroke in exactly the same
place, which is mechanical and free on a fixed PDF page (you're all looking at the same
bitmap) and isn't well-defined on reflowable text — there's no shared notion of "the same
place" once font size or window width can differ between readers. No mainstream EPUB
reader (Kindle, Apple Books, Play Books) offers freehand ink on reflowable books either.
Highlights and notes work fully on EPUB; only stylus ink is PDF-only. Highlight anchors
(PDF rects, PDF text-item indexes, EPUB CFIs) are properties of one specific file, so they
never transfer between two different scans of the same book — see "The same book, twice"
above for the one case that's safe (byte-identical files) and what happens otherwise.

## Books with no text layer

A scan is pictures of words. There's nothing in it to select, so there's nothing to
highlight or note — only to ink. The reader says so three times, at three scales,
because one check can't cover every book:

| Scale | What you see | When |
|---|---|---|
| The book | A strip under the toolbar: *"This scan has no text layer…"*. Select goes grey the way Draw does on EPUB, and Draw takes over. | On open, if a sample of pages comes back with no text at all |
| The page | `IMAGE ONLY` in the gutter beside the page number | Whenever a page renders with no selectable text |
| The gesture | A card where the cursor lifted: *"Nothing to select here"*, with a Draw button | On a drag over a text-less page in a book that does have text elsewhere |

The book-level check (`reader.probeText`) samples six pages rather than reading all of
them, and returns true the moment it finds text — so a normal book stops after page 1,
already parsed, and only an actual scan pays for all six. It's biased toward saying
"has text" on purpose: a scan whose title page carries one OCR'd line gets no strip,
and the per-gesture card picks it up instead. The opposite error would tell you your
book can't be highlighted when it can.

The test for "has text" is *any item with a non-whitespace string* — not the item
count. A scan run through a failed OCR pass emits plenty of items whose text is empty,
which is how a page ends up looking texty to a counter and selecting like a photograph.

## Backend architecture

Hosted mode is Postgres tables, RLS, one storage bucket, and a set of security-definer
functions — `schema.sql` for the reader itself, `social.sql` for connections, sharing,
and merging duplicates. This section is the "why"; those two files are the "what," and
"Deploying" below is the "how do I stand one up." Run `schema.sql` first, then `social.sql`.

### Data model

```
-- schema.sql
documents    (id, title, storage_path, sha256, format, epub_locations, created_by)
memberships  (document_id, user_id, display_name, color,
              shared_by, revoked_at, left_marks)                  — PK(document_id, user_id)
progress     (document_id, user_id, page, y_frac, cfi, percent)   — PK(document_id, user_id)
annotations  (id, document_id, user_id, type, color, rects, strokes, text, cfi, note,
              deleted_at, hidden_at)

-- social.sql
profiles     (user_id, display_name, color)                       — PK(user_id)
connections  (user_a, user_b, requested_by, status)                — PK(user_a, user_b), user_a < user_b
invites      (code, created_by, kind, document_id, max_uses, uses, expires_at, revoked_at)
```

- **One `annotations` table, not three.** Highlights and ink are one row shape with nullable
  columns, because the read pattern is always "everything on page N (or spine index N)" — three
  tables would mean three queries and a client-side merge for no benefit.
- **`progress` is one row per `(document, user)`, upserted in place.** That row *is* the "keep
  my place" feature — no history, just the last known position. PDF locates with `page` +
  `y_frac`; EPUB has no fixed page, so it locates with a `cfi` instead. The
  `progress_locator_matches` constraint enforces "exactly one of the two," so a row can never
  claim both.
- **`sha256` on `documents`.** Two different scans of the same title get two rows on purpose —
  every stored anchor (rects, text_anchor, cfi) is a property of one specific file, so merging
  across a hash mismatch would silently render highlights in the wrong place. `merge_documents`
  (in `social.sql`) re-checks the hash itself before touching a row, rather than trusting a
  client that already claimed a match.
- **`epub_locations` caches `book.locations.save()`.** The character-index walk that backs
  `percentageFromCfi`/`cfiFromPercentage` is a full-book pass — caching it means paying that
  cost once per book, not once per open.
- **Soft delete (`deleted_at`), not `DELETE`.** Undo becomes a column write, and the realtime
  feed can carry a removal as an ordinary update instead of a delete event it has to special-case.
  `hidden_at` on `annotations` is the same idea applied to a revoked reader's marks: set when
  they leave without their marks, cleared the moment the book is shared with them again.
- **`memberships` never loses a row.** A revoked membership keeps `revoked_at` and `left_marks`
  instead of being deleted — that's what lets a highlight still show its author's name after
  they've left, and what lets re-sharing the book with them pick up exactly where it stopped,
  with no fresh invite needed.
- **One `invites` row per link, not one code per document.** The old design put a single
  `invite_code` on `documents`, so there was one link, forever, until it was rotated. Now every
  invite is its own row with its own use count and expiry, and `kind` distinguishes a link that
  connects two accounts (`connect`) from one that also grants a specific book (`book`).
- **`connections` is stored once per pair, ordered.** `user_a < user_b` means the same two people
  can never end up with two rows depending on who sent the invite — every query checking "are
  these two connected" is a single lookup, not an `OR`.

### Row-level security is the entire security model

The client is assumed hostile and never trusted to filter anything. Every table enforces two
rules, in Postgres itself:

- **read** → rows belonging to a document you're a member of
- **write** → only rows where `user_id = auth.uid()`

That membership check lives in one `security definer` function rather than inline in every
policy — and `revoked_at is null` is the one clause that makes revoking someone actually take
their access away, rather than just hiding a button in the UI:

```sql
create function is_member(doc uuid) returns boolean
  language sql security definer stable as $$
  select exists (select 1 from memberships m
                 where m.document_id = doc and m.user_id = auth.uid()
                   and m.revoked_at is null)
$$;
```

Every other policy — `read_annotations`, `read_progress`, `read_books` on storage — routes
through this one function, so that single clause is what closes off a revoked reader's access
to the document, its annotations, its progress, and the storage object all at once.

**Deleting a book is owner-only**, not member-only. `delete_documents` used to be
`using (is_member(id))` — any reader could destroy a shared book and cascade everyone else's
highlights with it, which was a defensible symmetry when a book held exactly two people and
isn't one for a group. It's now `using (created_by = auth.uid())`; anyone else leaves instead,
which `write_own_membership` already permitted. **Sharing a book is owner-only too** —
`share_document` and the `invites` insert policy both check `created_by`, so a reader who was
shared into a book can't turn around and share it onward to someone else. Only the person who
added the book decides who else reads it.

It has to be `security definer` — running with the function owner's privileges, RLS suspended
internally — because a `memberships`-select policy that itself queries `memberships` to check
membership recurses forever.

One policy breaks the "read = member" rule on purpose: `read_documents` also allows
`created_by = auth.uid()`. A `documents` insert is followed by `RETURNING`, which Postgres
evaluates against the `select` policy — but the creator's own `memberships` row is written
*after* the `documents` row, so at that instant `is_member()` is still false. Without the
`created_by` clause, creating a document would 403 on its own return value.

### Storage: private bucket, path-based ownership

The `books` bucket is private — a public bucket would make the storage policies below pure
decoration, since anyone who guesses or is handed a filename could download the book directly.

Upload ownership is checked against the **path prefix**, not `storage.objects.owner`:

```sql
with check (bucket_id = 'books' and (storage.foldername(name))[1] = auth.uid()::text)
```

`owner` is populated *after* the `with check` runs on an insert, so comparing `owner = auth.uid()`
would compare against `NULL` and reject every upload. Uploads go to `${auth.uid()}/<sha256>.<ext>`,
so the first path segment already carries the identity the policy needs.

Reads go through **signed URLs**, not downloaded bytes: `getDocumentSource` calls
`createSignedUrl` and hands pdf.js a URL rather than an ArrayBuffer, so pdf.js can issue HTTP
range requests and stream a 900-page book instead of pulling the whole file before the first
render. (EPUB does the opposite on purpose — see the "What you'll hit" table below for why
`epub-reader.js` downloads the bytes itself instead of handing epub.js the signed URL directly.)

### Realtime only respects RLS if you ask it to

`annotations`, `progress`, `memberships`, and `connections` are added to the `supabase_realtime`
publication, and all four are set to `replica identity full`. Skip that second part and the
realtime socket broadcasts every row change to every subscriber regardless of RLS — every policy
above stays correctly enforced everywhere except the one channel that actually matters.
`memberships` was in the publication from the start but didn't get `replica identity full` until
`social.sql` — a real leak in the original schema, not just a gap this feature happened to fill:
every subscriber's socket was receiving every membership row in the table, policy or no policy.

### Invites cross a barrier RLS creates on purpose

`write_own_membership` lets you insert your own membership row, but `read_documents` means you
can't see a document you're not already a member of — so you can never learn its `id` to insert
against. `redeem_invite(code, name)` is a `security definer` function built specifically to
cross that gap: it looks up the invite by an opaque `code` (never the document's `id`) with RLS
suspended, and only *then* inserts the membership row as the calling user.

There is no reader cap anymore — that was the two-person design's answer to "what stops a leaked
link from mattering forever," and it stopped being available the moment a book could hold more
than two people. The token carries its own limits instead:

- **Every invite is single-use and expires.** `createInvite` defaults to `max_uses = 1` and a
  two-week `expires_at`. A leaked link that's never clicked goes dead on its own; one that's
  already been used is refused on a second attempt with a readable message, not a silent no-op.
- **A revoked reader can't rejoin on an old link.** Revoking a membership sets `revoked_at` but
  keeps the row — that's deliberate, it's what lets a highlight still show its author's name and
  what lets re-sharing pick up cleanly — but it means `redeem_invite` has to check for it
  explicitly. Without that check, a removed reader re-clicking their original invite would walk
  straight back in through the same idempotency logic that makes a re-clicked link harmless for
  everyone else. Getting back in requires the owner to share the book again.
- **`revoke_invite` replaces `rotate_invite`.** The old design had one code per document, so
  "turn off this link" meant rotating the only one there was. Every invite is now its own row,
  so revoking one leaves every other link to the same book untouched, and kicks nobody already
  in the book out.
- **Only the book's owner can mint a book invite.** The `invites` table's insert policy checks
  `documents.created_by`, matching `share_document` — a link is just another way to add a reader,
  and adding readers is owner-only regardless of which door it comes through.

`connections`, `profiles`, and `shares_a_book` exist so a book invite does one more thing a plain
membership insert wouldn't: it also connects the two accounts, which is what makes the new
reader show up on the owner's People screen rather than being a stranger with highlights.

### Auth: magic link, and the one setting that silently breaks it

Sign-in is `supabase.auth.signInWithOtp` with `emailRedirectTo` set to the exact URL the user is
standing on, including any `?join=...` query string, so an invite survives the round trip through
email. That URL **must** be listed under Authentication → URL Configuration → Redirect URLs in
the Supabase dashboard, or Supabase silently bounces the magic link to the Site URL root instead
of erroring. See "Deploying" below for the exact steps — this is the single most common thing to get
wrong when standing up a new deployment, and it fails without an error message pointing at it.

### Client: one adapter interface, two implementations

`store.js` (IndexedDB) and `supabase-adapter.js` (Postgres) implement the identical interface, so
`app.js` changes one line to move between local and hosted mode. This is why the two modes share
all UI, sync, and geometry code, and only the storage layer differs.

Two decisions inside `supabase-adapter.js` worth knowing before touching it:

- **`putDocument` never sends `upsert: true`.** An upsert compiles to `INSERT ... ON CONFLICT DO
  UPDATE`, which makes Postgres also consult the `select` policy — RLS checks the row an upsert
  *would* return, not just the row being written. `read_books`'s storage policy requires a
  `documents` row that doesn't exist yet at upload time (it's written in the very next
  statement), so an upsert could never satisfy it, and every upload would 403 on RLS. A plain
  insert only triggers the `insert` policy, which is the one actually meant to run here.
- **The anon key is the only key that belongs in `config.js`, and that's by design.** It's public
  and identifies the project; it authorizes nothing on its own — every permission is decided by
  RLS, server-side, on every query. The `service_role` key bypasses RLS entirely and must never
  reach a browser. Supabase shows both keys on the same settings page, one above the other, which
  is the usual way they end up in the wrong place.

## Deploying

About 30 minutes, most of it waiting on Supabase. The free tier covers a small reading
group by roughly four orders of magnitude.

The order matters: **do the backend first.** Static hosting takes five minutes and is
the easy half, but a URL with no backend gives everyone their own separate private
library that shares nothing. It'll look like it works. It won't.

### 1. Supabase (the half that matters)

1. Create a project at [supabase.com](https://supabase.com). Save the database
   password somewhere; you won't need it for this, but you'll want it eventually.
2. **SQL Editor** → paste all of `schema.sql` → Run. It should report success with no
   rows. This creates the reader's own tables, RLS policies, and storage policies.
3. **SQL Editor** → paste all of `social.sql` → Run, after `schema.sql` has already run.
   This adds `profiles`, `connections`, `invites`, the sharing and revocation functions,
   and the realtime fix described above. Bringing an existing pre-social database
   forward: run `migration.sql` first if you haven't already (it predates invites
   entirely), then `social.sql` — it detects which case you're in and adjusts what it
   migrates accordingly.
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

#### Check the policies before you trust them

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
-- Should return 't' for all four. A 'f' means the realtime socket is broadcasting that
-- table's changes to every subscriber regardless of RLS.
select relname, relreplident = 'f' as full_identity
from pg_class where relname in ('annotations','progress','memberships','connections');
```

```sql
-- All four should show prosecdef = true (security definer). If any come back false,
-- RLS applies to the function's own queries and it will 403 on the exact gap it
-- exists to cross.
select proname, prosecdef from pg_proc
where proname in ('redeem_invite','share_document','revoke_share','merge_documents');
```

### 2. Static hosting

Any static host. The app is plain files — no build, no server, no Node.

**Cloudflare Pages / Netlify:** drag this folder onto their deploy page. Done. Set a
custom domain if you want a URL you can remember.

**GitHub Pages:** see below — it has a couple of specifics worth knowing.

**Your own box:** `python3 -m http.server` behind Caddy or nginx. It must be **HTTPS** —
`navigator.clipboard` (the invite button) and service workers both require a secure
context. `localhost` is exempt; your VPS's bare IP is not.

Nothing here needs a build step, but if you later add one, that's the moment to move
`config.js` to an env var. Not before — you'd be protecting a public key.

### 3. GitHub Pages specifically

It's a good fit: Pages serves static files, and this app is static files. No build step,
no Actions workflow needed. Push and set Settings → Pages → deploy from branch → `main`
→ `/ (root)`. Your URL is `https://<you>.github.io/<repo>/`.

Two files in this folder exist for Pages:

- **`.nojekyll`** — empty, and must stay empty. It's a flag. Pages runs everything
  through Jekyll by default, which silently drops files and folders beginning with `_`.
  Nothing here starts with `_` today; this stops that from becoming a mystery later.
- **`.gitignore`** — excludes `*.pdf` and `*.epub`. Read the comment in it before you
  override that.

**The subpath is already handled.** Project sites live at `/<repo>/`, not `/`. That
prefix is what usually breaks a static app. This one is fine: every path in `index.html`
and every import is relative, and the invite link is built from
`location.origin + location.pathname`, so it comes out as
`https://you.github.io/marginalia/?join=...` rather than dropping the repo name.
Verified under a simulated subpath. Don't "fix" either of those into an absolute `/`.
If you use the `<you>.github.io` repo instead of a project repo, you're at the root and
none of this applies.

**Free plan means a public repo.** Pages is free for public repositories; private repos
need Pro or above. Note that **the published site is public either way** — even on Pro,
`config.js` is downloadable by anyone who visits. That's fine. It holds the anon key,
which is public by design, and RLS is what actually stops strangers reading your margin.
What a public repo *does* change:

- **Never commit the book.** `.gitignore` covers PDF and EPUB. A public repo makes a
  committed book a copyrighted work published to the internet under your name, and git
  history keeps it after you delete the file. Books go in the Supabase bucket.
- **Never commit `service_role`.** Same reason, much worse. It bypasses RLS. If it ever
  lands in a public repo, rotate it in Supabase immediately — scrubbing the history is
  not enough, because public repos are scraped for keys within minutes.

**Set the Supabase URLs to the full path.** In Authentication → URL Configuration, Site
URL and Redirect URLs must include the repo path and the trailing slash:

```
https://<you>.github.io/<repo>/
```

Not `https://<you>.github.io`. A magic link issued for a URL that isn't listed bounces to
the root and 404s, with no error explaining why. This is the single most likely thing to
cost you an evening. HTTPS is on by default on `github.io`, so the clipboard-based invite
button works.

**Limits.** A recommended 1 GB repo limit, a 1 GB published-site limit, and a soft
100 GB/month bandwidth limit. Irrelevant for a small reading group and a few hundred KB
of JS — as long as the books stay out of the repo. If you commit a 40 MB scan and
everyone re-reads it, you're suddenly using Pages as a CDN for a book, which is both
against the point and against the terms.

### What you'll hit

| Symptom | Cause |
|---|---|
| Magic link lands on the site root, not the book | The URL isn't in **Redirect URLs**. Add it including the path. |
| Sign-in works, book list is empty | Uploaded before the membership row was written. Check `memberships`. |
| Book 404s or hangs on load | Bucket isn't named `books`, or the storage policies didn't run. |
| EPUB downloads but never renders | The fetch of the signed URL failed — check the console for a CORS or 4xx error. The app deliberately downloads the bytes itself and hands epub.js an ArrayBuffer: given a URL ending in `.epub?token=...`, epub.js misreads the query string and treats the book as an unpacked directory, requesting `META-INF/container.xml` from the wrong path. Don't "simplify" it back to passing the URL. |
| Highlights save but nobody else sees them | Realtime isn't publishing. Re-run the `alter publication` lines. |
| Realtime works but leaks | `replica identity full` didn't run. Without it the socket ignores RLS. |
| Invite button does nothing | Not HTTPS. Clipboard needs a secure context; it falls back to a prompt. |
| Invite button is greyed out, with a tooltip | You're not the owner of the open book. Only the person who added it can share it — ask them, or use the share sheet's "Add someone you're connected to" if you're already connected. |
| "That invite link has already been used" on a link nobody clicked | It's expired (two weeks by default) or was revoked. Mint a new one from the share sheet. |
| Someone you removed gets back in on their old link | Shouldn't happen — `redeem_invite` checks for a revoked membership before honoring a link. If it does, `social.sql` didn't fully apply; re-run it. |
| The merge banner never appears for an obvious duplicate | `find_my_duplicates` only matches on exact `sha256`. Two different scans of the same title, or a re-exported PDF, are different bytes and are never offered a merge — intentional, not a bug. |

### Before you put a real book in it

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

## Layout

```
PLAN.md                 the technical plan, with model notes per phase
.gitignore              keeps books out of a public repo — read the comment
.nojekyll               stops GitHub Pages running Jekyll over this. Keep it empty.
schema.sql              Postgres tables + RLS. The RLS is the security model.
migration.sql           brings a pre-EPUB database forward to schema.sql. Run social.sql after.
social.sql              profiles, connections, invites, sharing, revocation, duplicate merge
src/config.js           credentials, plus the hostname-based local/hosted switch
index.html              markup and styles
src/geometry.js         normalize/denormalize, rect merging, stroke simplification
src/anchors.js          DOM Selection -> storable anchors (PDF)
src/epub-anchors.js     DOM Selection -> storable anchors (EPUB, via CFI)
src/reader.js           pdf.js, the four-layer page stack, virtualization, progress
src/epub-reader.js      epub.js, scrolled/continuous chapters, CFI + percent progress
src/ink.js              pointer capture, pressure, palm rejection, stroke painting
src/highlight.css       the .hl-layer/.hl rules, shared by the host page and every
                        EPUB chapter iframe
src/store.js            the adapter interface + IndexedDB implementation
src/supabase-adapter.js the same interface, against Postgres
src/app.js              wiring
```

The one rule worth keeping: **no pixel value is ever stored.** Every coordinate is a
fraction of the page. If a highlight ever drifts when you zoom, the bug is in
`geometry.js` and nowhere else.

EPUB highlights take that one step further: a chapter's own layout isn't fixed the way a
PDF page's is (font size and window width both reflow it), so even a fraction would go
stale. What's stored instead is a CFI — EPUB's own stable text address — and the rects
used to paint it are recomputed fresh from that CFI every time the chapter renders. See
`epub-reader.js`'s `rectsForCfi`.
