# What still needs a person

`./test.sh` covers the SQL: every policy, every RPC, the constraints, and the
structural settings that fail silently. It cannot cover anything that only
exists in a browser — the adapter, sign-in, the realtime socket, signed-URL
streaming, or three real people sharing a book. Those are below.

Run these against the local stack, not the hosted project:

```bash
supabase start                    # once; leave it running
python3 -m http.server 8000       # in the repo root
# then open http://localhost:8000/?backend=supabase-local
```

`?backend=supabase-local` is the new third mode. Plain `?backend=supabase` still
means the **hosted** project, exactly as it always has — check the footer or the
console line (`local · Supabase (local stack)`) before you trust what you see.

Sign in as `ash@marginalia.test`, `robin@marginalia.test`,
`jules@marginalia.test`, or `kit@marginalia.test`. No passwords: the magic link
lands in the CLI's mail catcher, whose URL `supabase status` prints. Those four
accounts are already seeded, so you land on the same rows the SQL suite uses.

---

## Sign-in and the adapter

- [ ] Magic link for `ash@marginalia.test` arrives in the mail catcher and signing in lands you back on `http://localhost:8000` — not on a bare site root, not a 404.
- [ ] The console logs `local · Supabase (local stack)` on boot.
- [ ] `?me=ash` is ignored in hosted mode and logs a warning rather than silently doing nothing.
- [ ] Opening a second tab without `?backend=` puts you back in local IndexedDB mode — the override is per-tab and does not leak.

## Upload and read

- [ ] Drop in `samples/louise-michel-the-red-virgin.pdf`. It uploads, appears on the shelf with a cover, and opens.
- [ ] Network tab shows the PDF arriving via a **signed URL with HTTP range requests**, not one whole-file download. This is the `getDocumentSource` claim and the reason a 900-page book is usable at all.
- [ ] Drop in the sample EPUB. It renders. (EPUB deliberately downloads whole — see the README table for why `epub-reader.js` doesn't hand epub.js the URL.)
- [ ] Re-drop the same PDF. It dedupes on `sha256` rather than making a second book.
- [ ] Reload. Your reading position is restored to where you left it.

## Two readers, live

Ash in one browser, Robin in another (use a private window — two profiles, not
two tabs, or you share a session).

- [ ] Ash invites Robin from inside the book; Robin opens the link and lands in the book.
- [ ] Ash highlights a sentence. It appears in Robin's window **without a reload**. This is the realtime socket, and it is the single thing local-mode `BroadcastChannel` testing cannot tell you anything about.
- [ ] Robin's reading position shows on Ash's spine rail, and moves as Robin scrolls.
- [ ] Robin adds a note; Ash sees it, attributed to Robin, in Robin's colour.
- [ ] Ash deletes their own highlight; it disappears for Robin.
- [ ] Robin cannot delete Ash's highlight (no `×` offered).

## Three readers

The case the two-person design never had to handle.

- [ ] Ash shares the same book with Jules. All three appear on the spine rail with three distinct colours.
- [ ] With exactly two readers in a book, the rail looks the way it always did. (The group-spread maths was checked against the old code across 200,000 randomised cases; this is the eyeball confirmation.)
- [ ] Jules's Invite button is greyed out with a tooltip — only Ash owns the book.
- [ ] Jules leaves the book choosing **Leave them**. Ash still sees Jules's highlights; Jules no longer sees anyone's.
- [ ] Ash shares it with Jules again. Jules's old highlights *and* reading position come straight back.
- [ ] Jules leaves again choosing **Take them**. Jules's highlights vanish for Ash and Robin.
- [ ] Ash re-shares once more; the taken marks come back. Nothing was ever deleted.

## Invites

- [ ] A spent invite link, opened by a second person, says it has already been used — rather than silently doing nothing.
- [ ] Revoking a link from the share sheet stops it working, and a different link to the same book still works.
- [ ] Ash removes Robin, then Robin clicks their original invite link: refused, with the "ask whoever added it" message.
- [ ] The invite button copies to the clipboard over `http://localhost` (a secure context) and falls back to a prompt when it isn't.

## Duplicates and merging

- [ ] Robin uploads the *same* PDF file independently. Both Ash and Robin now hold it.
- [ ] Ash is offered a merge on the shelf. Accepting folds Ash's copy into Robin's, and every highlight from both lands on the words it was already on.
- [ ] The dropped copy's file is actually gone from the bucket (check Storage in the local Studio), not orphaned.
- [ ] Upload a *different* scan of the same title. No merge is offered, and the app says why.

## Deleting an account

`08_account_deletion.sql` covers what the database does. What it can't cover is the
half that only exists in the browser: the two-view dialog, and the storage
objects, which have to leave the bucket *before* the rows that authorize their
removal do. Do this last — it removes an account, and `supabase db reset` is what
brings Ash back.

Open the **You** dialog in the topbar (it's the button showing your name).

- [ ] In local mode (`?backend=local`), the dialog has only Cancel and Save. There is no Delete account button, because there is no account.
- [ ] Signed in as Ash with one book nobody else is reading, **Delete account** swaps the dialog to a second view that names that book's fate: "The book you added that nobody else is reading is deleted."
- [ ] Share that book with Robin, reopen the dialog, and the sentence changes to the hand-over wording instead. The count matches what Ash actually added — not what's on the shelf, which includes books Robin shared *in*.
- [ ] Escape from the confirm view, then reopen: it lands on the name view, not mid-question.
- [ ] Cancel from the confirm view, then reopen and press Enter in the name field: it still saves the name. Cancelling a deletion must not become a rename, and Enter must not become a deletion.
- [ ] Go through with it. The page reloads to the sign-in screen rather than a half-built shelf.
- [ ] In Robin's window: the shared book is still there, Robin's own highlights in it are intact, and Ash's have gone. Robin now owns it — the Invite button in that book is live for Robin, where it was greyed out before.
- [ ] Robin's other book, the one Ash was only ever a reader of, still opens, and Ash's highlights are gone from it too.
- [ ] Local Studio → Storage → `books`: the file for Ash's solo book is **gone**, not orphaned. The file for the handed-over book is still there and still opens for Robin.
- [ ] Sign in again as `ash@marginalia.test`. It's a brand-new empty account: a fresh profile, no books, no connections — not the old one with its contents missing.

## The parts nothing else will catch

- [ ] A scan with no text layer shows the strip under the toolbar, `IMAGE ONLY` in the gutter, and the "Nothing to select here" card on a drag. Draw still works.
- [ ] Stylus ink on a tablet: pressure varies the stroke, the palm is rejected, and a finger still scrolls. Needs real hardware — a trackpad tells you nothing about this.
- [ ] A 900-page book: scrolling stays smooth and roughly five canvases stay alive.
- [ ] Sign out and back in. Everything is still there.

---

## Before the hosted project

A green local run is strong evidence, not proof. The stack's Postgres is a
different major version than hosted, and its auth issues locally-signed JWTs, so
these still need checking against the real project once:

- [ ] `schema.sql` then `social.sql` apply cleanly in the hosted SQL editor. (`./test.sh` proves they apply to an empty database in that order; it says nothing about a database that already has some of it.)
- [ ] `migration.sql` — **not covered at all.** It brings a pre-EPUB database forward, and the local stack is built fresh from `schema.sql` every time, so there is no database here in the state it exists to fix.
- [ ] `social.sql` did not print `could not grant delete on auth.users to postgres` when it ran. That grant is the one thing in the file that reaches into a schema this project doesn't own, and locally it is a formality because `postgres` is a superuser there. If the notice appears, `delete_account()` will fail with a permissions error until someone who can runs the grant.
- [ ] Delete a throwaway hosted account end to end. The local stack's storage schema may not have the `storage.objects.owner` foreign key that hosted does, and that key is the difference between the deletion working and failing on the last statement.
- [ ] Rate limiting on `redeem_invite` is turned on in the hosted dashboard. It is the one function reachable by any signed-in user with nothing but a guessed string, and rate limits are a hosted setting with no local equivalent.
- [ ] Site URL and Redirect URLs include the full deployed path with its trailing slash.
- [ ] Real email delivery works — the local mail catcher proves the link is *generated*, not that it *arrives*.
