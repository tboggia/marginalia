# Marginalia — a shared PDF reader

**Technical plan, annotated with model selection per phase.**

You and one other person open the same DRM-free PDF, each keep your own place in it,
and leave highlights, typed notes, and stylus ink that the other person sees. That's
still the whole idea; Phase 9 below extends "one other person" to a group without
changing anything above it.

---

## 0. The shape of the problem

Almost everything here is easy. Four things are not, and they're where the plan spends its budget:

| Hard thing | Why it's hard |
|---|---|
| **Anchoring** | A highlight drawn at 1.4× zoom on a 13" laptop must land on the same words at 0.8× on a phone. Coordinates cannot be stored in pixels. |
| **Stylus capture** | Pen, touch, and mouse all fire `pointer` events. Getting smooth ink while palm-rejecting and still letting touch scroll the page is fiddly. |
| **Layer order** | pdf.js renders to `<canvas>`; text selection needs an invisible DOM text layer on top; ink needs a canvas on top of *that*; highlights need to show through. Four stacked layers per page, all pixel-aligned. |
| **Concurrent writers** | Not a hard distributed-systems problem even once "two" became "a few" in Phase 9 — rows are per-user and only their author edits them, so a real conflict still needs the same person in two tabs. Resist building a CRDT. |

Everything else (auth, upload, UI) is ordinary work.

---

## 1. Architecture

```
┌───────────────────────────────────────────────────┐
│  Browser                                          │
│                                                   │
│  ┌─────────────────────────────────────────────┐  │
│  │ Page stack (one per visible page)           │  │
│  │   4. ink canvas       ← pen strokes         │  │
│  │   3. text layer       ← selection (invisible)│ │
│  │   2. highlight layer  ← rects, multiply blend│ │
│  │   1. pdf canvas       ← pdf.js render        │ │
│  └─────────────────────────────────────────────┘  │
│         ▲                        │                │
│         │ normalized coords      │ normalized     │
│  ┌──────┴────────────────────────▼─────────────┐  │
│  │ Store (adapter interface)                   │  │
│  │   • optimistic local write → IndexedDB      │  │
│  │   • outbox flush → remote                   │  │
│  │   • subscribe → remote change feed          │  │
│  └──────┬──────────────────────────────────────┘  │
└─────────┼─────────────────────────────────────────┘
          │
   ┌──────▼──────────────────────────────────┐
   │ Supabase                                │
   │   Storage  → the PDF (private bucket)   │
   │   Postgres → annotations, progress      │
   │   Realtime → change feed per document   │
   │   Auth     → magic link, 2 users        │
   │   RLS      → read shared, write own     │
   └─────────────────────────────────────────┘
```

**Why Supabase:** you need Postgres + auth + a file bucket + a socket, for two people. Supabase
is all four with no server to run, and the free tier covers this by three orders of magnitude.
Firebase works identically; a hand-rolled Node/Postgres box is more control and more weekends.

**Why no build step in the prototype:** ES modules + pdf.js from CDN means you can open
`index.html` and it runs. Add Vite when the file count justifies it, not before.

---

## 2. The coordinate system (read this part twice)

Every stored coordinate is a **fraction of the unrotated page at scale 1**, origin top-left,
both axes in `[0, 1]`.

```
stored.x = (clientX - pageRect.left) / pageRect.width
render.x = stored.x * currentPageRect.width + currentPageRect.left
```

Consequences that fall out for free:

- Zoom, window resize, device pixel ratio, and phone-vs-laptop all stop mattering.
- Stroke width is also normalized (fraction of page width), so ink thickens with zoom like real ink.
- The only thing that breaks this is page **rotation**; normalize into unrotated space at capture
  time using the viewport's inverse transform, so rotation is a pure view concern.

**Highlights** store `{page, rects: [{x,y,w,h}], text, textAnchor}`.
The rects come from `Range.getClientRects()`, merged per line. `text` and `textAnchor`
(`{itemStart, offsetStart, itemEnd, offsetEnd}` into the pdf.js text content) are stored
alongside — not needed for rendering, but they make the annotation searchable, exportable,
and repairable if the file is ever swapped for a different scan.

**Ink** stores `{page, strokes: [{color, width, points: [[x,y,pressure],...]}]}`,
simplified with Ramer–Douglas–Peucker at capture time (epsilon ≈ 0.0015 of page width).
A 3-second stroke goes from ~400 raw points to ~40 with no visible loss.

---

## 3. Data model

The sketch below is the original, PDF-only shape from this phase. It's kept as-is for the
history; the model that actually shipped is `schema.sql` (adds EPUB: `format`, `cfi`,
`spine_index`, `epub_locations`) plus `social.sql` (adds `profiles`, `connections`,
`invites`, and the membership/annotation lifecycle columns that Phase 9 needed). Those two
files are the source of truth — see README "Backend architecture" for the current model.

```sql
documents(id, title, storage_path, page_count, sha256, created_by, created_at)
memberships(document_id, user_id, display_name, color, PK(document_id, user_id))
progress(document_id, user_id, page, y_frac, updated_at, PK(document_id, user_id))
annotations(id, document_id, user_id, page, type, color,
            rects jsonb, strokes jsonb, text, note,
            created_at, updated_at, deleted_at)
```

- `progress` is a single upserted row per person per book. That is the entire "keep my place"
  feature. `y_frac` is how far down that page you were.
- `annotations.type` ∈ `highlight | note | ink`. One table, nullable columns, because the
  read pattern is always "give me everything on page N" and joins across three tables for
  two users is ceremony.
- `deleted_at` not `DELETE`, so undo is a column write and the realtime feed carries removals.
- `sha256` is how you notice someone re-uploaded a different edition and all the anchors moved.

**RLS is the whole security model:**

```sql
-- read: anything in a document you're a member of
using (exists (select 1 from memberships m
               where m.document_id = annotations.document_id
                 and m.user_id = auth.uid()))
-- write: only your own rows, only in your documents
with check (user_id = auth.uid() and exists (...same...))
```

Get this right once and the client can be as naive as it likes.

---

## 4. Phases

Status is marked on each heading: **✅ Done** means built and used in a real browser.
**⚠️** means the code exists and is structurally checked but hasn't been exercised for
real — for anything backend-shaped that means no query has hit a live Postgres.
**⬜** means not started.

Model annotations follow Anthropic's own guidance: Opus 4.8 for complex reasoning and
long-horizon agentic coding, Sonnet 5 for frontier coding at scale, Haiku 4.5 for fast
high-volume and sub-agent work. ([choosing a model](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model))
On Opus 4.8 the `effort` parameter defaults to `high`; `xhigh` is the recommended setting
for coding and high-autonomy work, and is usually a better lever than switching models.

### Phase 1 — Reader core  ✅ Done
Render pdf.js into a virtualized scroller (±2 pages around the viewport), placeholder divs
pre-sized from each page's viewport so the scrollbar is honest from frame one. Restore and
persist `{page, y_frac}` on a trailing 800ms debounce.

> **Sonnet 5.** Well-trodden pdf.js scaffolding with a clear spec. Frontier coding without
> paying Opus rates for boilerplate.
> **Escalate to Opus 4.8 (`xhigh`)** for `geometry.js` alone — the normalize/denormalize
> math is load-bearing for every later phase, and a subtle sign error here surfaces as
> "highlights drift when you zoom" three weeks later.

### Phase 2 — Selection and highlights  ✅ Done
`Range.getClientRects()` → merge into line rects → normalize → store → render as
`mix-blend-mode: multiply` divs. Selection popover with the six-color palette.

> **Opus 4.8 (`xhigh`)** for `anchors.js`. Client rect merging has real edge cases:
> multi-column layouts, rects that span page boundaries, zero-height rects from empty
> text spans, RTL runs.
> **Sonnet 5** for the popover, palette, and hit-testing UI.

### Phase 3 — Stylus ink  ✅ Done
Pointer capture with `getCoalescedEvents()` for sub-frame sampling, `pressure` mapped to
width, Catmull-Rom smoothing on render, RDP simplification on commit. Pen beats touch;
touch scrolls unless ink mode is on; `touch-action` toggles per mode.

> **Opus 4.8 (`xhigh`).** The most bug-dense phase in the project and the least
> represented in training data — palm rejection and coalesced-event handling are where
> naive implementations produce jagged lines and phantom dots. Give it the file, the
> device matrix, and room to reason.

### Phase 4 — Backend  ⚠️ Written, never run against a live project
Schema, RLS policies, storage bucket, magic-link auth, invite flow.

> **Opus 4.8 (`xhigh`)** for the RLS policies. Security-sensitive, and an over-permissive
> `using` clause fails silently — it just works, for everyone, forever.
> **Haiku 4.5** for the migration scaffolding, seed fixtures, and type generation.

### Phase 5 — Sync  ✅ Done locally · ⚠️ hosted path unverified
Adapter behind an interface (already in the prototype). Optimistic local write → IndexedDB
outbox → flush → Realtime subscription for the other person's changes. Last-write-wins per
annotation id; conflicts are near-impossible because rows are per-user and immutable except
by their author.

> **Opus 4.8.** Offline reconciliation and reconnect semantics are exactly the "reason
> carefully about state machines" work Opus is for. Explicitly instruct it *not* to
> reach for a CRDT — capable models will happily build one, and you don't need it.

### Phase 6 — The spine, presence, notes panel  ✅ Done
Left rail showing the whole book with both readers' markers and annotation ticks. Note
panel. Empty states. Copy.

> **Sonnet 5.** Strong visual and interaction work, fast iteration loop. This phase is
> mostly taste and repetition, and you'll run it many times.

### Phase 7 — Hardening  ⬜ Not started
Unit tests for geometry and anchors, a device matrix pass (iPad+Pencil, Surface+Pen,
laptop trackpad), a 900-page performance pass, accessibility.

> **Haiku 4.5** for test generation, fixtures, and the high-volume mechanical passes —
> the docs call out sub-agent tasks and high-volume processing as its lane.
> **Opus 4.8** for the perf investigation, where the answer isn't known in advance.

### Phase 8 — Anything long-horizon  ⬜ As needed
Large refactors, a Vite/TypeScript migration, cross-cutting changes.

> **Opus 4.8 (`xhigh`)**, or **Fable 5** if you want the most capable widely released
> model on it. Fable 5 is $10/M in, $50/M out with a 1M context window — for a
> two-person reading app, that's the wrong end of the cost curve unless something is
> genuinely stuck.

**The blunt version of all of this:** run Claude Code on Opus 4.8, leave effort at
default for most work, push to `xhigh` for `geometry.js`, `anchors.js`, `ink.js`, and the
RLS policies. Tuning effort within one model is a better first lever than swapping models.

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| Scanned PDFs have no text layer, so selection silently does nothing | Detect empty text content on load, show it plainly ("This scan has no selectable text — ink still works"), offer OCR later |
| 900-page books stall on load | Range requests + `rangeChunkSize`; lazily correct page sizes instead of calling `getPage` 900 times upfront |
| Someone re-uploads a different edition | `sha256` check on load; refuse and explain rather than render 400 misplaced highlights |
| iOS Safari pointer events | Test on real hardware early — `getCoalescedEvents` support and pressure behavior differ from Chrome |
| Scope creep into a CRDT | Rows are per-user and per-author. Last-write-wins, even at group size. |

---

## 6. What's built

The prototype in `src/` implements Phases 1–3 and the Phase 5 interface, running fully
locally against IndexedDB: render, virtualized scroll, per-user progress, text selection,
highlights, typed notes, stylus ink with pressure, per-user color, and the spine.
`supabase-adapter.js` and `schema.sql` are the drop-in for Phases 4–5. Phase 9 adds
`social.sql` and the People/share UI on top of that — see below.

---

## 9. The social layer: from a pair to a group  ⚠️ Built, SQL never run

The original design fixed the reader count at two and used that fact directly for
security (a book capped at two readers means a leaked invite link stops mattering the
moment the second person joins — see the old `join_document`). Opening that up to a
group meant finding a different place for that guarantee to live, not just raising the
cap. It now lives in the invite token itself: single-use, two-week expiry, and a check
that a revoked reader can't rejoin on an old link.

Two ideas that weren't needed at all with exactly two people: a **connection** between
two accounts, independent of any book, and a **grant** that shares one specific book with
someone you're connected to. Splitting them is what makes "remove someone from this book"
and "stop knowing this person entirely" two different actions instead of one.

The other new question a pair never has to ask: what happens when two people
independently add the same book? Anchors (PDF rects and text-item indexes, EPUB CFIs) are
all properties of one specific file, so the honest answer is that highlights only ever
transfer between byte-identical copies — verified by `sha256`, not by title or metadata
matching. `merge_documents` is the one truly irreversible operation added in this phase:
it repoints every annotation and progress row and deletes the losing document. It's
guarded by re-checking the hash server-side (never trusting a client's earlier claim of a
match) and by only letting the person giving up their own copy call it.

The third question a pair never has to ask, and the second irreversible operation:
leaving altogether. `delete_account()` is a hard delete where everything else in this
phase is a mark on a row — a revoked membership is still a membership, precisely so
re-sharing can resume — because an account has nothing to resume into. Nearly all of it
is `on delete cascade` from `auth.users`; the design work is in the one thing that must
not cascade. A book the leaver added but other people are still reading can't go with
them (it would take those readers' highlights too) and can't be left ownerless either,
since every owner check in `social.sql` reads `created_by`. So it's handed to whoever
joined earliest, and `documents.created_by` keeps no cascade on purpose: if the hand-over
were ever skipped, the foreign key refuses the deletion outright rather than quietly
producing a book nobody can manage.

> **Opus, high effort**, for `social.sql`'s RLS and RPCs, and for the group-spread rail
> math in `app.js` (`renderSpine`, `clusterPositions`) — the second because the phase's
> one hard constraint was that at exactly two readers, none of it may visibly change.
> That was checked by transcribing the old and new band math and running both against
> 200,000 randomized two-reader cases, not by eyeballing the diff.
> **Sonnet** for the People screen, share dialog, and shelf badges — DOM and CSS against
> conventions the rest of the app already documents closely (see README's design-token
> and dialog-pattern notes), where the risk is mostly volume, not subtlety.

What's still open: whole-library sharing (share every book you add, automatically, with
someone) was scoped for this phase and deliberately dropped. A trigger that fans out
membership on every upload cuts against the rest of the design, which is built around an
explicit per-book decision every time — see README "Reading with other people" for what
shipped instead.
