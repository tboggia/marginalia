/**
 * app.js — wiring. Identity, tools, the annotation lifecycle, the spine, the panel.
 *
 * This file is allowed to be about the product. Coordinates live in geometry.js,
 * selection lives in anchors.js, persistence lives in store.js. If a pixel value or
 * an IndexedDB call appears below, it's in the wrong file.
 */

import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs';
import { Reader, IMAGE_GLYPH } from './reader.js';
import { EpubReader } from './epub-reader.js';
import { LocalStore, newId } from './store.js';
import { config, isHosted, describeEnv } from './config.js';
import { readSelection, hitTest, SELECTION_SETTLE_MS } from './anchors.js';
import { redraw, distanceToStroke } from './ink.js';
import { toPage } from './geometry.js';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';

console.info('Marginalia v 0.0.6');
// Must stay in step with --c-* in index.html: the same six values are read from CSS
// for chrome and written into member rows from here, and a reader's color is drawn
// from the row. Each one is contrast-checked as UI text on the dark surfaces and as
// dark text on its own fill — see README "Accessibility" before changing one.
const COLORS = [
  { name: 'amber',   hex: '#E9A13B' },
  { name: 'cyan',    hex: '#3FBFC9' },
  { name: 'magenta', hex: '#E87CB0' },
  { name: 'violet',  hex: '#9E90EA' },
  { name: 'lime',    hex: '#7FBF3F' },
  { name: 'coral',   hex: '#EE7F5C' },
];

const $ = (s) => document.querySelector(s);
const app = $('#app');
// Must stay in step with the max-width:900px breakpoint in index.html — this is
// where the panel becomes a slide-over and the toolbar drops to icons only.
const isMobile = () => matchMedia('(max-width: 900px)').matches;

/* ------------------------------------------------------------------ identity
   ?me=anything gives this tab its own identity. That's the whole two-person
   demo: open a second tab with ?me=them and you are, for all the app knows,
   the other reader. */
const params = new URLSearchParams(location.search);
const alias = params.get('me');

function pref(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function setPref(key, val) {
  try {
    localStorage.setItem(key, val);
  } catch {
    /* private mode, or an environment with storage disabled — identity is
       ephemeral, but everything else still works */
  }
}
function clearPref(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* same as setPref, and with less at stake: these keys are a cache of the profile */
  }
}

const uidKey = alias ? `marginalia:uid:${alias}` : 'marginalia:uid';
let me = {
  id: pref(uidKey, null) ?? (() => { const id = newId(); setPref(uidKey, id); return id; })(),
  name: pref(uidKey + ':name', alias ? alias[0].toUpperCase() + alias.slice(1) : 'You'),
  color: pref(uidKey + ':color', alias ? COLORS[1].hex : COLORS[0].hex),
};

/* ------------------------------------------------------------------- state */
// Local until configured. This is the whole switch: fill in src/config.js and the
// same app talks to Postgres. The import is dynamic so local mode never pays for
// the Supabase bundle.
const store = isHosted()
  ? await (async () => {
      const { SupabaseStore } = await import('./supabase-adapter.js');
      return new SupabaseStore(config.supabaseUrl, config.supabaseAnonKey);
    })()
  // uidKey so the local profile lands under the same ?me= alias the rest of identity
  // uses — two aliased tabs are two people and must not share a name and color.
  : new LocalStore(uidKey);

// Created fresh per doc in openDoc — a session can open a PDF, close it, and open an
// EPUB (or another PDF) without a reload, so this can't be a single instance anymore.
let reader = null;
let unsubscribe = null; // store.subscribe's teardown, held so close/reopen doesn't leak

let docId = null;
let annotations = [];
let members = [];
let progress = {};
let tool = 'select'; // select | ink | erase
let pending = null; // selection awaiting a color
let editing = null; // annotation open in the note dialog

const colorOf = (userId) =>
  members.find((m) => m.userId === userId)?.color ?? me.color;
const nameOf = (userId) =>
  userId === me.id ? me.name : members.find((m) => m.userId === userId)?.name ?? 'Them';
/**
 * Everyone but you who is still in this book.
 *
 * This replaced a single `other()`, which took the first non-me member and ignored the
 * rest — fine when a book held two people, wrong now. Revoked members stay in `members`
 * on purpose (their old highlights still need a name and a color beside them) and are
 * filtered out here, because they are no longer *reading* it.
 */
const others = () => members.filter((m) => m.userId !== me.id && !m.revokedAt);
/** Members whose access has ended: their marks may remain, their position does not. */
const revokedIds = () =>
  new Set(members.filter((m) => m.revokedAt).map((m) => m.userId));

// PDF annotations group by page number; EPUB has no fixed page, so they group by
// spine index instead — the same coarse "which chunk of the book" role, different unit.
const unitKey = (a) => a.pageNumber ?? a.spineIndex;
// A human position label: an exact page for PDF, a rounded percent-through-book for EPUB.
const posLabel = (p) => (p.page != null ? `p.${p.page}` : `${Math.round((p.percent ?? 0) * 100)}%`);
// The same fact, said out loud. "p.5" is a fine thing to read on a 20px pill and a
// poor thing for a screen reader to announce, and "%" is read inconsistently.
const spokenPos = (p) =>
  p.page != null ? `page ${p.page}` : `${Math.round((p.percent ?? 0) * 100)} percent through`;
// What reader.goTo() needs, read off an annotation record. Each reader implementation
// only looks at the fields that apply to its own format (page/yFrac vs cfi).
const locatorFor = (a) => ({
  page: a.pageNumber,
  yFrac: a.rects?.[0] ? Math.max(0, a.rects[0].y - 0.12) : 0,
  cfi: a.cfi,
});

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.dataset.show = 'true';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.dataset.show = 'false'), 2600);
}

/* Opening a book is the one genuinely slow thing in the app: a hosted upload of a
   10MB file, then pdf.js parsing it or epub.js walking the whole spine to build the
   locations index. Without this the UI just sits there looking broken. */
function showLoading(msg) {
  $('#loading-msg').textContent = msg;
  $('#loading').hidden = false;
}
function hideLoading() {
  $('#loading').hidden = true;
}

/* -------------------------------------------------------------------- boot */
async function boot() {
  console.info(`Marginalia: ${describeEnv()}`);
  await store.init();

  if (isHosted()) {
    // In hosted mode identity comes from the session, not from a query param. ?me=
    // is a local-mode testing affordance and must not survive contact with real users.
    // Say so, loudly: a silently-ignored ?me= looks exactly like a broken sign-in.
    if (alias) {
      console.warn(
        `Marginalia: ignoring ?me=${alias} — identity comes from the signed-in session ` +
          `in hosted mode. For the two-tab flow, use ?backend=local.`
      );
    }
    if (!store.user) return showAuth();
    // The profile row is the record now, not localStorage. It has to be: a name that
    // lives only in this browser can't appear in anyone else's people list, and it
    // reverts the moment you sign in on a second device. The local prefs are kept as a
    // fallback for the first load after sign-in, before the row is read.
    const profile = await store.getProfile();
    me = {
      id: store.user.id,
      name: profile.name
        ?? pref(uidKey + ':name',
             store.user.user_metadata?.name ?? store.user.email?.split('@')[0] ?? 'You'),
      color: profile.color ?? pref(uidKey + ':color', COLORS[0].hex),
    };
    setPref(uidKey + ':name', me.name);
    setPref(uidKey + ':color', me.color);
    $('#auth').hidden = true;
  }

  bindTools();
  bindStart();
  bindSelection();
  bindNoteDialog();
  bindWhoDialog();
  bindPeople();
  bindShareDialog();
  syncWhoButton();
  await renderShelf();
  await handleInviteLink();
  // Only now is it known that no auth gate is coming (and whether an invite already
  // opened a book), so this is the first moment the drop screen can appear without
  // flashing beneath a sign-in overlay.
  if (!docId) $('#start').hidden = false;
  $('#boot').hidden = true;
}

/* ------------------------------------------------------------------- auth */
function showAuth() {
  $('#boot').hidden = true;
  $('#auth').hidden = false;
  const code = params.get('join');
  if (code) {
    $('#auth-lede').textContent =
      'Someone shared a book with you. Sign in and it opens straight to it.';
  }
  $('#auth-go').onclick = async () => {
    const email = $('#auth-email').value.trim();
    const msg = $('#auth-msg');
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      msg.dataset.kind = 'error';
      msg.textContent = 'That address looks incomplete.';
      return;
    }
    $('#auth-go').disabled = true;
    // Send them back to the same URL, invite code and all, so the link survives the
    // round trip through their inbox.
    const { error } = await store.signIn(email, location.href);
    $('#auth-go').disabled = false;
    msg.dataset.kind = error ? 'error' : 'sent';
    msg.textContent = error
      ? error.message
      : 'Check ' + email + '. The link signs you in — no password.';
  };
  $('#auth-email').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#auth-go').click();
  });
}

/* ----------------------------------------------------------------- invites */
/**
 * Two kinds of link arrive on the same ?join= parameter. A book invite opens the book, as
 * it always did. A connect invite only links the two accounts, so it lands on the people
 * screen \u2014 there is no book to open, and dropping the user on an empty shelf after they
 * clicked an invitation reads as a failure.
 *
 * The parameter keeps its old name so links already sent still work.
 */
async function handleInviteLink() {
  const code = params.get('join');
  if (!code) return;
  if (!isHosted()) return toast('This copy of Marginalia runs only in this browser, so there’s nobody to invite.');

  try {
    const { kind, docId: id } = await store.redeemInvite(code, me.name);
    // Strip the code once it's been redeemed, so a reload isn't a second join and
    // the URL in the address bar stops being a live credential.
    history.replaceState({}, '', location.pathname);

    if (kind === 'book' && id) {
      const docs = await store.listDocuments();
      const doc = docs.find((d) => d.id === id);
      await openDoc(id, {
        title: doc?.title ?? 'Shared book', author: doc?.author, format: doc?.format,
      });
      toast('You\u2019re in.');
      return;
    }

    await renderShelf();
    await showPeople();
    toast('You\u2019re connected.');
  } catch (e) {
    toast(e.message);
  }
}

/**
 * A book invite. Single-use and dated by default (see createInvite in the adapter), which
 * is what replaced the old two-reader cap: the cap used to be the thing that made a
 * leaked link stop mattering, and with the cap gone the token has to carry that itself.
 */
async function copyInviteFrom(btn, invite) {
  if (!isHosted()) {
    return toast('This copy of Marginalia runs only in this browser, so there’s nobody to invite.');
  }
  btn.disabled = true;
  try {
    const { code } = await store.createInvite(invite);
    const url = location.origin + location.pathname + '?join=' + code;
    try {
      await navigator.clipboard.writeText(url);
      flashCopied(btn);
    } catch {
      // Clipboard needs a secure context and a user gesture; if either is missing,
      // show the link rather than silently doing nothing.
      prompt('Send them this link:', url);
    }
  } catch (e) {
    // Same top-layer problem: an error raised from inside the share sheet can't be a toast.
    if ($('#share-dlg').open) shareMsg(e.message, 'error');
    else toast(e.message);
  } finally {
    btn.disabled = false;
  }
}

const copyInvite = () => copyInviteFrom($('#share-invite'), { kind: 'book', docId });
const copyConnectInvite = () => copyInviteFrom($('#people-invite'), { kind: 'connect' });

/**
 * Confirmation lands on the button rather than in a toast. A <dialog> renders in the
 * browser's top layer, above every z-index on the page, so a toast fired from inside the
 * share sheet came up behind its own modal.
 */
function flashCopied(btn) {
  const label = btn.querySelector('.lbl');
  btn._label ??= label.textContent;
  // Single-use only. The fourteen-day expiry is the other half of the rule, but it's
  // static text in the share sheet: nobody copies a link and sits on it for a fortnight,
  // so it can't compete for room in a label that has 3 seconds to say "Copied".
  label.textContent = 'Copied — this link works once';
  btn.dataset.copied = 'true';
  clearTimeout(btn._copyTimer);
  btn._copyTimer = setTimeout(() => {
    label.textContent = btn._label;
    delete btn.dataset.copied;
  }, 3200);
}


/* -------------------------------------------------------------------- shelf
   The library is the screen you actually live on: you add a book a handful of
   times and open one every session. So the shelf gets the covers and the top of
   the screen, and the drop zone shrinks to a strip beneath it — until there's
   nothing on the shelf, when `data-empty` hands the screen back to the drop zone
   because a first run has nothing else to say. */

/**
 * Two numbers off the title, used as the fallback jacket's gradient. Deterministic
 * on purpose: a book keeps the same jacket across sessions and across the two
 * readers, which is what makes it recognizable at a glance rather than decoration.
 */
function jacketColors(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  // Held dark and desaturated so the serif title on top stays well past 4.5:1 for
  // every hue the hash can land on — see README "Accessibility".
  return [`hsl(${hue} 28% 26%)`, `hsl(${(hue + 34) % 360} 32% 14%)`];
}

/**
 * A person's color as a plain dot. Used by the people list, the share sheet, the reader
 * picker, and the stack on a book cover — one element, sized by a custom property so the
 * callers don't each need their own class.
 *
 * No initials in it. A reader's color is already the thing that identifies them
 * everywhere else in the app (their highlights, their marker on the spine), so the dot
 * only has to be that color; letters inside it were a second, worse identifier competing
 * with the first. They also can't be derived reliably — "Pumpkin (you)" reads as two
 * words and came out as "P(".
 *
 * Always aria-hidden: it carries nothing the surrounding text doesn't already say.
 */
function avatarEl(person, size) {
  const el = document.createElement('span');
  el.className = 'avatar';
  if (size) el.style.setProperty('--avatar-size', size + 'px');
  el.style.setProperty('--avatar-color', person.color ?? COLORS[0].hex);
  el.setAttribute('aria-hidden', 'true');
  return el;
}

/** #t-who's name and color dot. Its own function (rather than setting textContent
 * inline) because the dot needs to change alongside the name every time it does —
 * once at boot, once on every save in the who dialog. */
function syncWhoButton() {
  $('#who-label').textContent = me.name;
  $('#who-avatar').style.setProperty('--avatar-color', me.color);
}

/**
 * A person as a list row: disc, name, one line of context, and an optional action.
 * Shared by the people screen and the share sheet, which want the same object with
 * different verbs attached.
 *
 * The row is a <div>. The disclosure and the action are siblings inside it, because a
 * button nested in a button is invalid and the inner one is unreachable by keyboard.
 */
function personRow(person, { meta, action, onToggle, controls } = {}) {
  const row = document.createElement('div');
  row.className = 'row';
  if (person.revokedAt) row.dataset.revoked = 'true';
  row.appendChild(avatarEl(person));

  // The name block is a button only when there's something to disclose; otherwise it's
  // static text and must not look or behave like a control.
  const main = document.createElement(onToggle ? 'button' : 'div');
  main.className = 'row-main';
  if (onToggle) {
    main.type = 'button';
    main.setAttribute('aria-expanded', 'false');
    if (controls) main.setAttribute('aria-controls', controls);
    main.onclick = () => onToggle(main);
  }

  const text = document.createElement('span');
  text.className = 'row-text';
  const name = document.createElement('span');
  name.className = 'row-name';
  name.textContent = person.name;
  text.appendChild(name);
  if (meta) {
    const m = document.createElement('span');
    m.className = 'row-meta';
    m.textContent = meta;
    text.appendChild(m);
  }
  main.appendChild(text);

  if (onToggle) {
    const chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chev.setAttribute('class', 'row-chev');
    chev.setAttribute('viewBox', '0 0 24 24');
    chev.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', 'M9 5l7 7-7 7');
    chev.appendChild(p);
    main.appendChild(chev);
  }
  row.appendChild(main);

  if (action) {
    const act = document.createElement('button');
    act.type = 'button';
    act.className = 'row-act';
    act.textContent = action.label;
    // The visible label is a bare verb, which says nothing out of context.
    act.setAttribute('aria-label', `${action.label} ${person.name}`);
    act.onclick = action.onClick;
    row.appendChild(act);
  }

  return row;
}

function bookCard(d, { onOpen, onDelete, members = [] } = {}) {
  const card = document.createElement('div');
  card.className = 'book';

  const open = document.createElement('button');
  open.className = 'book-open';
  // The card is one button with one name. Cover, title, author, and the reader stack
  // are all the same target, so the accessible name says the whole thing once instead
  // of four times — the discs in particular are aria-hidden and named only here.
  // Not `others` — that's the module-level function for the open book's readers, and
  // this is a shelf card for a book that isn't open.
  const otherReaders = members.filter((m) => m.userId !== me.id);
  const shared = otherReaders.length
    ? `, shared with ${otherReaders.map((m) => m.name).join(', ')}`
    : '';
  open.setAttribute('aria-label',
    `Open ${d.title}${d.author ? `, by ${d.author}` : ''} (${d.format.toUpperCase()})${shared}`);

  const cover = document.createElement('div');
  cover.className = 'cover';
  if (d.cover) {
    const img = document.createElement('img');
    img.src = d.cover;
    // The card's own label already names the book; a repeated alt makes a screen
    // reader say the title twice for one control.
    img.alt = '';
    cover.appendChild(img);
  } else {
    const [a, b] = jacketColors(d.title);
    const jacket = document.createElement('div');
    jacket.className = 'jacket';
    jacket.style.setProperty('--jacket-a', a);
    jacket.style.setProperty('--jacket-b', b);
    jacket.innerHTML =
      `<div class="jt">${escape(d.title)}</div>` +
      (d.author ? `<div class="ja">${escape(d.author)}</div>` : '');
    cover.appendChild(jacket);
  }
  const fmt = document.createElement('span');
  fmt.className = 'fmt';
  fmt.textContent = d.format.toUpperCase();
  cover.appendChild(fmt);

  // Who else is in this book, without opening it. Capped at three discs plus a count,
  // because past that they stop being recognizable faces and become a smear.
  if (otherReaders.length) {
    const stack = document.createElement('span');
    stack.className = 'stack';
    for (const m of otherReaders.slice(0, 4)) stack.appendChild(avatarEl(m));
    // The overflow count is text, so it can't be an avatar — those are plain dots now.
    if (otherReaders.length > 4) {
      const more = document.createElement('span');
      more.className = 'stack-more';
      more.textContent = `+${otherReaders.length - 4}`;
      stack.appendChild(more);
    }
    cover.appendChild(stack);
  }

  open.appendChild(cover);

  const title = document.createElement('div');
  title.className = 'book-title';
  title.textContent = d.title;
  open.appendChild(title);

  if (d.author) {
    const author = document.createElement('div');
    author.className = 'book-author';
    author.textContent = d.author;
    open.appendChild(author);
  }

  open.onclick = onOpen;
  card.appendChild(open);

  // Omitted where the card is just a reference to a book — the people screen lists the
  // books you share with someone, and deleting one from there would be a trapdoor.
  if (onDelete) {
    const del = document.createElement('button');
    del.className = 'book-del';
    del.title = 'Delete this book';
    del.setAttribute('aria-label', `Delete ${d.title}`);
    del.textContent = '✕';
    del.onclick = onDelete;
    card.appendChild(del);
  }

  return card;
}

async function renderShelf() {
  let docs;
  try {
    docs = await store.listDocuments();
  } catch (e) {
    toast(`Couldn’t load your books: ${e.message}`);
    return;
  }
  const el = $('#recent');
  el.innerHTML = '';
  // Drives the whole start screen's layout: shelf-first, or drop-zone-first when
  // there's nothing to open yet.
  $('#start').dataset.empty = String(!docs.length);
  $('#shelf').hidden = !docs.length;
  // Deliberately not awaited: the duplicates banner is independent of the shelf and
  // must never delay it. With no books there is nothing to be a duplicate of.
  if (docs.length) renderDupes();
  if (!docs.length) return;

  // One request for every book's readers, not one per card. A shelf of forty books
  // would otherwise open forty connections before it drew anything. A failure here
  // costs the badges and nothing else, so it must not take the shelf down with it.
  let membersByDoc = new Map();
  try {
    membersByDoc = await store.listMembersByDocument(docs.map((d) => d.id));
  } catch {
    /* badges are a nicety; the shelf still opens books without them */
  }

  // Built detached and appended once: forty cards appended individually is forty
  // chances for the browser to reflow a grid it is going to rewrite anyway.
  const frag = document.createDocumentFragment();

  for (const d of docs) {
    const card = bookCard(d, {
      members: membersByDoc.get(d.id) ?? [],
      onOpen: () => openDoc(d.id, d),
      onDelete: async (e) => {
        e.stopPropagation();
        const otherReaders = (membersByDoc.get(d.id) ?? []).filter((m) => m.userId !== me.id);
        // The old copy said "for both of you" unconditionally, which was wrong the
        // moment a book could have one reader or four.
        const who = otherReaders.length
          ? ` This removes it — and its highlights and notes — for ${otherReaders.map((m) => m.name).join(', ')} too.`
          : ' This removes it, and its highlights and notes.';
        if (!confirm(`Delete "${d.title}"?${who}`)) return;
        try {
          await store.deleteDocument(d.id);
          await renderShelf();
        } catch (err) {
          toast(err.message ?? 'That book didn’t delete.');
        }
      },
    });
    frag.appendChild(card);

    // After the card is on screen, not before: the jacket is a real answer, so the
    // shelf never waits on a thumbnail it may not even be able to produce.
    if (!d.cover) {
      backfillCover(d).then((cover) => {
        if (!cover || !card.isConnected) return;
        const img = document.createElement('img');
        img.src = cover;
        img.alt = '';
        card.querySelector('.cover .jacket')?.replaceWith(img);
      });
    }
  }

  el.appendChild(frag);
}

/* --------------------------------------------------------------- duplicates
   You added a book; someone shared you their copy of the same file. Two rows,
   two ids, and no highlight passes between them.

   Merging is only ever offered for byte-identical files, and that restriction is
   the whole reason it's safe. Every anchor the app stores belongs to one
   particular file: PDF highlights are page rects plus indexes into that file's
   text-item array, EPUB highlights are CFIs into that build's DOM. Move them to a
   different scan of the same book and they land on the wrong words. Move them
   between two copies of identical bytes and every one of them still fits.

   You can only ever give up a copy you added yourself — see merge_documents. */

const DISMISSED_DUPES = 'marginalia:dupes-dismissed';

function dismissedDupes() {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISSED_DUPES) ?? '[]'));
  } catch {
    return new Set();
  }
}

async function renderDupes() {
  const section = $('#dupes');
  const list = $('#dupes-list');
  list.innerHTML = '';
  section.hidden = true;
  if (!isHosted()) return;

  let dupes;
  try {
    dupes = await store.listDuplicates();
  } catch {
    return; // a nicety; never let it take the shelf down
  }

  const dismissed = dismissedDupes();
  dupes = dupes.filter((d) => !dismissed.has(`${d.mineId}:${d.theirsId}`));
  if (!dupes.length) return;

  section.hidden = false;
  const frag = document.createDocumentFragment();
  for (const d of dupes) frag.appendChild(dupeRow(d));
  list.appendChild(frag);
}

function dupeRow(d) {
  const row = document.createElement('div');
  row.className = 'row';

  const main = document.createElement('div');
  main.className = 'row-main';
  const name = document.createElement('span');
  name.className = 'row-name';
  name.textContent = d.mineTitle;
  const note = document.createElement('span');
  note.className = 'row-note';
  note.textContent =
    `You and ${d.ownerName} each added this, and the files are identical. ` +
    `Merge and you'll read the same copy — every highlight either of you has ` +
    `already made stays exactly where it is.`;
  main.append(name, note);

  const acts = document.createElement('div');
  acts.className = 'row-acts';

  const merge = document.createElement('button');
  merge.type = 'button';
  merge.className = 'btn primary';
  merge.textContent = 'Merge';
  merge.setAttribute('aria-label', `Merge your copy of ${d.mineTitle} into ${d.ownerName}'s`);
  merge.onclick = () => mergeDupe(d, merge);

  const keep = document.createElement('button');
  keep.type = 'button';
  keep.className = 'btn';
  keep.textContent = 'Keep separate';
  keep.setAttribute('aria-label', `Keep both copies of ${d.mineTitle}`);
  keep.onclick = () => {
    const dismissed = dismissedDupes();
    dismissed.add(`${d.mineId}:${d.theirsId}`);
    setPref(DISMISSED_DUPES, JSON.stringify([...dismissed]));
    renderDupes();
  };

  acts.append(merge, keep);
  row.append(main, acts);
  return row;
}

async function mergeDupe(d, btn) {
  if (!confirm(
    `Merge your copy of "${d.mineTitle}" into ${d.ownerName}'s?\n\n` +
    `Your highlights and your place move across and stay where they are — the files ` +
    `are identical, so every one of them still fits. Your copy of the book is then ` +
    `removed. This can't be undone.`
  )) return;

  btn.disabled = true;
  showLoading('Merging…');
  try {
    // theirs is kept, mine is given up. The server enforces that direction; passing
    // them the other way round would be refused rather than silently deleting a book
    // that isn't ours.
    await store.mergeDocuments(d.theirsId, d.mineId);
    // The open book may be the one that just stopped existing.
    if (docId === d.mineId) closeDoc();
    await renderShelf();
    await renderDupes();
    toast('Merged. You’re reading the same copy now.');
  } catch (e) {
    btn.disabled = false;
    toast(e.message);
  } finally {
    hideLoading();
  }
}

/* ------------------------------------------------------------------- people
   Who you read with, and what you hold in common. The count answers the
   question most of the time, so the covers are a disclosure rather than the
   default — and they're fetched only when a row is opened, which keeps the
   screen one request no matter how many people are on it. */

// userId -> books. Survives re-renders within a session; cleared when a share
// changes, since that's exactly when it would be wrong.
const sharedBooksCache = new Map();

async function showPeople() {
  $('#start').hidden = true;
  $('#people').hidden = false;
  // Books is how you leave, the same as from a book — so it has to be live here even
  // though no book is open.
  $('#t-home').disabled = false;
  // And the same rule Books follows over the shelf: the button for the screen you're
  // already on is greyed, not a click that does nothing.
  $('#t-people').disabled = true;
  await renderPeople();
  // Announce the screen, not the first row. Focus has to land somewhere, and a
  // heading says where you are.
  $('#people-head').focus();
}

function hidePeople() {
  $('#people').hidden = true;
  $('#start').hidden = false;
  $('#t-home').disabled = !docId;
  $('#t-people').disabled = false;
}

/**
 * Guards against two renders overlapping. saveProfile writes a display_name to every one
 * of your membership rows, and each write comes back down the realtime socket as its own
 * change — so changing your name fired a burst of renderPeople() calls. Each one cleared
 * the list, awaited the fetch, then appended, and two interleaved appends put every
 * contact on screen twice. Only the newest render is allowed to touch the DOM, and it
 * clears immediately before appending rather than before awaiting.
 */
let peopleRenderSeq = 0;

async function renderPeople() {
  const seq = ++peopleRenderSeq;
  const list = $('#people-list');

  if (!isHosted()) {
    list.innerHTML =
      '<div class="empty">This copy of Marginalia runs only in this browser.<br>' +
      'Your books and notes never leave it, and there’s no one to connect to.<br>' +
      'Connecting people needs the hosted setup — see the project README.</div>';
    return;
  }

  let people;
  try {
    people = await store.listConnections();
  } catch (e) {
    if (seq !== peopleRenderSeq) return;
    list.innerHTML = `<div class="empty">${escape(e.message)}</div>`;
    return;
  }
  if (seq !== peopleRenderSeq) return;

  if (!people.length) {
    list.innerHTML =
      '<div class="empty">Nobody yet.<br>Send someone an invite link and they’ll show up here.</div>';
    return;
  }

  // Which rows were open, so a re-render triggered by something unrelated (a rename
  // arriving over the socket) doesn't collapse a shelf you were looking at.
  const wasOpen = new Set(
    [...list.querySelectorAll('.person[data-open="true"]')].map((el) => el.dataset.userId)
  );

  const frag = document.createDocumentFragment();
  for (const p of people) frag.appendChild(personCard(p, wasOpen.has(p.userId)));
  list.innerHTML = '';
  list.appendChild(frag);
}

function personCard(p, startOpen = false) {
  const wrap = document.createElement('div');
  wrap.className = 'person';
  wrap.dataset.userId = p.userId;

  // The disclosed region is the panel, not the shelf inside it: opening a person
  // reveals both what you share with them and what you can do about it.
  const panelId = `person-panel-${p.userId}`;
  const panel = document.createElement('div');
  panel.className = 'person-panel';
  panel.id = panelId;
  panel.hidden = true;

  const books = document.createElement('div');
  books.className = 'person-books';

  const meta = p.status === 'pending'
    ? 'Invite not accepted yet'
    : p.bookCount === 0
      ? 'No books in common yet'
      : p.bookCount === 1 ? '1 book together' : `${p.bookCount} books together`;

  const row = personRow(p, {
    meta,
    controls: panelId,
    onToggle: (btn) => toggleSharedBooks(p, btn, panel, books),
  });

  // Spelled out, and only where you've already asked to see this person in full: as a
  // bare ✕ parked on the card it was the one control on the screen whose meaning you
  // had to guess, and guessing wrong disconnects someone.
  const foot = document.createElement('div');
  foot.className = 'person-foot';
  const act = document.createElement('button');
  act.type = 'button';
  act.className = 'btn danger';
  act.textContent = 'Disconnect';
  // The visible label is a bare verb, which says nothing out of context.
  act.setAttribute('aria-label', `Disconnect from ${p.name}`);
  act.onclick = () => disconnectPerson(p);
  foot.appendChild(act);

  panel.append(books, foot);
  wrap.append(row, panel);
  if (startOpen) toggleSharedBooks(p, row.querySelector('.row-main'), panel, books);
  return wrap;
}

async function toggleSharedBooks(p, btn, panel, container) {
  const open = btn.getAttribute('aria-expanded') === 'true';
  btn.setAttribute('aria-expanded', String(!open));
  panel.hidden = open;
  // Drives the card's border: closed, the row is the whole object and needs no divider.
  panel.closest('.person').dataset.open = String(!open);
  if (open || container.dataset.loaded === 'true') return;

  container.innerHTML = '<div class="empty">Loading…</div>';
  try {
    let books = sharedBooksCache.get(p.userId);
    if (!books) {
      books = await store.listSharedBooks(p.userId);
      sharedBooksCache.set(p.userId, books);
    }
    container.innerHTML = '';
    if (!books.length) {
      container.innerHTML =
        '<div class="empty">No books in common yet.<br>Open one and use Invite to share it.</div>';
    } else {
      const frag = document.createDocumentFragment();
      for (const d of books) {
        frag.appendChild(bookCard(d, {
          onOpen: () => {
            hidePeople();
            openDoc(d.id, d);
          },
        }));
      }
      container.appendChild(frag);
    }
    container.dataset.loaded = 'true';
  } catch (e) {
    container.innerHTML = `<div class="empty">${escape(e.message)}</div>`;
  }
}

async function disconnectPerson(p) {
  if (!confirm(
    `Disconnect from ${p.name}? Books you've already shared stay shared — ` +
    `remove those from each book's reader list.`
  )) return;
  try {
    await store.disconnect(p.userId);
    sharedBooksCache.delete(p.userId);
    await renderPeople();
    toast(`Disconnected from ${p.name}.`);
  } catch (e) {
    toast(e.message);
  }
}

/* ------------------------------------------------------------------ opening */
function bindStart() {
  const drop = $('#drop');
  // Two doors to the same picker: the shelf header's "Add a book" and the empty
  // state's big button. Which one is on screen is a CSS question (see
  // #start[data-empty]), not a JS one.
  for (const id of ['#pick', '#pick-big']) {
    $(id).onclick = () => $('#file').click();
  }
  $('#file').onchange = (e) => {
    if (e.target.files[0]) ingest(e.target.files[0]);
    // Cleared so picking the same file twice in a row still fires a change event.
    e.target.value = '';
  };

  for (const ev of ['dragenter', 'dragover']) {
    document.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('over');
    });
  }
  document.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) drop.classList.remove('over');
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer?.files?.[0];
    if (f) ingest(f);
  });
}

function detectFormat(file) {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'pdf';
  if (file.type === 'application/epub+zip' || /\.epub$/i.test(file.name)) return 'epub';
  return null;
}

/* ------------------------------------------------------------------- covers
   The shelf wants a picture of the book, and both formats can give one: EPUB
   names a cover image in its manifest, and a PDF's first page *is* its cover.
   Both get downscaled to a thumbnail and stored as a data: URL beside the
   title, so drawing the library is one IndexedDB read and no rendering. */
const COVER_W = 300;

/** Draw any image source into a 2:3-ish thumbnail and return a JPEG data: URL. */
function thumbnail(source, w, h) {
  const scale = Math.min(1, COVER_W / w);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  // White, not transparent: JPEG has no alpha, and a page rendered on a transparent
  // canvas composites to black instead of paper.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.82);
}

async function pdfCover(pdf) {
  const page = await pdf.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const scale = Math.min(1, COVER_W / vp.width) * (window.devicePixelRatio > 1 ? 1.5 : 1);
  const view = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(view.width);
  canvas.height = Math.round(view.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: view }).promise;
  return canvas.toDataURL('image/jpeg', 0.82);
}

async function epubCover(book) {
  const url = await book.coverUrl(); // null when the OPF declares no cover
  if (!url) return null;
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    return thumbnail(img, img.naturalWidth, img.naturalHeight);
  } finally {
    // coverUrl() mints a blob: URL that lives until the document does.
    URL.revokeObjectURL(url);
  }
}

/**
 * The book's own metadata beats its filename — files arrive named things like
 * "Title _ Subtitle -- Author -- Reprint, 2013 -- Publisher -- isbn13 ... .epub".
 * EPUB carries dc:title/dc:creator in the OPF; PDF has Title/Author in its Info
 * dictionary. Any of it can be missing or junk, so the filename stays the fallback
 * for the title and the other two are simply allowed to be null — the shelf draws a
 * typeset jacket when there's no cover, which is why nothing here has to succeed.
 *
 * One open of the file, not two: the same parse that reads the metadata renders the
 * cover, because opening a 10MB book is the expensive part and doing it twice on the
 * way in is the slowest thing a user would feel.
 */
async function readBookMeta(file, format) {
  const out = { title: null, author: null, cover: null };
  try {
    if (format === 'epub') {
      const ePub = (await import('https://esm.sh/epubjs@0.3.93')).default;
      const book = ePub(await file.arrayBuffer());
      // ready, not just loaded.metadata: destroy() while the rest of the opening
      // pipeline (navigation, displayOptions) is still in flight throws inside epub.js.
      await book.ready;
      const meta = await book.loaded.metadata;
      out.title = meta?.title?.trim() || null;
      out.author = meta?.creator?.trim() || null;
      out.cover = await epubCover(book).catch(() => null);
      book.destroy();
    } else {
      const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      const { info } = await pdf.getMetadata().catch(() => ({ info: {} }));
      out.title = info?.Title?.trim() || null;
      out.author = info?.Author?.trim() || null;
      out.cover = await pdfCover(pdf).catch(() => null);
      await pdf.destroy();
    }
  } catch {
    /* unreadable metadata is not an error — the filename below still works */
  }
  out.title ??= file.name.replace(/\.(pdf|epub)$/i, '');
  return out;
}

/**
 * Books shelved before covers existed have none stored. Rather than leave them as
 * permanent fallback jackets, derive one from the bytes already on this device the
 * first time the shelf draws them, and write it back so it's paid for once.
 *
 * PDF only, and local mode only. Hosted books have no local bytes to re-read (a
 * cover would mean pulling the whole file back down), and an EPUB backfill would
 * mean loading epub.js on the library screen for a session that may never open one.
 * Both cases keep the jacket, which is a fallback, not a failure.
 */
async function backfillCover(doc) {
  if (doc.cover || doc.format !== 'pdf' || !store.saveDocumentCover) return null;
  try {
    const source = await store.getDocumentSource(doc.id);
    if (!source?.data) return null;
    const pdf = await pdfjsLib.getDocument({ data: source.data }).promise;
    const cover = await pdfCover(pdf);
    await pdf.destroy();
    await store.saveDocumentCover(doc.id, { cover });
    return cover;
  } catch {
    return null; // a book that won't render a thumbnail still opens fine
  }
}

async function ingest(file) {
  const format = detectFormat(file);
  if (!format) {
    toast('That file isn’t a PDF or EPUB.');
    return;
  }
  // Locally this is an IndexedDB write and effectively instant; hosted, it's the whole
  // book going up to storage, which is the longest wait in the app.
  showLoading(isHosted() ? 'Uploading…' : 'Opening…');
  try {
    const meta = await readBookMeta(file, format);
    const { docId: id, title, author } = await store.putDocument(file, format, meta);
    await openDoc(id, { title, author, format });
  } catch (e) {
    hideLoading();
    toast(e.message ?? 'That book didn’t upload.');
  }
}

/**
 * `doc` is a shelf record — {title, author, format} — not a bare title, because
 * every call site already has the whole row and the topbar wants the author too.
 */
async function openDoc(id, doc = {}) {
  const { title = 'Untitled', author = null } = doc;
  const format = doc.format ?? 'pdf';
  // Also covers reopening from the shelf and landing via an invite link, which
  // don't go through ingest().
  showLoading('Opening…');
  unsubscribe?.();
  unsubscribe = null;
  reader?.destroy();
  reader = format === 'epub'
    // Lazy-loaded so a PDF-only session never pays for epub.js/JSZip. esm.sh, not
    // jsdelivr's /+esm: the latter emits epub.js's transitive es5-ext dep as a
    // separate module URL with a null-byte path that browsers reject via CORS.
    ? new EpubReader($('#pages'), (await import('https://esm.sh/epubjs@0.3.93')).default)
    : new Reader($('#pages'), pdfjsLib);

  docId = id;
  $('#title').textContent = title;
  $('#byline').textContent = author ?? '';
  $('#byline').hidden = !author;
  $('#start').hidden = true;
  $('#t-home').disabled = false;
  // Gates the reading controls (tools, zoom) in CSS: they mean nothing over a shelf.
  app.dataset.open = 'true';
  app.dataset.format = reader.kind;
  // Ink has no coherent anchor on reflowable text — see README "known gaps". Disabled
  // rather than hidden: a missing Draw button reads as a bug, a greyed one with this
  // tooltip reads as a rule. Force back to select so a tool chosen for the previous
  // book can't get stuck on.
  const isEpub = reader.kind === 'epub';
  $('#t-ink').disabled = isEpub;
  $('#t-erase').disabled = isEpub;
  $('#t-ink').title = isEpub
    ? 'Ink needs a fixed page — PDF only' : 'Draw with a stylus (a pen always draws)';
  $('#t-erase').title = isEpub ? 'Ink needs a fixed page — PDF only' : 'Erase your own ink';
  if (isEpub && tool !== 'select') setTool('select');

  const source = await store.getDocumentSource(id);
  if (!source) {
    hideLoading();
    toast('That book is no longer on this device.');
    delete app.dataset.open;
    delete app.dataset.format;
    $('#start').hidden = false;
    return;
  }
  // Shown in both modes now: it opens the reader list, which local mode can answer
  // (the ?me= tabs are real members). Only the copy-a-link button inside needs a server,
  // and it disables itself with a reason.
  $('#t-invite').hidden = false;
  $('#people').hidden = true;

  await store.saveMember(id, { userId: me.id, name: me.name, color: me.color });
  [annotations, members, progress] = await Promise.all([
    store.listAnnotations(id),
    store.listMembers(id),
    store.getProgress(id),
  ]);

  // EPUB pays for its position model up front: book.locations.generate() walks the
  // entire spine before the first page can be shown. Worth naming, since it's the
  // longest wait after the upload.
  showLoading(reader.kind === 'epub' ? 'Preparing the book…' : 'Opening…');
  const count = await reader.load(source);
  $('#spine-bot').textContent = String(count);

  reader.getInkState = () => ({ inkMode: tool === 'ink', color: me.color });
  reader.onInkCommit = commitStroke;
  reader.onSelectionChange = handleSelection;
  reader.onProgress = async (p) => {
    await store.saveProgress(docId, me.id, p);
    progress[me.id] = { ...p, userId: me.id, updatedAt: Date.now() };
    renderSpine();
  };
  reader.renderAnnotations = renderAnnotations;
  syncZoomUI();
  await applyTextVerdict();

  unsubscribe = store.subscribe(id, onRemoteChange);

  const mine = progress[me.id];
  if (mine) {
    await reader.goTo(mine);
    toast(mine.page != null ? `Back on page ${mine.page}.` : `Back where you left off — ${posLabel(mine)} through.`);
  } else {
    // Opening the book is itself a position. Without this, a reader who hasn't
    // scrolled yet has no progress row, so they're invisible on the other person's
    // spine — they've opened the book and their partner can't tell.
    const initial = reader.position();
    await store.saveProgress(id, me.id, initial);
    progress[me.id] = { ...initial, userId: me.id, updatedAt: Date.now() };
  }
  renderAnnotations();
  renderPanel();
  renderSpine();
  // Last thing: the overlay hides the half-rendered book until it's actually readable.
  hideLoading();
}

/** Back to the library. The inverse of openDoc, resetting everything it set. */
function closeDoc() {
  unsubscribe?.();
  unsubscribe = null;
  reader?.destroy();
  reader = null;
  docId = null;
  annotations = [];
  members = [];
  progress = {};
  closePopover();
  hideLoading();
  hideNotice();
  // Before setTool, which refuses to select a disabled tool — a scan closed while
  // Select was greyed out would otherwise leave the library stuck in Draw.
  $('#t-select').disabled = false;
  $('#t-select').title = 'Select text to highlight';
  setTool('select');
  $('#title').textContent = '';
  $('#byline').textContent = '';
  $('#byline').hidden = true;
  $('#t-home').disabled = true;
  $('#t-invite').hidden = true;
  $('#t-ink').disabled = false;
  $('#t-erase').disabled = false;
  $('#zoom-in').disabled = true;
  $('#zoom-out').disabled = true;
  $('#zoom').textContent = '—';
  $('#spine-bot').textContent = '—';
  $('#track').querySelectorAll('.tick, .marker').forEach((n) => n.remove());
  $('#gap').textContent = '';
  $('#between').hidden = true;
  $('#jump-label').textContent = 'Find them';
  $('#note-count').textContent = '';
  $('#notes').innerHTML = '';
  delete app.dataset.format;
  delete app.dataset.open;
  // People and the shelf share a z-index; leaving People up would stack the two.
  $('#people').hidden = true;
  $('#t-people').disabled = false;
  $('#start').hidden = false;
  renderShelf();
}

/* --------------------------------------------------------- remote changes */
function onRemoteChange(change) {
  if (change.kind === 'annotation') {
    const i = annotations.findIndex((a) => a.id === change.row.id);
    if (change.row.deletedAt) {
      if (i >= 0) annotations.splice(i, 1);
    } else if (i >= 0) {
      // Last write wins. Rows are per-user and only their author edits them, so a
      // real conflict needs the same person in two tabs on the same note.
      if (change.row.updatedAt >= annotations[i].updatedAt) annotations[i] = change.row;
    } else {
      annotations.push(change.row);
      if (change.row.userId !== me.id) {
        const where = posLabel({ page: change.row.pageNumber, percent: change.row.percent });
        toast(`${nameOf(change.row.userId)} marked up ${where}.`);
      }
    }
    renderAnnotations();
    renderPanel();
    renderSpine();
  }
  if (change.kind === 'progress') {
    progress[change.row.userId] = change.row;
    renderSpine();
  }
  if (change.kind === 'member') {
    const i = members.findIndex((m) => m.userId === change.row.userId);
    // A hard delete is a removal; a revoke is a state change that keeps the row, because
    // a reader who left their marks behind still needs a name beside them.
    if (change.row.removed) {
      if (i >= 0) members.splice(i, 1);
      delete progress[change.row.userId];
    } else {
      if (i >= 0) members[i] = change.row;
      else members.push(change.row);
      // Their place on the rail goes with their access. The membership row survives a
      // revoke; their position on it should not.
      if (change.row.revokedAt) delete progress[change.row.userId];
    }
    renderAnnotations();
    renderPanel();
    renderSpine();
  }
}

/* ------------------------------------------------- books with no text layer */

/**
 * A scanned PDF carries pictures of words, not words. Nothing in it can be selected,
 * so nothing in it can be highlighted or noted — only inked. That used to be silent:
 * you dragged across a paragraph, got nothing, and had no way to tell a scan from a
 * bug in the reader.
 *
 * Two answers, for two different books, because one check can't cover both:
 *   - here, once per book, for a scan (uniformly image-only — the common case);
 *   - `openNoTextPopover`, per drag, for the plate section inside a typeset book,
 *     which no book-level sample can see.
 */
async function applyTextVerdict() {
  const sel = $('#t-select');
  hideNotice();
  sel.disabled = false;
  sel.title = 'Select text to highlight';
  // EPUB is always text — that's what reflowable means.
  if (reader.kind !== 'pdf') return;

  const opened = docId;
  if (await reader.probeText()) return;
  if (docId !== opened) return; // book closed or swapped while we were sampling

  // Same treatment Draw gets on EPUB, and for the same reason: a tool that cannot
  // work should look unavailable and say why, not fail quietly when you use it.
  sel.disabled = true;
  sel.title = 'This scan has no text layer — there’s nothing to select';
  // Not a preference being overridden — Select is disabled, so leaving it active
  // would leave the toolbar pointing at a tool that does nothing.
  setTool('ink');
  showNotice(
    'This scan has no text layer, so there’s nothing to highlight.',
    'Ink still works — Draw is on.'
  );
}

function showNotice(msg, sub) {
  $('#notice-msg').textContent = msg;
  $('#notice-sub').textContent = sub;
  $('#notice').hidden = false;
}

function hideNotice() {
  $('#notice').hidden = true;
}

/**
 * The per-page half: shown where the cursor lifted, after a drag that could only have
 * been an attempt to highlight. Reactive on purpose — a typeset book with twenty
 * scanned plates shouldn't wear a warning for the other 300 pages.
 */
function openNoTextPopover(x, y) {
  const pop = $('#pop');
  pending = null;
  pop.dataset.kind = 'no-text';
  pop.innerHTML =
    '<div class="why">' + IMAGE_GLYPH +
    '<div><b>Nothing to select here</b>' +
    '<span>This page is an image — there’s no text layer to highlight.</span></div>' +
    '</div><hr>';
  const draw = document.createElement('button');
  draw.className = 'act';
  draw.innerHTML =
    '<svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:none;stroke:currentColor;' +
    'stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round">' +
    '<path d="M17 3l4 4L8 20l-5 1 1-5z"/></svg>Draw on it instead<span class="key">D</span>';
  draw.onclick = () => {
    setTool('ink');
    closePopover();
  };
  pop.appendChild(draw);
  placePopover(x, y);
}

/* ------------------------------------------------------------------- tools */
function setTool(t) {
  // Select is disabled on a book with no text layer, and the keyboard shortcut has to
  // respect that as much as the button does.
  if (t === 'select' && $('#t-select').disabled) return;
  tool = t;
  app.dataset.ink = t === 'ink' ? 'on' : 'off';
  // `data-ink` is the two-state switch the layers key off; `data-tool` carries the tool
  // itself, which is what the pencil/eraser cursors need (erase isn't "ink off").
  app.dataset.tool = t;
  $('#t-select').ariaPressed = String(t === 'select');
  $('#t-ink').ariaPressed = String(t === 'ink');
  $('#t-erase').ariaPressed = String(t === 'erase');
}

/** The margin panel's open/closed state, and everything that has to agree with it:
 * the toggle button's pressed state and tooltip, and — on mobile, where the panel is
 * a slide-over rather than a column (see max-width:900px) — the dimmed backdrop
 * behind it, driven off the same `data-panel` attribute in CSS. */
function setPanelOpen(open) {
  app.dataset.panel = open ? 'open' : 'closed';
  $('#t-panel').ariaPressed = String(open);
  // The glyph swap lives in CSS (data-panel); the tooltip has to follow it here.
  $('#t-panel').title = open ? 'Hide the margin' : 'Show the margin';
}

/** Stand-in for the hover tooltip on icon-only buttons (see .lbl in the mobile
 * breakpoint, which hides the text label and leaves `title` as the only description
 * left). Touch has no hover, so a hold shows it instead — same idiom as a native
 * tooltip: appears while held, gone the moment you let go. Delegated to `document`
 * rather than bound per-button, so it keeps working as the toolbar's buttons are
 * enabled/disabled/hidden around it. */
function bindLongPressTips() {
  const tip = $('#longpress-tip');
  let timer = null;
  let from = null;

  const place = (x, y) => {
    const r = tip.getBoundingClientRect();
    tip.style.left = Math.min(Math.max(8, x - r.width / 2), innerWidth - r.width - 8) + 'px';
    tip.style.top = Math.max(8, y - r.height - 12) + 'px';
  };
  const hide = () => {
    clearTimeout(timer);
    from = null;
    tip.dataset.show = 'false';
  };

  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    const el = e.target.closest?.('.tool[title]');
    if (!el || el.disabled) return;
    from = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      tip.textContent = el.title;
      tip.dataset.show = 'true';
      place(e.clientX, e.clientY);
    }, 500);
  });
  // A finger sliding off the button it landed on is a scroll, not a hold — the same
  // distinction bindSelection draws between a tap and a drag.
  document.addEventListener('pointermove', (e) => {
    if (!from || e.pointerType !== 'touch') return;
    if (Math.hypot(e.clientX - from.x, e.clientY - from.y) > 6) hide();
  });
  document.addEventListener('pointerup', hide);
  document.addEventListener('pointercancel', hide);
}

function bindTools() {
  // One "back to the library" control for both places you can be away from it: reading a
  // book, or looking at People. Two separate exits for the same destination was one more
  // than the nav needed.
  $('#t-home').onclick = () => {
    if (!$('#people').hidden) return hidePeople();
    closeDoc();
  };
  $('#t-select').onclick = () => setTool('select');
  $('#t-ink').onclick = () => setTool('ink');
  $('#t-erase').onclick = () => setTool('erase');

  $('#zoom-in').onclick = () => zoomBy(0.2);
  $('#zoom-out').onclick = () => zoomBy(-0.2);

  $('#t-panel').onclick = () => setPanelOpen(app.dataset.panel !== 'open');
  // Mobile only (see max-width:900px): the panel is a slide-over there, and the
  // dimmed area behind it is the other way to dismiss it — same action as the
  // button, just a bigger target. Inert on desktop; the backdrop stays display:none.
  $('#panel-backdrop').onclick = () => setPanelOpen(false);
  // The panel defaults open in markup, which is right for the desktop column but
  // would cover the whole book on first load where it's a slide-over instead.
  if (isMobile()) setPanelOpen(false);

  bindLongPressTips();

  // One other reader is still one click — the button goes straight there, as it always
  // did. More than one and there's a question to answer first, so it opens a picker.
  // The document-level pointerdown handler closes any open popover, and `click` fires
  // after `pointerup`, so opening one from here needs no guard against its own dismissal.
  $('#t-jump').onclick = () => {
    const rows = readerPositions();
    if (!rows.length) return toast('Nobody else has opened this book yet.');
    if (rows.length === 1) return reader?.goTo(rows[0], true);
    const r = $('#t-jump').getBoundingClientRect();
    openReadersPopover(rows, r.left + r.width / 2, r.bottom);
  };

  $('#t-who').onclick = openWhoDialog;
  // The button opens the reader list; copying a link is one action inside it. Sharing
  // stopped being "send a link" the moment a book could hold more than two people.
  $('#t-invite').onclick = openShareDialog;
  // Dismissing is per-open, not remembered: reopening a scan is exactly when you'd
  // want reminding, and the greyed-out Select is the standing reminder in between.
  $('#notice-ok').onclick = hideNotice;

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    // The tool keys match buttons that aren't on screen without a book open, so
    // they stay off too — a shortcut for an invisible control is a trap.
    if (reader) {
      if (e.key === 'v') setTool('select');
      // No ink on reflowable text — see README "known gaps" — so these are PDF-only.
      if (e.key === 'd' && reader.kind !== 'epub') setTool('ink');
      if (e.key === 'e' && reader.kind !== 'epub') setTool('erase');
    }
    if (e.key === 'Escape') closePopover();
    if ((e.metaKey || e.ctrlKey) && e.key === '=') { e.preventDefault(); zoomBy(0.2); }
    if ((e.metaKey || e.ctrlKey) && e.key === '-') { e.preventDefault(); zoomBy(-0.2); }
  });
}

// Every zoom path goes through here, because `reader` is null until a book is open —
// there's a real window (the upload, which is the longest wait in the app) where the
// toolbar is on screen and pressing cmd+- would otherwise throw.
function zoomBy(delta) {
  if (!reader) return;
  setZoom(reader.scale + delta);
}

async function setZoom(s) {
  if (!reader) return;
  await reader.setScale(s);
  syncZoomUI();
  renderAnnotations();
}

/** Label + button state. Disabled at a limit, so the edge is visible, not silent. */
function syncZoomUI() {
  if (!reader) return;
  $('#zoom').textContent = Math.round(reader.scale * 100) + '%';
  $('#zoom-out').disabled = reader.scale <= reader.minScale + 1e-6;
  $('#zoom-in').disabled = reader.scale >= reader.maxScale - 1e-6;
}

/* -------------------------------------------------------------- highlights */
/**
 * How far below a touch selection the popover sits. Enough to clear the selection
 * handle hanging off the end of the range — a teardrop roughly this tall on both
 * Android and iOS — which would otherwise sit on top of the first button.
 */
const HANDLE_CLEARANCE = 30;

/**
 * `touch` puts the popover under the selection instead of over it. Above is right for
 * a mouse, where nothing else is competing for that space; on touch the browser's own
 * selection bar (Copy / Share / Select all) takes it, and nothing on the page can
 * suppress that bar — so the two would overlap. Below is the space it leaves free.
 */
function handleSelection(sel, { touch = false } = {}) {
  if (!sel) return closePopover();
  if (sel.crossPage) {
    closePopover();
    return toast('Highlights stop at the page edge — select within one page.');
  }
  pending = sel;
  openPopover(sel, sel.client.x, sel.client.y,
    touch ? { below: true, gap: HANDLE_CLEARANCE } : {});
}

function bindSelection() {
  // Where the current gesture started, so a drag can be told from a click. Only a drag
  // is evidence someone was trying to select something.
  let from = null;
  // What opened the current gesture. Touch takes an entirely different route to the
  // popover (see the selectionchange listener at the bottom of this function) and wants
  // it placed on the other side of the selection.
  let lastPointerType = 'mouse';

  // Click-away closes the popover. This fires on the way *into* any new gesture —
  // including the drag that will open the next popover — so the stale one never
  // lingers under it. Clicks on the popover itself are the one exception.
  document.addEventListener('pointerdown', (e) => {
    from = { x: e.clientX, y: e.clientY };
    lastPointerType = e.pointerType;
    if (!e.target.closest('#pop')) closePopover();
  });

  // A cancelled gesture is not a completed one, and on touch it is the *normal* ending
  // rather than an edge case: promoting a long press to a text selection is exactly
  // what makes the browser claim the pointer and cancel ours. Without this, `from`
  // keeps the cancelled gesture's start point and the next pointerup measures its drag
  // distance from the wrong place.
  document.addEventListener('pointercancel', () => { from = null; });

  document.addEventListener('pointerup', (e) => {
    const start = from;
    from = null;
    if (tool !== 'select' || e.pointerType === 'pen' || reader?.kind === 'epub') return;
    // Let the browser finish resolving the selection before reading it. EPUB never
    // reaches here — a pointerup inside a chapter's iframe doesn't bubble to this
    // top-document listener, so it arrives via reader.onSelectionChange instead.
    setTimeout(() => {
      const sel = readSelection(document);
      if (sel) {
        // Everything below this line is about a gesture that selected nothing, and
        // touch still needs all of it — a tap is how you open a note on a phone. Only
        // the popover is withheld: on touch the selectionchange listener owns it, and
        // opening one here would race a range whose handles may still be moving.
        if (e.pointerType !== 'touch') handleSelection(sel);
        return;
      }
      // Empty-handed. If they dragged across a page we know has no text layer, that's
      // not an idle click — it's the gesture this whole feature exists to answer.
      const pageEl = e.target.closest?.('[data-page]');
      const dragged = start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6;
      if (dragged && pageEl && reader?.pageHasText?.(Number(pageEl.dataset.page)) === false) {
        openNoTextPopover(e.clientX, e.clientY);
        return;
      }
      handleSelection(null);
      // A click that selected nothing is the "open what's under me" gesture. It has to
      // be hit-tested here rather than handled by a click listener on the .hl rect
      // itself: .hl-layer sits at z-index 2, under .text-layer at 3, because the text
      // layer has to stay on top to own selection. Nothing ever reaches a rect.
      // (EPUB is the exception and returns above — its layer is injected into the
      // chapter's own document, above the text, so there the rect's own onclick fires.)
      if (!dragged && pageEl) {
        const page = Number(pageEl.dataset.page);
        const hit = hitTest(annotations, page, toPage(e.clientX, e.clientY, pageEl.getBoundingClientRect()));
        if (hit) openNoteDialog(hit);
      }
    }, 0);
  });

  /* How a touch selection reaches the popover, and why it needs its own path.
   *
   * Both mobile browsers promote a long press on text into their own selection
   * gesture, and taking it over means taking over the pointer stream: the page gets a
   * `pointercancel` where it expected a `pointerup`, so the handler above never runs.
   * Dragging the handles afterwards produces no pointer events on the document at all —
   * that UI is the browser's, not ours. `selectionchange` is the one event that
   * survives the whole gesture, which makes it the only honest signal here.
   *
   * It fires continuously while a handle moves, so the popover is opened on the
   * trailing edge — see SELECTION_SETTLE_MS. EPUB selections belong to a chapter
   * iframe's document and fire on that one instead, so they never reach this listener;
   * epub-reader.js runs the same idea against its own. */
  let settle = null;
  document.addEventListener('selectionchange', () => {
    if (lastPointerType !== 'touch' || reader?.kind === 'epub') return;
    clearTimeout(settle);
    settle = setTimeout(() => {
      if (tool !== 'select') return;
      const sel = readSelection(document);
      // Only a real selection opens the popover. A collapsed one means the browser
      // cleared the range — a tap somewhere else, or our own removeAllRanges once a
      // highlight is saved — and both of those have already closed the popover by
      // another route. Calling handleSelection(null) here would just close it twice.
      if (sel) handleSelection(sel, { touch: true });
    }, SELECTION_SETTLE_MS);
  });

  $('#pages').addEventListener('pointerdown', (e) => {
    if (tool !== 'erase') return;
    const pageEl = e.target.closest('[data-page]');
    if (!pageEl) return;
    erase(Number(pageEl.dataset.page), toPage(e.clientX, e.clientY, pageEl.getBoundingClientRect()));
  });

  $('#scroller').addEventListener('scroll', closePopover, { passive: true });
}

function openPopover(sel, x, y, place = {}) {
  const pop = $('#pop');
  pop.innerHTML = '';
  delete pop.dataset.kind;
  // Your color is a standing preference (set in the who-dialog), not a per-highlight
  // decision — the popover shows it, it doesn't ask.
  const hl = document.createElement('button');
  hl.className = 'act';
  hl.innerHTML = `<span class="dot" style="background:${me.color}"></span>Highlight`;
  hl.onclick = () => createHighlight(sel, me.color, false);
  pop.appendChild(hl);
  const note = document.createElement('button');
  note.className = 'act';
  note.textContent = 'Add note';
  note.onclick = () => createHighlight(sel, me.color, true);
  pop.appendChild(note);
  placePopover(x, y, place);
}

/**
 * Open the popover at (x, y) in viewport pixels, kept inside the window.
 *
 * `below` flips it under the anchor instead of above it. Selection popovers sit above
 * the text they belong to; a popover hanging off the topbar has nothing above it but
 * the window edge, and a touch selection has the browser's own bar up there already.
 * `gap` is the clearance from the anchor, which touch needs more of — see
 * HANDLE_CLEARANCE.
 */
function placePopover(x, y, { below = false, gap = 10 } = {}) {
  const pop = $('#pop');
  pop.dataset.open = 'true';
  const r = pop.getBoundingClientRect();
  pop.style.left = Math.min(Math.max(8, x - r.width / 2), innerWidth - r.width - 8) + 'px';
  pop.style.top = below
    ? Math.min(y + gap, innerHeight - r.height - 8) + 'px'
    : Math.max(8, y - r.height - 12) + 'px';
}

function closePopover() {
  $('#pop').dataset.open = 'false';
  // Without this the next highlight popover inherits the refusal card's layout.
  delete $('#pop').dataset.kind;
  pending = null;
}

async function createHighlight(sel, color, withNote) {
  // Note the absence of an `annotations.push(a)` here, and everywhere below.
  // Every write goes out through the store and comes back through onRemoteChange,
  // so the local list has exactly one path in. Pushing here as well is how you get
  // two highlights for one selection — which is precisely what happened the first
  // time this was tested.
  const a = await store.saveAnnotation({
    docId,
    userId: me.id,
    type: 'highlight',
    pageNumber: sel.pageNumber ?? null,
    spineIndex: sel.spineIndex ?? null,
    color,
    rects: sel.rects ?? null,
    cfi: sel.cfi ?? null,
    percent: reader.percentFor(sel),
    text: sel.text,
    textAnchor: sel.textAnchor ?? null,
    note: '',
  });
  // For EPUB the live selection is in a chapter iframe's own window, not this one.
  reader.pageEl(unitKey(sel))?.ownerDocument?.defaultView?.getSelection()?.removeAllRanges();
  closePopover();
  renderAnnotations(unitKey(sel));
  renderPanel();
  renderSpine();
  if (withNote) openNoteDialog(a);
}

/**
 * Remove one highlight — the counterpart to erase() for ink, and the single path
 * behind both entry points (the note dialog's button and the margin panel's).
 *
 * Guarded on ownership even though both callers already hide the affordance from
 * a reader who doesn't own the row: hosted mode's RLS would reject the write
 * anyway, and local mode has no RLS to fall back on.
 *
 * Like every other write here this doesn't touch `annotations` directly — the
 * store's change feed does, so the local list keeps its one path in. The renders
 * below are the same optimistic repaint saveAnnotation's callers do; the feed's
 * echo lands on an already-correct view.
 */
async function removeHighlight(a) {
  if (a.userId !== me.id) return;
  await store.deleteAnnotation(a.id);
  renderAnnotations(unitKey(a));
  renderPanel();
  renderSpine();
}

/* --------------------------------------------------------------------- ink */
async function commitStroke(pageNumber, stroke) {
  const a = await store.saveAnnotation({
    docId,
    userId: me.id,
    type: 'ink',
    pageNumber,
    color: stroke.color,
    strokes: [stroke],
    percent: reader.percentFor({ pageNumber }),
    note: '',
  });
  void a;
  renderAnnotations(pageNumber);
  renderSpine();
}

async function erase(pageNumber, pt) {
  const hit = annotations.find(
    (a) =>
      a.type === 'ink' &&
      a.pageNumber === pageNumber &&
      a.userId === me.id && // you can only erase your own marks
      a.strokes.some((s) => distanceToStroke(pt, s) < 0.012)
  );
  if (!hit) return;
  await store.deleteAnnotation(hit.id);
  renderAnnotations(pageNumber);
  renderSpine();
}

/* ---------------------------------------------------------------- painting */
function renderAnnotations(only) {
  // `only != null` rather than truthy: spine index 0 (an EPUB book's first chapter)
  // is a legitimate unit key and must not fall through to "render everything."
  const pageNums = only != null ? [only] : reader.pages.map((p) => p.num);
  for (const n of pageNums) {
    const el = reader.pageEl(n);
    if (!el) continue;
    const mine = annotations.filter((a) => unitKey(a) === n);

    const hl = el.querySelector('.hl-layer');
    hl.innerHTML = '';
    for (const a of mine.filter((a) => a.type === 'highlight')) {
      // PDF annotations carry their own rects; EPUB ones carry a cfi and get their
      // rects resolved fresh against however the chapter is laid out right now.
      const rects = a.rects ?? reader.rectsForCfi?.(n, a.cfi) ?? [];
      for (const r of rects) {
        const d = document.createElement('div');
        d.className = 'hl' + (a.note ? ' has-note' : '');
        d.style.cssText =
          `left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%;` +
          `background:${a.color};opacity:.34;color:${a.color}`;
        d.title = `${nameOf(a.userId)}${a.note ? ' — ' + a.note.slice(0, 60) : ''}`;
        d.onclick = () => openNoteDialog(a);
        hl.appendChild(d);
      }
    }

    const ink = el.querySelector('canvas.ink');
    if (ink?.width) {
      redraw(ink, mine.filter((a) => a.type === 'ink').flatMap((a) => a.strokes ?? []));
    }
  }
  // Highlights are pointer-transparent as a layer so selection still works; the
  // individual rects opt back in, which is why the layer sits under the text layer.
  for (const n of pageNums) {
    const l = reader.pageEl(n)?.querySelector('.hl-layer');
    if (l) l.style.pointerEvents = 'none';
  }
}

function renderPanel() {
  const notes = annotations
    .filter((a) => a.type === 'highlight')
    .sort((a, b) => (a.percent ?? 0) - (b.percent ?? 0));
  const withText = notes.filter((a) => a.note);
  $('#note-count').textContent = notes.length ? `${notes.length}` : '';

  const el = $('#notes');
  el.innerHTML = '';
  if (!notes.length) {
    el.innerHTML =
      '<div class="empty">Nothing in the margin yet.<br>Select a line and pick a color.</div>';
    return;
  }
  for (const a of notes) {
    const div = document.createElement('div');
    div.className = 'note';
    div.style.color = colorOf(a.userId);
    div.innerHTML =
      `<div class="note-meta"><span class="note-who">${escape(nameOf(a.userId))}</span>` +
      `<span>${posLabel({ page: a.pageNumber, percent: a.percent })}</span></div>` +
      (a.text ? `<div class="note-quote">${escape(a.text)}</div>` : '') +
      (a.note ? `<div class="note-body">${escape(a.note)}</div>` : '');
    // Jump first, then open it — awaited, so the passage is on screen behind the dialog
    // rather than arriving after you dismiss it (on EPUB, goTo has to render a chapter
    // before it can scroll, so that wait is real).
    //
    // Unless you're already there. Scrolling the page you're reading out from under
    // yourself to land on the same page is motion that says nothing, and it costs you
    // the spot you were actually looking at.
    //
    // Only PDF can answer that: `currentUnit()` is a page there and null on EPUB, whose
    // only unit is a chapter — too coarse to mean "already looking at it." Null never
    // equals a unitKey, so EPUB jumps every time, which is the right default when the
    // passage could be thousands of words down the chapter you're standing in.
    div.onclick = async () => {
      if (unitKey(a) !== reader.currentUnit()) await reader.goTo(locatorFor(a), true);
      openNoteDialog(a);
    };

    // Only over your own rows. The other reader's margin is theirs to keep — and
    // RLS would refuse the write in hosted mode regardless.
    if (a.userId === me.id) {
      const del = document.createElement('button');
      del.className = 'note-del';
      del.textContent = '×';
      del.title = 'Remove this highlight';
      del.setAttribute('aria-label', `Remove highlight${a.text ? ': ' + a.text.slice(0, 40) : ''}`);
      del.onclick = (e) => {
        e.stopPropagation(); // the card behind it jumps to the page; the × must not
        removeHighlight(a);
      };
      div.appendChild(del);
    }
    el.appendChild(div);
  }
  void withText;
}

/* ------------------------------------------------------------------- spine */
function renderSpine() {
  const track = $('#track');
  // Every record — PDF or EPUB — carries its own `percent` through the book, stamped
  // at write time by whichever reader created it (see reader.percentFor). The rail
  // just paints that; it doesn't need to know page counts or CFIs to do its job.
  track.querySelectorAll('.tick, .marker').forEach((n) => n.remove());

  for (const a of annotations) {
    const t = document.createElement('div');
    t.className = 'tick';
    t.style.top = (a.percent ?? 0) * 100 + '%';
    t.style.background = colorOf(a.userId);
    track.appendChild(t);
  }

  const mine = progress[me.id];
  const theirs = readerPositions();

  // Your own marker is a pill that sizes to its label, so the label can be as long
  // as it needs to be — "p.5", "p.147" and "100%" all fit, which a fixed-diameter
  // circle could not.
  if (mine) {
    const m = document.createElement('button');
    m.className = 'marker';
    m.style.top = (mine.percent ?? 0) * 100 + '%';
    m.style.background = colorOf(me.id);
    m.textContent = posLabel(mine);
    m.title = `${nameOf(me.id)} — ${posLabel(mine)}`;
    // The pill's text is an abbreviation ("p.5"), which is not a usable accessible
    // name on its own.
    m.setAttribute('aria-label', `You are at ${spokenPos(mine)}`);
    m.onclick = () => reader.goTo(mine, true);
    track.appendChild(m);
  }

  // Theirs are bare dots in a lane of their own: two labels on one rail collide
  // exactly when you're reading the same part of the book. Readers who land within a
  // dot's height of each other are drawn as one marker carrying a count — overlapping
  // dots are unreadable precisely where the rail is most worth looking at, and "3
  // readers here" is the better answer anyway. With one other reader nothing clusters,
  // so this is the same single dot it has always been.
  for (const c of clusterPositions(theirs, track.clientHeight)) {
    const m = document.createElement('button');
    m.className = 'marker them' + (c.readers.length > 1 ? ' cluster' : '');
    m.style.top = c.percent * 100 + '%';

    if (c.readers.length === 1) {
      const p = c.readers[0];
      m.style.background = colorOf(p.userId);
      const where = `${nameOf(p.userId)} — ${posLabel(p)}`;
      m.title = `${where}. Jump to them.`;
      m.setAttribute('aria-label', `${nameOf(p.userId)} is at ${spokenPos(p)}. Jump to them.`);
      m.onclick = () => reader.goTo(p, true);
    } else {
      // Neutral, not one reader's color: picking any of them would be a lie about
      // whose position this is. --muted rather than --edge because the count sits on
      // top of it at 9px — --ink on --muted is 8.3:1, on --edge only 4.0:1.
      m.style.background = 'var(--muted)';
      m.textContent = String(c.readers.length);
      const names = c.readers.map((p) => nameOf(p.userId)).join(', ');
      m.title = `${names} — around ${posLabel(c.readers[0])}. Pick one to jump to.`;
      m.setAttribute('aria-label',
        `${c.readers.length} readers near ${spokenPos(c.readers[0])}: ${names}. Pick one to jump to.`);
      m.onclick = () => {
        const r = m.getBoundingClientRect();
        openReadersPopover(c.readers, r.left + r.width / 2, r.bottom);
      };
    }
    track.appendChild(m);
  }

  /* The gap is the point of the whole rail: how far apart you are, in the only unit
     that matters here. With more than two readers the meaningful distance is the
     spread of the group — from whoever is furthest behind to whoever is furthest
     ahead — which for exactly two people is the distance between you, unchanged. */
  const gap = $('#gap');
  const between = $('#between');
  const jump = $('#jump-label');

  const everyone = mine ? [mine, ...theirs] : theirs;
  const together = !!(mine && theirs.length && theirs.every((p) =>
    mine.page != null ? mine.page === p.page : mine.cfi === p.cfi));

  // The label only needs to know where they are. The band needs the extremes.
  jump.textContent = !theirs.length
    ? 'Find them'
    : together
      ? 'Together'
      : theirs.length === 1
        ? `${nameOf(theirs[0].userId)} · ${posLabel(theirs[0])}`
        : `${theirs.length} readers`;
  $('#t-jump').setAttribute('aria-label', !theirs.length
    ? 'Find the other reader'
    : together
      ? `You are all at ${spokenPos(theirs[0])}`
      : theirs.length === 1
        ? `Jump to ${nameOf(theirs[0].userId)}, at ${spokenPos(theirs[0])}`
        : `Jump to one of ${theirs.length} readers`);

  if (mine && theirs.length) {
    // Sorted by position, so first and last are the two ends of the group. At two
    // readers these are just the two of you.
    const ends = [...everyone].sort((x, y) => (x.percent ?? 0) - (y.percent ?? 0));
    const top = ends[0];
    const bot = ends[ends.length - 1];
    const a = top.percent ?? 0;
    const b = bot.percent ?? 0;
    const span = b - a;

    const usingPages = top.page != null && bot.page != null;
    const d = usingPages ? Math.abs(bot.page - top.page) : span;

    // Paint the stretch of book the group is spread across. The number says how far
    // apart; the painted span says *where* that distance is, which is the thing a rail
    // can show and a label can't.
    between.hidden = span < 0.005;
    between.style.top = a * 100 + '%';
    between.style.height = span * 100 + '%';
    // Always 180deg now — the band is drawn top-down from the topmost reader, so the
    // gradient runs in the order the readers actually sit. The old code flipped
    // between 0 and 180 to keep "me" as the first stop; sorting does that job.
    between.style.background =
      `linear-gradient(180deg, ${colorOf(top.userId)}, ${colorOf(bot.userId)})`;

    // The label sits at the midpoint, which is where your own pill sits when everyone
    // is close — so below a tenth of the book it's dropped rather than drawn underneath
    // the pill. Nothing is lost: at that distance the topbar already says "Together",
    // and the painted span still shows it.
    gap.textContent = span < 0.1
      ? ''
      : d === 0 ? 'together' : usingPages ? `${d}p` : `${Math.round(d * 100)}%`;
    const mid = (a + b) / 2;
    gap.style.top = `calc(44px + ${mid} * (100% - 88px) - 5px)`;
  } else {
    gap.textContent = '';
    between.hidden = true;
  }
}

/**
 * Where everyone but you is, most-recently-known first sorted by position. Excludes
 * readers whose access was revoked: the membership row survives so their old
 * highlights keep a name, but a position on the rail would say they are still here.
 */
function readerPositions() {
  const gone = revokedIds();
  return Object.values(progress)
    .filter((p) => p.userId !== me.id && !gone.has(p.userId))
    .sort((a, b) => (a.percent ?? 0) - (b.percent ?? 0));
}

/**
 * Group readers who would draw on top of each other. The threshold is a dot's height
 * expressed as a fraction of the rail, so it stays correct as the window resizes
 * rather than being a guessed constant.
 *
 * Fewer than two readers can't collide, so the single-reader case returns untouched —
 * that is what keeps a two-person book drawing exactly the marker it always did.
 */
function clusterPositions(rows, trackHeight) {
  if (rows.length < 2) return rows.map((p) => ({ percent: p.percent ?? 0, readers: [p] }));
  const threshold = trackHeight > 0 ? 16 / trackHeight : 0.03;
  const out = [];
  for (const p of rows) {
    const pct = p.percent ?? 0;
    const last = out[out.length - 1];
    // Anchored to the first member, not re-centred as the cluster grows: a marker that
    // drifts while you read is harder to track than one that stays put.
    if (last && pct - last.percent <= threshold) last.readers.push(p);
    else out.push({ percent: pct, readers: [p] });
  }
  return out;
}

/** The picker behind a cluster dot and behind "Find them" when several people are in. */
function openReadersPopover(rows, x, y) {
  const pop = $('#pop');
  pop.innerHTML = '';
  pop.dataset.kind = 'readers';
  for (const p of rows) {
    const b = document.createElement('button');
    b.className = 'act';
    b.appendChild(avatarEl({ color: colorOf(p.userId) }, 10));
    const name = document.createElement('span');
    name.textContent = nameOf(p.userId);
    const pos = document.createElement('span');
    pos.className = 'who-pos';
    pos.textContent = posLabel(p);
    b.append(name, pos);
    b.setAttribute('aria-label', `Jump to ${nameOf(p.userId)}, at ${spokenPos(p)}`);
    b.onclick = () => {
      closePopover();
      reader?.goTo(p, true);
    };
    pop.appendChild(b);
  }
  placePopover(x, y, { below: true });
}

/* ------------------------------------------------------------------ dialogs */
function openNoteDialog(a) {
  editing = a;
  const dlg = $('#note-dlg');
  $('#note-quote').textContent = a.text
    ? `"${a.text.slice(0, 180)}"`
    : a.pageNumber != null ? `Page ${a.pageNumber}` : `${Math.round((a.percent ?? 0) * 100)}% through`;
  const ta = $('#note-text');
  ta.value = a.note ?? '';
  const own = a.userId === me.id;
  ta.readOnly = !own;
  ta.placeholder = own ? 'What did you think?' : `${nameOf(a.userId)} left no note here.`;
  $('#note-delete').style.display = own ? '' : 'none';
  dlg.showModal();
  if (own) ta.focus();
}

function bindNoteDialog() {
  $('#note-dlg').addEventListener('close', async (e) => {
    const dlg = $('#note-dlg');
    const a = editing;
    editing = null;
    if (!a || a.userId !== me.id) return;

    if (dlg.returnValue === 'save') {
      await store.saveAnnotation({ ...a, note: $('#note-text').value.trim() });
      renderAnnotations(unitKey(a));
      renderPanel();
    }
    if (dlg.returnValue === 'delete') await removeHighlight(a);
    void e;
  });
}

/* ------------------------------------------------------------- share sheet
   One dialog with two views. The list is the normal case; removing someone
   needs a question answered rather than acknowledged, and a native confirm()
   can't ask it. Swapping views inside one dialog beats stacking a second one:
   two modals means two backdrops and a focus ring that ends up in the wrong
   place when the top one closes. */

// The person the revoke view is asking about, held between the two views.
let revoking = null;

/**
 * Feedback for anything done from inside the share sheet. Not toast(): a <dialog>
 * renders in the browser's top layer, which is above every z-index on the page, so a
 * toast fired while the sheet is open comes up behind it and behind its backdrop blur.
 */
function shareMsg(text, kind) {
  const el = $('#share-msg');
  el.textContent = text ?? '';
  if (kind) el.dataset.kind = kind;
  else delete el.dataset.kind;
}

async function openShareDialog() {
  if (!docId) return;
  const dlg = $('#share-dlg');
  dlg.dataset.view = 'list';
  shareMsg(null);
  $('#revoke-go').hidden = true;
  $('#share-invite').hidden = false;
  // Its enabled state depends on who owns the book, which renderShareList works out.
  await renderShareList();
  dlg.showModal();
}

async function renderShareList() {
  const list = $('#share-list');
  list.innerHTML = '';

  let shares = [];
  try {
    shares = await store.listShares(docId);
  } catch (e) {
    list.innerHTML = `<div class="empty">${escape(e.message)}</div>`;
    return;
  }

  const owner = shares.find((s) => s.isOwner);
  const iAmOwner = owner?.userId === me.id;
  $('#share-lede').textContent = iAmOwner
    ? 'Everyone here sees each other’s highlights and where you all are.'
    : `${owner ? owner.name : 'Whoever added this book'} shares it with you. ` +
      'Only they can add or remove other readers.';

  // Adding a reader is owner-only, by link as much as by name — the invites policy and
  // share_document both enforce it, so the button has to say so rather than fail. Two
  // different reasons, two different sentences: "runs only in this browser" and "not
  // your book" are not the same rule and shouldn't wear the same tooltip.
  const invite = $('#share-invite');
  invite.disabled = !isHosted() || !iAmOwner;
  invite.title = !isHosted()
    ? 'This copy of Marginalia runs only in this browser, so there’s nobody to invite.'
    : !iAmOwner
      ? `Only ${owner ? owner.name : 'the person who added this book'} can invite readers.`
      : 'Copy a link that lets one person in';

  const frag = document.createDocumentFragment();
  for (const s of shares) {
    const isMe = s.userId === me.id;
    const meta = s.revokedAt
      ? s.leftMarks ? 'Removed — their highlights stayed' : 'Removed — their highlights are hidden'
      : s.isOwner ? 'Added this book' : isMe ? 'You' : 'Reading';

    // You can always remove yourself. Only the owner can remove anyone else, and
    // nobody can remove the owner — the same rules revoke_share enforces server-side,
    // mirrored here so the button isn't offered and then refused.
    const canRemove = isHosted() && !s.revokedAt && !s.isOwner && (isMe || iAmOwner);
    const canRestore = isHosted() && s.revokedAt && iAmOwner;

    frag.appendChild(personRow(
      { ...s, name: isMe ? `${s.name} (you)` : s.name },
      {
        meta,
        action: canRemove
          ? { label: isMe ? 'Leave' : 'Remove', onClick: () => askRevoke(s, isMe) }
          : canRestore
            ? { label: 'Add back', onClick: () => restoreShare(s) }
            : null,
      }
    ));
  }
  list.appendChild(frag);

  await renderShareAdd(shares, iAmOwner);
}

async function renderShareAdd(shares, iAmOwner) {
  const wrap = $('#share-add-wrap');
  const box = $('#share-add');
  box.innerHTML = '';
  // Only the owner can grant, and only in hosted mode. Hiding rather than disabling
  // here: this is a whole section that has nothing to say, not a control with a rule.
  if (!isHosted() || !iAmOwner) {
    wrap.hidden = true;
    return;
  }

  let people = [];
  try {
    people = await store.listConnections();
  } catch {
    wrap.hidden = true;
    return;
  }

  const active = new Set(shares.filter((s) => !s.revokedAt).map((s) => s.userId));
  const candidates = people.filter((p) => p.status === 'accepted' && !active.has(p.userId));
  if (!candidates.length) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;

  const frag = document.createDocumentFragment();
  for (const p of candidates) {
    const id = `share-with-${p.userId}`;
    const row = document.createElement('div');
    row.className = 'share-add';

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.id = id;
    check.onchange = async () => {
      // Disabled for the round trip: a second click would be a second grant, and the
      // list re-renders underneath it either way.
      check.disabled = true;
      try {
        await store.shareDocument(docId, p.userId);
        sharedBooksCache.delete(p.userId);

        // They may already own a copy of this exact file. Only they can merge the two —
        // you can't name a document you're not in, and the merge always gives up the
        // caller's own copy — so this is a heads-up, not an action.
        let dupe = null;
        try {
          dupe = await store.findDuplicate(docId, p.userId);
        } catch {
          /* the share worked; the extra detail is optional */
        }
        await refreshMembers();
        await renderShareList();
        // After renderShareList, which rebuilds the list but not this element.
        shareMsg(dupe
          ? `Shared with ${p.name}. They already have this file — they'll be offered the merge.`
          : `Shared with ${p.name}.`);
      } catch (e) {
        check.checked = false;
        check.disabled = false;
        shareMsg(e.message, 'error');
      }
    };

    const label = document.createElement('label');
    label.htmlFor = id;
    label.appendChild(avatarEl(p));
    const name = document.createElement('span');
    name.textContent = p.name;
    label.appendChild(name);

    row.append(check, label);
    frag.appendChild(row);
  }
  box.appendChild(frag);
}

function askRevoke(person, isMe) {
  revoking = { person, isMe };
  const dlg = $('#share-dlg');
  dlg.dataset.view = 'revoke';
  $('#revoke-head').textContent = isMe ? 'Leave this book' : `Remove ${person.name}`;
  $('#revoke-legend').textContent = isMe
    ? 'The book goes off your shelf. What happens to the highlights you made in it?'
    : `${person.name} loses access to this book. What happens to the highlights they made?`;
  // The radio wording is written for the third person, which is wrong when it's you.
  const labels = dlg.querySelectorAll('.choice .t');
  labels[0].textContent = isMe ? 'Leave my highlights' : 'Leave their highlights';
  labels[1].textContent = isMe ? 'Take my highlights with me' : 'Take their highlights with them';
  dlg.querySelector('input[name="leave-marks"][value="keep"]').checked = true;
  $('#share-invite').hidden = true;
  const go = $('#revoke-go');
  go.hidden = false;
  go.textContent = isMe ? 'Leave' : 'Remove';
  go.focus();
}

async function doRevoke() {
  if (!revoking) return;
  const { person, isMe } = revoking;
  const leaveMarks =
    $('#share-dlg').querySelector('input[name="leave-marks"]:checked')?.value !== 'take';
  try {
    if (isMe) {
      await store.leaveDocument(docId, { leaveMarks });
      $('#share-dlg').close();
      await closeDoc();
      await renderShelf();
      toast('You left the book.');
    } else {
      await store.revokeShare(docId, person.userId, { leaveMarks });
      sharedBooksCache.delete(person.userId);
      $('#share-dlg').dataset.view = 'list';
      $('#revoke-go').hidden = true;
      $('#share-invite').hidden = false;
      await refreshMembers();
      await renderShareList();
      shareMsg(leaveMarks
        ? `${person.name} was removed. Their highlights stayed.`
        : `${person.name} was removed, and their highlights are hidden.`);
    }
  } catch (e) {
    // Leaving closes the dialog before this can fire; removing someone else doesn't.
    if ($('#share-dlg').open) shareMsg(e.message, 'error');
    else toast(e.message);
  } finally {
    revoking = null;
  }
}

async function restoreShare(person) {
  try {
    await store.shareDocument(docId, person.userId);
    sharedBooksCache.delete(person.userId);
    await refreshMembers();
    await renderShareList();
    shareMsg(`${person.name} is back in, with everything they'd written.`);
  } catch (e) {
    shareMsg(e.message, 'error');
  }
}

/** Re-read the member list into module state so names, colors and the rail agree. */
async function refreshMembers() {
  if (!docId) return;
  try {
    members = await store.listMembers(docId);
    renderPanel();
    renderSpine();
  } catch {
    /* the rail keeps the members it had; a stale color beats a blank one */
  }
}

function bindPeople() {
  $('#t-people').onclick = showPeople;
  $('#people-invite').onclick = copyConnectInvite;

  // The people screen is a screen, not a dialog, so it has no built-in dismissal.
  // Escape is what everyone tries first.
  $('#people').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hidePeople();
  });

  // Someone connected, or shared a book with you, while you were sitting on the shelf.
  // This is the only reason the per-user channel exists.
  if (isHosted()) {
    store.subscribeUser((change) => {
      if (change.kind === 'connection') {
        sharedBooksCache.clear();
        if (!$('#people').hidden) renderPeople();
        return;
      }
      if (change.kind === 'share') {
        sharedBooksCache.clear();
        // A book arriving or leaving changes the shelf, which may be what's on screen.
        if (!$('#start').hidden) renderShelf();
        if (!$('#people').hidden) renderPeople();
      }
    });
  }
}

function bindShareDialog() {
  $('#share-invite').onclick = copyInvite;
  $('#revoke-go').onclick = doRevoke;
  // Escape closes the dialog outright, including from the revoke view. Reset the view
  // so the next open doesn't land mid-question.
  $('#share-dlg').addEventListener('close', () => {
    $('#share-dlg').dataset.view = 'list';
    shareMsg(null);
    revoking = null;
  });
}

function openWhoDialog() {
  const dlg = $('#who-dlg');
  dlg.dataset.view = 'who';
  whoMsg(null);
  $('#who-save').hidden = false;
  $('#who-delete-go').hidden = true;
  /* Local mode has no account. Identity is a localStorage key, the books are in this
     browser's IndexedDB, and there is no server holding either — so this isn't a control
     with a rule to explain in a tooltip, the way the disabled invite button is. It's an
     action that doesn't exist here, and it's hidden. */
  $('#who-delete').hidden = !isHosted();
  $('#who-delete').disabled = false;

  $('#who-name').value = me.name;
  const wrap = $('#who-palette');
  wrap.innerHTML = '';
  let picked = me.color;

  /* Colors taken by the other readers of the open book. Two readers in one book sharing
     a color makes every highlight ambiguous, which the two-reader default palette made
     impossible by accident and a third reader makes possible on purpose. The server
     resolves this when someone joins (pick_color in social.sql); this is the other half,
     for someone changing their mind afterwards.

     Disabled with a name in the tooltip, not hidden: a palette that silently loses
     swatches as people join reads as a bug. */
  const taken = new Map(others().map((m) => [m.color, m.name]));

  for (const c of COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.style.background = c.hex;
    b.style.color = c.hex;
    const owner = c.hex === me.color ? null : taken.get(c.hex);
    b.disabled = !!owner;
    b.title = owner ? `${owner} is using this one` : c.name;
    b.setAttribute('aria-label', owner ? `${c.name} — taken by ${owner}` : c.name);
    b.ariaPressed = String(c.hex === picked);
    b.onclick = () => {
      picked = c.hex;
      wrap.querySelectorAll('.swatch').forEach((s) => (s.ariaPressed = String(s === b)));
    };
    wrap.appendChild(b);
  }
  $('#who-dlg')._pick = () => picked;
  $('#who-dlg').showModal();
}

/**
 * Feedback from inside the who dialog. Not toast(), for the same reason shareMsg isn't:
 * a <dialog> renders in the browser's top layer, above every z-index on the page, so a
 * toast fired while it's open comes up behind it and behind its own backdrop blur.
 */
function whoMsg(text, kind) {
  const el = $('#who-msg');
  el.textContent = text ?? '';
  if (kind) el.dataset.kind = kind;
  else delete el.dataset.kind;
}

/**
 * The second view of the who dialog: what deleting the account actually costs, in the
 * words of this particular account.
 *
 * The numbers come from the server rather than from the shelf. The shelf holds books you
 * can *see*, which is a different set from the books you *added* — and only the second
 * set is at stake here. Which of those go and which stay with their other readers is a
 * question only memberships can answer, so account_deletion_plan answers it.
 */
async function askDeleteAccount() {
  const dlg = $('#who-dlg');
  const btn = $('#who-delete');

  btn.disabled = true;
  let plan;
  try {
    plan = await store.accountDeletionPlan();
  } catch (e) {
    // Stay on the first view: nothing has been asked yet, and this is a failure to
    // describe the question rather than an answer to it.
    whoMsg(e.message, 'error');
    btn.disabled = false;
    return;
  }
  btn.disabled = false;

  const gone = plan.filter((p) => p.action === 'delete').length;
  const kept = plan.length - gone;
  const lines = [
    'Your highlights, notes and reading positions are removed from every book — ' +
      'including the ones other people shared with you.',
  ];
  if (gone) {
    lines.push(gone === 1
      ? 'The book you added that nobody else is reading is deleted.'
      : `The ${gone} books you added that nobody else is reading are deleted.`);
  }
  if (kept) {
    lines.push(kept === 1
      ? 'The book you added that someone else is still reading stays with them, along ' +
        'with their own highlights in it.'
      : `The ${kept} books you added that other people are still reading stay with them, ` +
        'along with their own highlights in them.');
  }
  if (!plan.length) lines.push('You haven’t added any books, so nobody else loses anything.');
  $('#who-delete-what').textContent = lines.join(' ');

  dlg.dataset.view = 'delete';
  $('#who-save').hidden = true;
  btn.hidden = true;
  const go = $('#who-delete-go');
  go.hidden = false;
  go.disabled = false;
  // Same as the revoke view: focus the button that answers the question, so Enter means
  // the thing the person is looking at rather than whatever the form would have picked.
  go.focus();
}

async function doDeleteAccount() {
  const go = $('#who-delete-go');
  go.disabled = true;
  whoMsg('Deleting…');
  try {
    await store.deleteAccount();
  } catch (e) {
    go.disabled = false;
    whoMsg(e.message, 'error');
    return;
  }

  // The name and color under this key were that account's. Leaving them behind would hand
  // them to whoever signs in next in this browser.
  clearPref(uidKey + ':name');
  clearPref(uidKey + ':color');

  /* A reload, rather than tearing the session down by hand. boot() is the only thing that
     decides between the auth gate and the shelf, and every piece of state this tab holds
     — the shelf, the open book, the realtime channel — belongs to an account that no
     longer exists. replace() so Back doesn't return to a page built for that account, and
     pathname alone because the query string may still carry a ?join= code (the ?backend=
     override lives in sessionStorage and survives this). */
  location.replace(location.pathname);
}

function bindWhoDialog() {
  /* Implicit submission in a dialog form takes the *first* submit button, which
     here is Cancel — so Enter in the name field would discard the edit. Route it
     to Save instead: after typing a name, Enter means "yes, that one". */
  $('#who-name').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    $('#who-dlg').querySelector('button[value="save"]').click();
  });

  $('#who-delete').onclick = askDeleteAccount;
  $('#who-delete-go').onclick = doDeleteAccount;

  $('#who-dlg').addEventListener('close', async (e) => {
    const dlg = $('#who-dlg');
    /* Escape closes the dialog outright, from either view. Reset it so the next open
       doesn't land mid-question, the same way the share sheet resets its own. */
    const wasAsking = dlg.dataset.view === 'delete';
    dlg.dataset.view = 'who';
    whoMsg(null);
    /* Nothing said from the delete view is a "save" — the name field wasn't on screen to
       be edited. Save is hidden there so this can't fire today; it's here so that
       reordering the footer later can't turn "no, don't delete me" into a rename. */
    if (dlg.returnValue !== 'save' || wasAsking) return;
    me.name = $('#who-name').value.trim() || 'You';
    me.color = dlg._pick();
    setPref(uidKey + ':name', me.name);
    setPref(uidKey + ':color', me.color);
    // The profile is what everyone else reads you by, and the only copy that follows you
    // to another device. It also renames you on every book at once, which is why the
    // local prefs above are now a cache rather than the record.
    try {
      await store.saveProfile({ name: me.name, color: me.color });
    } catch (err) {
      toast(err.message);
    }
    syncWhoButton();
    if (docId) {
      await store.saveMember(docId, { userId: me.id, name: me.name, color: me.color });
      const i = members.findIndex((m) => m.userId === me.id);
      if (i >= 0) members[i] = { docId, userId: me.id, name: me.name, color: me.color };
      renderPanel();
      renderSpine();
    }
    void e;
  });
}

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

boot().catch((err) => {
  console.error('Marginalia: boot failed', err);
  $('#boot').dataset.failed = 'true';
  $('#boot-err').hidden = false;
});
