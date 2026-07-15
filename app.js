/**
 * app.js — wiring. Identity, tools, the annotation lifecycle, the spine, the panel.
 *
 * This file is allowed to be about the product. Coordinates live in geometry.js,
 * selection lives in anchors.js, persistence lives in store.js. If a pixel value or
 * an IndexedDB call appears below, it's in the wrong file.
 */

import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs';
import { Reader } from './reader.js';
import { LocalStore, newId } from './store.js';
import { config, isHosted } from './config.js';
import { readSelection, hitTest } from './anchors.js';
import { redraw, distanceToStroke } from './ink.js';
import { toPage } from './geometry.js';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';

const COLORS = [
  { name: 'amber',   hex: '#E9A13B' },
  { name: 'cyan',    hex: '#3FBFC9' },
  { name: 'magenta', hex: '#D95B9A' },
  { name: 'violet',  hex: '#8A7BE0' },
  { name: 'lime',    hex: '#7FBF3F' },
  { name: 'coral',   hex: '#E4663F' },
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

const reader = new Reader($('#pages'), pdfjsLib);

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

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.dataset.show = 'true';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.dataset.show = 'false'), 2600);
}

/* -------------------------------------------------------------------- boot */
async function boot() {
  await store.init();

  if (isHosted()) {
    // In hosted mode identity comes from the session, not from a query param. ?me=
    // is a local-mode testing affordance and must not survive contact with real users.
    if (!store.user) return showAuth();
    me = {
      id: store.user.id,
      name: store.user.user_metadata?.name ?? store.user.email?.split('@')[0] ?? 'You',
      color: pref('marginalia:color', COLORS[0].hex),
    };
    $('#auth').hidden = true;
  }

  buildPalette();
  bindTools();
  bindStart();
  bindSelection();
  bindNoteDialog();
  bindWhoDialog();
  $('#t-who').textContent = me.name;
  await renderRecent();
  await handleInviteLink();
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
    await openDoc(id, docs.find((d) => d.id === id)?.title ?? 'Shared book');
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

async function renderRecent() {
  const docs = await store.listDocuments();
  const el = $('#recent');
  el.innerHTML = '';
  if (!docs.length) return;
  for (const d of docs.slice(0, 5)) {
    const b = document.createElement('button');
    b.className = 'recent-item';
    b.innerHTML = `<span style="color:var(--muted)">${escape(d.title)}</span><span>reopen</span>`;
    b.onclick = () => openDoc(d.id, d.title);
    el.appendChild(b);
  }
}

/* ------------------------------------------------------------------ opening */
function bindStart() {
  const drop = $('#drop');
  $('#pick').onclick = () => $('#file').click();
  $('#file').onchange = (e) => e.target.files[0] && ingest(e.target.files[0]);

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

async function ingest(file) {
  if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
    toast('That file is not a PDF.');
    return;
  }
  const { docId: id, title } = await store.putDocument(file);
  await openDoc(id, title);
}

async function openDoc(id, title) {
  docId = id;
  $('#title').textContent = title;
  $('#start').hidden = true;

  const source = await store.getDocumentSource(id);
  if (!source) {
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

  const count = await reader.load(source);
  $('#spine-bot').textContent = String(count);

  reader.getInkState = () => ({ inkMode: tool === 'ink', color: me.color });
  reader.onInkCommit = commitStroke;
  reader.onProgress = async (p) => {
    await store.saveProgress(docId, me.id, p);
    progress[me.id] = { ...p, userId: me.id, updatedAt: Date.now() };
    renderSpine();
  };
  reader.renderAnnotations = renderAnnotations;

  store.subscribe(id, onRemoteChange);

  const mine = progress[me.id];
  if (mine) {
    await reader.goTo(mine.page, mine.yFrac);
    toast(`Back on page ${mine.page}.`);
  } else {
    // Opening the book is itself a position. Without this, a reader who hasn't
    // scrolled yet has no progress row, so they're invisible on the other person's
    // spine — they've opened the book and their partner can't tell.
    await store.saveProgress(id, me.id, { page: 1, yFrac: 0 });
    progress[me.id] = { userId: me.id, page: 1, yFrac: 0, updatedAt: Date.now() };
  }
  renderAnnotations();
  renderPanel();
  renderSpine();
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
        toast(`${nameOf(change.row.userId)} marked up page ${change.row.pageNumber}.`);
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

/* ------------------------------------------------------------------- tools */
function bindTools() {
  const set = (t) => {
    tool = t;
    app.dataset.ink = t === 'ink' ? 'on' : 'off';
    $('#t-select').ariaPressed = String(t === 'select');
    $('#t-ink').ariaPressed = String(t === 'ink');
    $('#t-erase').ariaPressed = String(t === 'erase');
  };
  $('#t-select').onclick = () => set('select');
  $('#t-ink').onclick = () => set('ink');
  $('#t-erase').onclick = () => set('erase');

  $('#zoom-in').onclick = () => setZoom(reader.scale + 0.2);
  $('#zoom-out').onclick = () => setZoom(reader.scale - 0.2);

  $('#t-panel').onclick = () => {
    const open = app.dataset.panel === 'open';
    app.dataset.panel = open ? 'closed' : 'open';
    $('#t-panel').ariaPressed = String(!open);
  };

  $('#t-jump').onclick = () => {
    const o = other();
    const p = o && progress[o.userId];
    if (!p) return toast('Nobody else has opened this book yet.');
    reader.goTo(p.page, p.yFrac, true);
  };

  $('#t-who').onclick = openWhoDialog;
  $('#t-invite').onclick = copyInvite;

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    if (e.key === 'v') set('select');
    if (e.key === 'd') set('ink');
    if (e.key === 'e') set('erase');
    if (e.key === 'Escape') closePopover();
    if ((e.metaKey || e.ctrlKey) && e.key === '=') { e.preventDefault(); setZoom(reader.scale + 0.2); }
    if ((e.metaKey || e.ctrlKey) && e.key === '-') { e.preventDefault(); setZoom(reader.scale - 0.2); }
  });
}

async function setZoom(s) {
  await reader.setScale(s);
  $('#zoom').textContent = Math.round(reader.scale * 100) + '%';
  renderAnnotations();
}

function buildPalette() {
  const wrap = $('#palette');
  wrap.innerHTML = '';
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = c.hex;
    b.style.color = c.hex;
    b.ariaPressed = String(c.hex === me.color);
    b.title = c.name;
    b.onclick = async () => {
      me.color = c.hex;
      setPref(uidKey + ':color', c.hex);
      buildPalette();
      if (docId) await store.saveMember(docId, { userId: me.id, name: me.name, color: c.hex });
    };
    wrap.appendChild(b);
  }
}

/* -------------------------------------------------------------- highlights */
function bindSelection() {
  document.addEventListener('pointerup', (e) => {
    if (tool !== 'select' || e.pointerType === 'pen') return;
    // Let the browser finish resolving the selection before reading it.
    setTimeout(() => {
      const sel = readSelection(document);
      if (!sel) return closePopover();
      if (sel.crossPage) {
        closePopover();
        return toast('Highlights stop at the page edge — select within one page.');
      }
      pending = sel;
      openPopover(sel, e.clientX, e.clientY);
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
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = c.hex;
    b.style.color = c.hex;
    b.ariaPressed = String(c.hex === me.color);
    b.onclick = () => createHighlight(sel, c.hex, false);
    pop.appendChild(b);
  }
  const note = document.createElement('button');
  note.className = 'act';
  note.textContent = 'Add note';
  note.onclick = () => createHighlight(sel, me.color, true);
  pop.appendChild(note);

  pop.dataset.open = 'true';
  const r = pop.getBoundingClientRect();
  pop.style.left = Math.min(Math.max(8, x - r.width / 2), innerWidth - r.width - 8) + 'px';
  pop.style.top = Math.max(8, y - r.height - 12) + 'px';
}

function closePopover() {
  $('#pop').dataset.open = 'false';
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
    pageNumber: sel.pageNumber,
    color,
    rects: sel.rects,
    text: sel.text,
    textAnchor: sel.textAnchor,
    note: '',
  });
  getSelection()?.removeAllRanges();
  closePopover();
  renderAnnotations(sel.pageNumber);
  renderPanel();
  renderSpine();
  if (withNote) openNoteDialog(a);
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
  const pageNums = only ? [only] : reader.pages.map((p) => p.num);
  for (const n of pageNums) {
    const el = reader.pageEl(n);
    if (!el) continue;
    const mine = annotations.filter((a) => a.pageNumber === n);

    const hl = el.querySelector('.hl-layer');
    hl.innerHTML = '';
    for (const a of mine.filter((a) => a.type === 'highlight')) {
      for (const r of a.rects) {
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
    if (ink.width) {
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
    .sort((a, b) => a.pageNumber - b.pageNumber);
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
      `<span>p.${a.pageNumber}</span></div>` +
      (a.text ? `<div class="note-quote">${escape(a.text)}</div>` : '') +
      (a.note ? `<div class="note-body">${escape(a.note)}</div>` : '');
    div.onclick = () => reader.goTo(a.pageNumber, Math.max(0, a.rects[0].y - 0.12), true);
    el.appendChild(div);
  }
  void withText;
}

/* ------------------------------------------------------------------- spine */
function renderSpine() {
  const track = $('#track');
  const total = reader.pageCount || 1;
  const frac = (page) => (total > 1 ? (page - 1) / (total - 1) : 0);

  track.querySelectorAll('.tick, .marker').forEach((n) => n.remove());

  for (const a of annotations) {
    const t = document.createElement('div');
    t.className = 'tick';
    t.style.top = frac(a.pageNumber) * 100 + '%';
    t.style.background = colorOf(a.userId);
    track.appendChild(t);
  }

  const rows = Object.values(progress);
  for (const p of rows) {
    const m = document.createElement('button');
    const isMe = p.userId === me.id;
    m.className = 'marker' + (isMe ? '' : ' them');
    m.style.top = frac(p.page) * 100 + '%';
    m.style.background = colorOf(p.userId);
    m.textContent = isMe ? String(p.page) : '';
    m.title = `${nameOf(p.userId)} — page ${p.page}`;
    m.onclick = () => reader.goTo(p.page, p.yFrac, true);
    track.appendChild(m);
  }

  // The gap is the point of the whole rail: how far apart the two of you are,
  // in the only unit that matters here.
  const o = other();
  const mine = progress[me.id];
  const theirs = o && progress[o.userId];
  const gap = $('#gap');
  const jump = $('#jump-label');
  // The label only needs to know where they are. The gap needs both of you.
  jump.textContent = theirs
    ? mine && mine.page === theirs.page
      ? 'Together'
      : `${nameOf(o.userId)} · p.${theirs.page}`
    : 'Find them';

  if (mine && theirs) {
    const d = Math.abs(mine.page - theirs.page);
    gap.textContent = d === 0 ? 'together' : `${d}p`;
    const mid = (frac(mine.page) + frac(theirs.page)) / 2;
    gap.style.top = `calc(40px + ${mid} * (100% - 80px) - 5px)`;
  } else {
    gap.textContent = '';
  }
}

/* ------------------------------------------------------------------ dialogs */
function openNoteDialog(a) {
  editing = a;
  const dlg = $('#note-dlg');
  $('#note-quote').textContent = a.text ? `"${a.text.slice(0, 180)}"` : `Page ${a.pageNumber}`;
  const ta = $('#note-text');
  ta.value = a.note ?? '';
  const own = a.userId === me.id;
  ta.readOnly = !own;
  ta.placeholder = own ? 'What did you think?' : `${nameOf(a.userId)} left no note here.`;
  $('#note-del').style.display = own ? '' : 'none';
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
      renderAnnotations(a.pageNumber);
      renderPanel();
    }
    if (dlg.returnValue === 'delete') {
      await store.deleteAnnotation(a.id);
      renderAnnotations(a.pageNumber);
      renderPanel();
      renderSpine();
    }
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
    buildPalette();
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
