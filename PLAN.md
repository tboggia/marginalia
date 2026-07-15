# Marginalia — a two-person shared PDF reader

**Technical plan, annotated with model selection per phase.**

You and one other person open the same DRM-free PDF, each keep your own place in it,
and leave highlights, typed notes, and stylus ink that the other person sees.

---

## 0. The shape of the problem

Almost everything here is easy. Four things are not, and they're where the plan spends its budget:

| Hard thing | Why it's hard |
|---|---|
| **Anchoring** | A highlight drawn at 1.4× zoom on a 13" laptop must land on the same words at 0.8× on a phone. Coordinates cannot be stored in pixels. |
| **Stylus capture** | Pen, touch, and mouse all fire `pointer` events. Getting smooth ink while palm-rejecting and still letting touch scroll the page is fiddly. |
| **Layer order** | pdf.js renders to `<canvas>`; text selection needs an invisible DOM text layer on top; ink needs a canvas on top of *that*; highlights need to show through. Four stacked layers per page, all pixel-aligned. |
| **Two writers** | Not a hard distributed-systems problem — it's two people, usually asleep in different timezones. Resist building a CRDT. |

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

Model annotations follow Anthropic's own guidance: Opus 4.8 for complex reasoning and
long-horizon agentic coding, Sonnet 5 for frontier coding at scale, Haiku 4.5 for fast
high-volume and sub-agent work. ([choosing a model](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model))
On Opus 4.8 the `effort` parameter defaults to `high`; `xhigh` is the recommended setting
for coding and high-autonomy work, and is usually a better lever than switching models.

### Phase 1 — Reader core
Render pdf.js into a virtualized scroller (±2 pages around the viewport), placeholder divs
pre-sized from each page's viewport so the scrollbar is honest from frame one. Restore and
persist `{page, y_frac}` on a trailing 800ms debounce.

> **Sonnet 5.** Well-trodden pdf.js scaffolding with a clear spec. Frontier coding without
> paying Opus rates for boilerplate.
> **Escalate to Opus 4.8 (`xhigh`)** for `geometry.js` alone — the normalize/denormalize
> math is load-bearing for every later phase, and a subtle sign error here surfaces as
> "highlights drift when you zoom" three weeks later.

### Phase 2 — Selection and highlights
`Range.getClientRects()` → merge into line rects → normalize → store → render as
`mix-blend-mode: multiply` divs. Selection popover with the six-color palette.

> **Opus 4.8 (`xhigh`)** for `anchors.js`. Client rect merging has real edge cases:
> multi-column layouts, rects that span page boundaries, zero-height rects from empty
> text spans, RTL runs.
> **Sonnet 5** for the popover, palette, and hit-testing UI.

### Phase 3 — Stylus ink
Pointer capture with `getCoalescedEvents()` for sub-frame sampling, `pressure` mapped to
width, Catmull-Rom smoothing on render, RDP simplification on commit. Pen beats touch;
touch scrolls unless ink mode is on; `touch-action` toggles per mode.

> **Opus 4.8 (`xhigh`).** The most bug-dense phase in the project and the least
> represented in training data — palm rejection and coalesced-event handling are where
> naive implementations produce jagged lines and phantom dots. Give it the file, the
> device matrix, and room to reason.

### Phase 4 — Backend
Schema, RLS policies, storage bucket, magic-link auth, invite flow.

> **Opus 4.8 (`xhigh`)** for the RLS policies. Security-sensitive, and an over-permissive
> `using` clause fails silently — it just works, for everyone, forever.
> **Haiku 4.5** for the migration scaffolding, seed fixtures, and type generation.

### Phase 5 — Sync
Adapter behind an interface (already in the prototype). Optimistic local write → IndexedDB
outbox → flush → Realtime subscription for the other person's changes. Last-write-wins per
annotation id; conflicts are near-impossible because rows are per-user and immutable except
by their author.

> **Opus 4.8.** Offline reconciliation and reconnect semantics are exactly the "reason
> carefully about state machines" work Opus is for. Explicitly instruct it *not* to
> reach for a CRDT — capable models will happily build one, and you don't need it.

### Phase 6 — The spine, presence, notes panel
Left rail showing the whole book with both readers' markers and annotation ticks. Note
panel. Empty states. Copy.

> **Sonnet 5.** Strong visual and interaction work, fast iteration loop. This phase is
> mostly taste and repetition, and you'll run it many times.

### Phase 7 — Hardening
Unit tests for geometry and anchors, a device matrix pass (iPad+Pencil, Surface+Pen,
laptop trackpad), a 900-page performance pass, accessibility.

> **Haiku 4.5** for test generation, fixtures, and the high-volume mechanical passes —
> the docs call out sub-agent tasks and high-volume processing as its lane.
> **Opus 4.8** for the perf investigation, where the answer isn't known in advance.

### Phase 8 — Anything long-horizon
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
| Scope creep into a CRDT | Two people. Last-write-wins. |

---

## 6. What's built

The prototype in `src/` implements Phases 1–3 and the Phase 5 interface, running fully
locally against IndexedDB: render, virtualized scroll, per-user progress, text selection,
highlights, typed notes, stylus ink with pressure, per-user color, and the spine.
`supabase-adapter.js` and `schema.sql` are the drop-in for Phases 4–5.
