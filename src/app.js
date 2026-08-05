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
import { readSelection, hitTest } from './anchors.js';
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
  : new LocalStore();

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
const other = () => members.find((m) => m.userId !== me.id) ?? null;

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
    me = {
      id: store.user.id,
      name: store.user.user_metadata?.name ?? store.user.email?.split('@')[0] ?? 'You',
      // Same key the who-dialog writes (uidKey + ':color'). This used to read
      // 'marginalia:color', which nothing ever wrote — so the picked color
      // silently reverted to amber on every refresh in hosted mode.
      color: pref(uidKey + ':color', COLORS[0].hex),
    };
    $('#auth').hidden = true;
  }

  bindTools();
  bindStart();
  bindSelection();
  bindNoteDialog();
  bindWhoDialog();
  $('#t-who').textContent = me.name;
  await renderShelf();
  await handleInviteLink();
  // Only now is it known that no auth gate is coming (and whether an invite already
  // opened a book), so this is the first moment the drop screen can appear without
  // flashing beneath a sign-in overlay.
  if (!docId) $('#start').hidden = false;
}

/* ------------------------------------------------------------------- auth */
function showAuth() {
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
async function handleInviteLink() {
  const code = params.get('join');
  if (!code) return;
  if (!isHosted()) return toast('Invite links need a backend. See DEPLOY.md.');

  try {
    const id = await store.joinByCode(code, me.name);
    // Strip the code once it's been redeemed, so a reload isn't a second join and
    // the URL in the address bar stops being a live credential.
    history.replaceState({}, '', location.pathname);
    const docs = await store.listDocuments();
    const doc = docs.find((d) => d.id === id);
    await openDoc(id, { title: doc?.title ?? 'Shared book', author: doc?.author, format: doc?.format });
    toast('You\u2019re in.');
  } catch (e) {
    toast(e.message);
  }
}

async function copyInvite() {
  const code = await store.getInviteCode(docId);
  if (!code) return toast('Invite links need a backend. See DEPLOY.md.');
  const url = location.origin + location.pathname + '?join=' + code;
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied. It works once, for one person.');
  } catch {
    // Clipboard needs a secure context and a user gesture; if either is missing,
    // show the link rather than silently doing nothing.
    prompt('Send them this link:', url);
  }
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

function bookCard(d, onOpen, onDelete) {
  const card = document.createElement('div');
  card.className = 'book';

  const open = document.createElement('button');
  open.className = 'book-open';
  // The card is one button with one name. Cover, title, and author are all the same
  // target, so the accessible name says the whole thing once instead of three times.
  open.setAttribute('aria-label',
    `Open ${d.title}${d.author ? `, by ${d.author}` : ''} (${d.format.toUpperCase()})`);

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

  const del = document.createElement('button');
  del.className = 'book-del';
  del.title = 'Delete this book';
  del.setAttribute('aria-label', `Delete ${d.title}`);
  del.textContent = '✕';
  del.onclick = onDelete;
  card.appendChild(del);

  return card;
}

async function renderShelf() {
  const docs = await store.listDocuments();
  const el = $('#recent');
  el.innerHTML = '';
  // Drives the whole start screen's layout: shelf-first, or drop-zone-first when
  // there's nothing to open yet.
  $('#start').dataset.empty = String(!docs.length);
  $('#shelf').hidden = !docs.length;
  if (!docs.length) return;

  for (const d of docs) {
    const card = bookCard(
      d,
      () => openDoc(d.id, d),
      async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete "${d.title}"? This removes it — and its highlights and notes — for both of you.`)) return;
        try {
          await store.deleteDocument(d.id);
          await renderShelf();
        } catch (err) {
          toast(err.message ?? 'That book didn’t delete.');
        }
      }
    );
    el.appendChild(card);

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
}

/* ------------------------------------------------------------------ opening */
function bindStart() {
  const drop = $('#drop');
  // Three doors to the same picker: the shelf header's "Add a book", the empty
  // state's big button, and the inline link in the drop strip. Which one is on
  // screen is a CSS question (see #start[data-empty]), not a JS one.
  for (const id of ['#pick', '#pick-big', '#pick-alt']) {
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
    $('#start').hidden = false;
    return;
  }
  $('#t-invite').hidden = !isHosted();

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
    if (i >= 0) members[i] = change.row;
    else members.push(change.row);
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

function bindTools() {
  $('#t-home').onclick = closeDoc;
  $('#t-select').onclick = () => setTool('select');
  $('#t-ink').onclick = () => setTool('ink');
  $('#t-erase').onclick = () => setTool('erase');

  $('#zoom-in').onclick = () => zoomBy(0.2);
  $('#zoom-out').onclick = () => zoomBy(-0.2);

  $('#t-panel').onclick = () => {
    const open = app.dataset.panel === 'open';
    app.dataset.panel = open ? 'closed' : 'open';
    $('#t-panel').ariaPressed = String(!open);
    // The glyph swap lives in CSS (data-panel); the tooltip has to follow it here.
    $('#t-panel').title = open ? 'Show the margin' : 'Hide the margin';
  };

  $('#t-jump').onclick = () => {
    const o = other();
    const p = o && progress[o.userId];
    if (!p) return toast('Nobody else has opened this book yet.');
    reader?.goTo(p, true);
  };

  $('#t-who').onclick = openWhoDialog;
  $('#t-invite').onclick = copyInvite;
  // Dismissing is per-open, not remembered: reopening a scan is exactly when you'd
  // want reminding, and the greyed-out Select is the standing reminder in between.
  $('#notice-ok').onclick = hideNotice;

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    if (e.key === 'v') setTool('select');
    // No ink on reflowable text — see README "known gaps" — so these are PDF-only.
    if (e.key === 'd' && reader?.kind !== 'epub') setTool('ink');
    if (e.key === 'e' && reader?.kind !== 'epub') setTool('erase');
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
function handleSelection(sel) {
  if (!sel) return closePopover();
  if (sel.crossPage) {
    closePopover();
    return toast('Highlights stop at the page edge — select within one page.');
  }
  pending = sel;
  openPopover(sel, sel.client.x, sel.client.y);
}

function bindSelection() {
  // Where the current gesture started, so a drag can be told from a click. Only a drag
  // is evidence someone was trying to select something.
  let from = null;

  // Click-away closes the popover. This fires on the way *into* any new gesture —
  // including the drag that will open the next popover — so the stale one never
  // lingers under it. Clicks on the popover itself are the one exception.
  document.addEventListener('pointerdown', (e) => {
    from = { x: e.clientX, y: e.clientY };
    if (!e.target.closest('#pop')) closePopover();
  });

  document.addEventListener('pointerup', (e) => {
    const start = from;
    from = null;
    if (tool !== 'select' || e.pointerType === 'pen' || reader?.kind === 'epub') return;
    // Let the browser finish resolving the selection before reading it. EPUB never
    // reaches here — a pointerup inside a chapter's iframe doesn't bubble to this
    // top-document listener, so it arrives via reader.onSelectionChange instead.
    setTimeout(() => {
      const sel = readSelection(document);
      if (sel) return handleSelection(sel);
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

  $('#pages').addEventListener('pointerdown', (e) => {
    if (tool !== 'erase') return;
    const pageEl = e.target.closest('[data-page]');
    if (!pageEl) return;
    erase(Number(pageEl.dataset.page), toPage(e.clientX, e.clientY, pageEl.getBoundingClientRect()));
  });

  $('#scroller').addEventListener('scroll', closePopover, { passive: true });
}

function openPopover(sel, x, y) {
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
  placePopover(x, y);
}

/** Open the popover at (x, y) in viewport pixels, kept inside the window. */
function placePopover(x, y) {
  const pop = $('#pop');
  pop.dataset.open = 'true';
  const r = pop.getBoundingClientRect();
  pop.style.left = Math.min(Math.max(8, x - r.width / 2), innerWidth - r.width - 8) + 'px';
  pop.style.top = Math.max(8, y - r.height - 12) + 'px';
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

  const rows = Object.values(progress);
  for (const p of rows) {
    const m = document.createElement('button');
    const isMe = p.userId === me.id;
    m.className = 'marker' + (isMe ? '' : ' them');
    m.style.top = (p.percent ?? 0) * 100 + '%';
    m.style.background = colorOf(p.userId);
    // Your own marker is a pill that sizes to its label, so the label can be as long
    // as it needs to be — "p.5", "p.147" and "100%" all fit, which a fixed-diameter
    // circle could not. Theirs is a bare dot in its own lane: two labels on one rail
    // collide exactly when you're reading the same part of the book.
    m.textContent = isMe ? posLabel(p) : '';
    const where = `${nameOf(p.userId)} — ${posLabel(p)}`;
    m.title = isMe ? where : `${where}. Jump to them.`;
    // The dot has no text at all, and the pill's text is an abbreviation ("p.5"), so
    // neither is a usable accessible name on its own.
    m.setAttribute('aria-label', isMe
      ? `You are at ${spokenPos(p)}`
      : `${nameOf(p.userId)} is at ${spokenPos(p)}. Jump to them.`);
    m.onclick = () => reader.goTo(p, true);
    track.appendChild(m);
  }

  // The gap is the point of the whole rail: how far apart the two of you are,
  // in the only unit that matters here.
  const o = other();
  const mine = progress[me.id];
  const theirs = o && progress[o.userId];
  const gap = $('#gap');
  const between = $('#between');
  const jump = $('#jump-label');
  const together = !!(mine && theirs &&
    (mine.page != null ? mine.page === theirs.page : mine.cfi === theirs.cfi));
  // The label only needs to know where they are. The gap needs both of you.
  jump.textContent = theirs
    ? together ? 'Together' : `${nameOf(o.userId)} · ${posLabel(theirs)}`
    : 'Find them';
  $('#t-jump').setAttribute('aria-label', theirs
    ? together
      ? `You are both at ${spokenPos(theirs)}`
      : `Jump to ${nameOf(o.userId)}, at ${spokenPos(theirs)}`
    : 'Find the other reader');

  if (mine && theirs) {
    const usingPages = mine.page != null && theirs.page != null;
    const d = usingPages
      ? Math.abs(mine.page - theirs.page)
      : Math.abs((mine.percent ?? 0) - (theirs.percent ?? 0));
    const a = mine.percent ?? 0;
    const b = theirs.percent ?? 0;
    const span = Math.abs(a - b);

    // Paint the stretch of book between you. The number says how far apart; the
    // painted span says *where* that distance is, which is the thing a rail can
    // show and a label can't.
    between.hidden = span < 0.005;
    between.style.top = Math.min(a, b) * 100 + '%';
    between.style.height = span * 100 + '%';
    between.style.background =
      `linear-gradient(${a <= b ? 180 : 0}deg, ${colorOf(me.id)}, ${colorOf(o.userId)})`;

    // The label sits at the midpoint, which is where your own pill sits when the two
    // of you are close — so below a tenth of the book it's dropped rather than drawn
    // underneath the pill. Nothing is lost: at that distance the topbar already says
    // "Together", and the painted span still shows it.
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

function openWhoDialog() {
  $('#who-name').value = me.name;
  const wrap = $('#who-palette');
  wrap.innerHTML = '';
  let picked = me.color;
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.style.background = c.hex;
    b.style.color = c.hex;
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

function bindWhoDialog() {
  $('#who-dlg').addEventListener('close', async (e) => {
    const dlg = $('#who-dlg');
    if (dlg.returnValue !== 'save') return;
    me.name = $('#who-name').value.trim() || 'You';
    me.color = dlg._pick();
    setPref(uidKey + ':name', me.name);
    setPref(uidKey + ':color', me.color);
    $('#t-who').textContent = me.name;
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

boot();
