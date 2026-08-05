# Marginalia

A PDF and EPUB reader for exactly two people who aren't in the same room.

Each of you keeps your own place. Each of you has a color. Highlights and typed notes
show up in both copies — stylus ink too, on PDFs. A rail down the left edge shows the
whole book with both of you on it and how far apart you are.


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

#### Be two people

Identity comes from a `?me=` parameter, so two tabs are two readers:

- `http://localhost:8000/?me=ash`
- `http://localhost:8000/?me=robin`

Open the same book in both. Highlight in one and watch it land in the other. A
`BroadcastChannel` stands in for the realtime socket, so the two-person flow is real
before the backend exists — same code path, different transport.

**`?me=` is local-mode only.** In hosted mode identity comes from the signed-in session,
and the parameter is ignored (with a console warning) — a silently-ignored `?me=` looks
exactly like a broken sign-in. If you're on a deployed URL and want the two-tab flow, add
`?backend=local`.

### Hosted (default on any deployed URL)
The same code talks to Postgres — sign-in, real sync between two devices, invite links.
Fill in `src/config.js` and see `DEPLOY.md`. Live version at
[tboggia.github.io/marginalia](https://tboggia.github.io/marginalia/).

To exercise it from your laptop before pushing, open
`http://localhost:8000/?backend=supabase`. Note that magic-link sign-in will only complete
if `http://localhost:8000` is listed under Supabase's Authentication → URL Configuration →
Redirect URLs.


## Controls

| | |
|---|---|
| `V` | Select — drag over text, pick a color, or add a note |
| Click a highlight | Opens it — read or edit the note, or **Remove highlight** |
| `×` in the margin | Removes that highlight. Your own only, and it removes it for both of you |
| `D` | Draw — for a mouse or trackpad. PDF only, see below |
| `E` | Erase — your own ink only. PDF only, see below |
| A stylus | Always draws, in any mode. You didn't pick it up to scroll. |
| A finger | Always scrolls, in any mode. This is also why palms are rejected. |

## What's real and what isn't

**Working, and tested in a real browser:** rendering, virtualized scroll (a 900-page book
keeps ~5 canvases alive), per-reader progress with restore, text selection → highlights,
notes, stylus ink with pressure, erase, per-reader color, the spine, and live sync between
two readers.

**Written, and structurally verified, but never run against a live project:** the
Supabase backend. `schema.sql` parses against PostgreSQL's own grammar and the app
boots cleanly in hosted mode (auth gate, adapter load, invite handling all exercised
against a fake project). But no query has ever hit a real database. Assume an
afternoon of small breakage, and check the RLS by hand — see `DEPLOY.md`.

**Known gaps:** scanned PDFs with no text layer can be inked but not highlighted — see
"Books with no text layer" below for what the reader does about it. Highlights stop at the page edge (PDF) or
the chapter edge (EPUB). No undo beyond deleting. **No ink on EPUB, by design, not an
oversight:** ink's whole value is that both of you see a stroke in exactly the same
place, which is mechanical and free on a fixed PDF page (you're both looking at the same
bitmap) and isn't well-defined on reflowable text — there's no shared notion of "the same
place" once font size or window width can differ between two readers. No mainstream EPUB
reader (Kindle, Apple Books, Play Books) offers freehand ink on reflowable books either.
Highlights and notes work fully on EPUB; only stylus ink is PDF-only.

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

Hosted mode is four Postgres tables, RLS, one storage bucket, and two security-definer
functions. This section is the "why"; `schema.sql` is the "what," and `DEPLOY.md` is the
"how do I stand one up."

### Data model

```
documents    (id, title, storage_path, sha256, format, epub_locations, invite_code, created_by)
memberships  (document_id, user_id, display_name, color)          — PK(document_id, user_id)
progress     (document_id, user_id, page, y_frac, cfi, percent)   — PK(document_id, user_id)
annotations  (id, document_id, user_id, type, color, rects, strokes, text, cfi, note, deleted_at)
```

- **One `annotations` table, not three.** Highlights and ink are one row shape with nullable
  columns, because the read pattern is always "everything on page N (or spine index N)" — three
  tables would mean three queries and a client-side merge for no benefit.
- **`progress` is one row per `(document, user)`, upserted in place.** That row *is* the "keep
  my place" feature — no history, just the last known position. PDF locates with `page` +
  `y_frac`; EPUB has no fixed page, so it locates with a `cfi` instead. The
  `progress_locator_matches` constraint enforces "exactly one of the two," so a row can never
  claim both.
- **`sha256` on `documents`.** If someone re-uploads a different scan of the same title, every
  stored anchor (rects, text_anchor, cfi) now points at the wrong words. The hash lets the app
  compare on load and refuse, rather than silently render 400 highlights in the wrong place.
- **`epub_locations` caches `book.locations.save()`.** The character-index walk that backs
  `percentageFromCfi`/`cfiFromPercentage` is a full-book pass — caching it means paying that
  cost once per book, not once per open.
- **Soft delete (`deleted_at`), not `DELETE`.** Undo becomes a column write, and the realtime
  feed can carry a removal as an ordinary update instead of a delete event it has to special-case.

### Row-level security is the entire security model

The client is assumed hostile and never trusted to filter anything. Every table enforces two
rules, in Postgres itself:

- **read** → rows belonging to a document you're a member of
- **write** → only rows where `user_id = auth.uid()`

That membership check lives in one `security definer` function rather than inline in every
policy:

```sql
create function is_member(doc uuid) returns boolean
  language sql security definer stable as $$
  select exists (select 1 from memberships m
                 where m.document_id = doc and m.user_id = auth.uid())
$$;
```

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
render. (EPUB does the opposite on purpose — see the `DEPLOY.md` troubleshooting table for why
`epub-reader.js` downloads the bytes itself instead of handing epub.js the signed URL directly.)

### Realtime only respects RLS if you ask it to

`annotations`, `progress`, and `memberships` are added to the `supabase_realtime` publication,
and `annotations`/`progress` are set to `replica identity full`. Skip that second part and the
realtime socket broadcasts every row change to every subscriber regardless of RLS — every policy
above stays correctly enforced everywhere except the one channel that actually matters.

### Invites cross a barrier RLS creates on purpose

`write_own_membership` lets you insert your own membership row, but `read_documents` means you
can't see a document you're not already a member of — so you can never learn its `id` to insert
against. `join_document(code, name)` is a second `security definer` function built specifically
to cross that gap: it looks up the document by an opaque `invite_code` (never the `id`) with RLS
suspended, and only *then* inserts the membership row as the calling user.

Two more decisions live in that function:

- **Capped at two readers.** The cap is what makes a leaked invite link stop mattering the
  moment the second reader joins — after that, the link opens nothing, whoever holds it.
- **`rotate_invite` replaces the code without touching `memberships`.** Rotating kicks nobody
  out; it only stops *future* joins on the old link.

### Auth: magic link, and the one setting that silently breaks it

Sign-in is `supabase.auth.signInWithOtp` with `emailRedirectTo` set to the exact URL the user is
standing on, including any `?join=...` query string, so an invite survives the round trip through
email. That URL **must** be listed under Authentication → URL Configuration → Redirect URLs in
the Supabase dashboard, or Supabase silently bounces the magic link to the Site URL root instead
of erroring. See `DEPLOY.md` for the exact steps — this is the single most common thing to get
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

## Layout

```
PLAN.md                 the technical plan, with model notes per phase
DEPLOY.md               how to get it onto a URL (incl. GitHub Pages)
.gitignore              keeps books out of a public repo — read the comment
.nojekyll               stops GitHub Pages running Jekyll over this. Keep it empty.
schema.sql              Postgres tables + RLS. The RLS is the security model.
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
