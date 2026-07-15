# Marginalia

A PDF reader for exactly two people who aren't in the same room.

Each of you keeps your own place. Each of you has a color. Highlights, typed notes, and
stylus ink show up in both copies. A rail down the left edge shows the whole book with
both of you on it and how far apart you are.

## Two modes

**Local** (default): everything in IndexedDB, one browser, no sign-in. Good for trying
it, and for building on.

**Hosted**: fill in `src/config.js` and the same code talks to Postgres — sign-in,
real sync between two devices, invite links. See `DEPLOY.md`. Roughly 30 minutes.

Nothing else changes between them. That's what the store adapter is for.

## Run it

No build step, but it does need to be served (ES modules don't load from `file://`):

```bash
cd shared-reader
python3 -m http.server 8000
# open http://localhost:8000
```

Drop in a DRM-free PDF. Everything lives in IndexedDB on your machine until you connect
a backend.

## Be two people

Identity comes from a `?me=` parameter, so two tabs are two readers:

- `http://localhost:8000/?me=ash`
- `http://localhost:8000/?me=robin`

Open the same book in both. Highlight in one and watch it land in the other. A
`BroadcastChannel` stands in for the realtime socket, so the two-person flow is real
before the backend exists — same code path, different transport.

## Controls

| | |
|---|---|
| `V` | Select — drag over text, pick a color, or add a note |
| `D` | Draw — for a mouse or trackpad |
| `E` | Erase — your own ink only |
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

**Known gaps:** scanned PDFs with no text layer can be inked but not highlighted (the
reader detects this; it doesn't yet tell you). Highlights stop at the page edge. No undo
beyond deleting.

## Layout

```
PLAN.md                 the technical plan, with model notes per phase
DEPLOY.md               how to get it onto a URL (incl. GitHub Pages)
.gitignore              keeps books out of a public repo — read the comment
.nojekyll               stops GitHub Pages running Jekyll over this. Keep it empty.
schema.sql              Postgres tables + RLS. The RLS is the security model.
src/config.js           the one file you edit to go from laptop to URL
index.html              markup and styles
src/geometry.js         normalize/denormalize, rect merging, stroke simplification
src/anchors.js          DOM Selection -> storable anchors
src/reader.js           pdf.js, the four-layer page stack, virtualization, progress
src/ink.js              pointer capture, pressure, palm rejection, stroke painting
src/store.js            the adapter interface + IndexedDB implementation
src/supabase-adapter.js the same interface, against Postgres
src/app.js              wiring
```

The one rule worth keeping: **no pixel value is ever stored.** Every coordinate is a
fraction of the page. If a highlight ever drifts when you zoom, the bug is in
`geometry.js` and nowhere else.
