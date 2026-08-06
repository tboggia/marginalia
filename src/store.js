/**
 * store.js — the seam between the reader and wherever data lives.
 *
 * Everything above this file talks to a Store. Nothing above this file knows whether
 * the bytes are in IndexedDB or Postgres. Phase 5 swaps LocalStore for SupabaseStore
 * and nothing else changes.
 *
 * Store interface:
 *   init()                             -> {docId}
 *   signIn(email, redirectTo)          -> void         (hosted only)
 *   putDocument(file, format, meta?)   -> {docId, title, author, format}
 *   listDocuments()                    -> [{id, title, author, cover, format, createdAt}]
 *   getDocumentSource(docId)           -> {data: ArrayBuffer} | {url: string}
 *   saveDocumentCover(docId, patch)    -> void         (optional; local only)
 *   deleteDocument(docId)              -> void         (hard, owner only)
 *   leaveDocument(docId, opts?)        -> void         (hosted only)
 *   listAnnotations(docId)             -> Annotation[]
 *   saveAnnotation(a)                  -> Annotation   (upsert, sets updatedAt)
 *   deleteAnnotation(id)               -> void         (soft: sets deletedAt)
 *   getProgress(docId)                 -> {userId: {page, yFrac, updatedAt}}
 *   saveProgress(docId, userId, p)     -> void
 *   listMembers(docId)                 -> Member[]     (includes revoked; see revokedAt)
 *   saveMember(docId, m)               -> void
 *   subscribe(docId, cb)               -> unsubscribe
 *
 * Social — see the "social" section in LocalStore for how local mode answers these.
 * Everything marked (hosted only) throws in local mode; app.js guards with isHosted().
 *   getProfile()                       -> {userId, name, color}
 *   saveProfile({name, color})         -> void
 *   listConnections()                  -> [{userId, name, color, status, bookCount}]
 *   listSharedBooks(userId)            -> Document[]
 *   disconnect(userId)                 -> void         (hosted only)
 *   createInvite({kind, docId})        -> {code}       (hosted only)
 *   redeemInvite(code, name)           -> {kind, docId} (hosted only)
 *   revokeInvite(code)                 -> void         (hosted only)
 *   listShares(docId)                  -> [{userId, name, color, revokedAt, leftMarks, isOwner}]
 *   shareDocument(docId, userId)       -> void         (hosted only)
 *   revokeShare(docId, userId, opts?)  -> void         (hosted only)
 *   findDuplicate(docId, userId)       -> {docId} | null
 *   mergeDocuments(keepId, dropId)     -> void         (hosted only)
 *   subscribeUser(cb)                  -> unsubscribe
 */

const DB_NAME = 'marginalia';
const DB_VERSION = 1;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('documents')) {
        db.createObjectStore('documents', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('annotations')) {
        const s = db.createObjectStore('annotations', { keyPath: 'id' });
        s.createIndex('docId', 'docId');
      }
      if (!db.objectStoreNames.contains('progress')) {
        db.createObjectStore('progress', { keyPath: ['docId', 'userId'] });
      }
      if (!db.objectStoreNames.contains('members')) {
        db.createObjectStore('members', { keyPath: ['docId', 'userId'] });
      }
      if (!db.objectStoreNames.contains('outbox')) {
        db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, names, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(names, mode);
    let out;
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
    out = fn(t);
  });
}

const wrap = (req) =>
  new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });

export function newId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export async function sha256(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * LocalStore — full implementation against IndexedDB.
 *
 * The outbox exists here even though nothing drains it locally. That's deliberate:
 * the write path is identical to the one Phase 5 needs, so turning on the remote is
 * a matter of implementing flush(), not restructuring every caller.
 */
export class LocalStore {
  /**
   * `uidKey` is the localStorage prefix app.js already derives from `?me=`, passed in so
   * the profile can live where name and color have always lived. Two tabs with different
   * aliases are two people, and they must not share a profile.
   */
  constructor(uidKey = 'marginalia:uid') {
    this.db = null;
    this.uidKey = uidKey;
    this.listeners = new Map();
    // BroadcastChannel makes a second browser tab behave like the other reader.
    // That's how you test the two-person flow before the backend exists.
    this.channel =
      typeof BroadcastChannel !== 'undefined'
        ? new BroadcastChannel('marginalia')
        : null;
    if (this.channel) {
      this.channel.onmessage = (e) => this._emit(e.data.docId, e.data.change, false);
    }
  }

  async init() {
    this.db = await open();
    return this;
  }

  _emit(docId, change, broadcast = true) {
    for (const cb of this.listeners.get(docId) ?? []) cb(change);
    if (broadcast && this.channel) this.channel.postMessage({ docId, change });
  }

  subscribe(docId, cb) {
    if (!this.listeners.has(docId)) this.listeners.set(docId, new Set());
    this.listeners.get(docId).add(cb);
    return () => this.listeners.get(docId)?.delete(cb);
  }

  /**
   * `meta` is {title, author, cover} — the book's own metadata, read by the caller
   * before the bytes get here (see app.js readBookMeta). All three are optional and
   * the filename stays the fallback for the title: a book with no usable dc:title
   * still has to land on the shelf with something on it.
   */
  async putDocument(file, format, meta = {}) {
    const bytes = await file.arrayBuffer();
    const hash = await sha256(bytes);
    const existing = await tx(this.db, ['documents'], 'readonly', (t) =>
      wrap(t.objectStore('documents').get(hash))
    );
    const doc = existing ?? {
      id: hash,
      // Caller passes the book's own metadata title when it has one; the filename is
      // the fallback, not the source of truth.
      title: meta.title ?? file.name.replace(/\.(pdf|epub)$/i, ''),
      author: meta.author ?? null,
      // A data: URL, small enough (a ~300px JPEG) to sit in the same record as the
      // book. Kept out of listDocuments' sort path and nothing else reads it.
      cover: meta.cover ?? null,
      format,
      bytes,
      createdAt: Date.now(),
    };
    if (!existing) {
      await tx(this.db, ['documents'], 'readwrite', (t) =>
        t.objectStore('documents').put(doc)
      );
    }
    return {
      docId: doc.id, title: doc.title, author: doc.author ?? null,
      format: doc.format, bytes: doc.bytes,
    };
  }

  async listDocuments() {
    return tx(this.db, ['documents'], 'readonly', (t) =>
      wrap(t.objectStore('documents').getAll())
    ).then((docs) =>
      docs
        .map(({ id, title, author, cover, format, createdAt }) => ({
          id, title, author: author ?? null, cover: cover ?? null, format, createdAt,
        }))
        .sort((a, b) => b.createdAt - a.createdAt)
    );
  }

  /**
   * Backfill for books that were shelved before covers existed — app.js renders the
   * fallback jacket, then derives a real cover from the stored bytes and writes it
   * here so the next open is instant. Local-only on purpose: hosted books get their
   * cover at upload time, and re-deriving one would mean pulling a 10MB file back
   * down to make a 30KB thumbnail.
   */
  async saveDocumentCover(docId, patch) {
    const doc = await tx(this.db, ['documents'], 'readonly', (t) =>
      wrap(t.objectStore('documents').get(docId))
    );
    if (!doc) return;
    await tx(this.db, ['documents'], 'readwrite', (t) =>
      t.objectStore('documents').put({ ...doc, ...patch })
    );
  }

  /**
   * Hard delete, unlike deleteAnnotation — there's no undo for removing a book, and no
   * remote copy to reconcile against, so a tombstone would only be dead weight here.
   * Sweeps every store keyed off this docId, not just `documents`, or annotations and
   * progress from a deleted book would linger forever with nothing pointing at them.
   */
  async deleteDocument(docId) {
    await tx(this.db, ['documents', 'annotations', 'progress', 'members'], 'readwrite', (t) => {
      t.objectStore('documents').delete(docId);
      const annReq = t.objectStore('annotations').index('docId').openCursor(IDBKeyRange.only(docId));
      annReq.onsuccess = () => {
        const cursor = annReq.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
      // progress and members key on [docId, userId], with no docId-only index, so
      // sweeping them means walking the whole store and filtering by hand.
      for (const name of ['progress', 'members']) {
        const req = t.objectStore(name).openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          if (cursor.value.docId === docId) cursor.delete();
          cursor.continue();
        };
      }
    });
  }

  /** Same shape SupabaseStore returns, so app.js can't tell the two apart. */
  async getDocumentSource(docId) {
    const doc = await tx(this.db, ['documents'], 'readonly', (t) =>
      wrap(t.objectStore('documents').get(docId))
    );
    return doc ? { data: doc.bytes } : null;
  }

  /* ------------------------------------------------------------------ social
     Local mode is one browser and no accounts, so most of this surface has nothing to
     stand on. The pattern is the one getInviteCode set: reads answer emptily so the UI
     can render its own empty state, and writes throw a sentence a person can act on
     rather than failing silently. app.js guards these with isHosted() before calling,
     so the throws are a backstop, not the normal path. */

  static NEEDS_BACKEND = 'Sharing needs a backend. See DEPLOY.md.';

  async getProfile() {
    return {
      userId: null,
      name: localStorage.getItem(this.uidKey + ':name') ?? 'You',
      color: localStorage.getItem(this.uidKey + ':color') ?? '#E9A13B',
    };
  }

  async saveProfile({ name, color }) {
    try {
      localStorage.setItem(this.uidKey + ':name', name);
      localStorage.setItem(this.uidKey + ':color', color);
    } catch {
      /* private mode — identity is ephemeral, everything else still works */
    }
  }

  async listConnections() {
    return [];
  }

  async listSharedBooks() {
    return [];
  }

  /**
   * The one social read with a real local answer. The members store is populated by the
   * ?me= two-tab flow, so the share sheet shows who is actually in the book even though
   * nobody can be added to it from here.
   */
  async listShares(docId) {
    const members = await this.listMembers(docId);
    return members.map((m) => ({
      userId: m.userId, name: m.name, color: m.color,
      revokedAt: null, leftMarks: true, isOwner: false,
    }));
  }

  async findDuplicate() {
    return null;
  }

  /**
   * Local mode can't hold the same book twice: putDocument keys documents by the file's
   * own sha256 (see `id: hash`), so re-adding a file lands on the record already there.
   * Duplicates need two accounts, which is a hosted idea.
   */
  async listDuplicates() {
    return [];
  }

  /** No accounts to notify, and no socket. BroadcastChannel already covers the tabs. */
  subscribeUser() {
    return () => {};
  }

  async createInvite() {
    throw new Error(LocalStore.NEEDS_BACKEND);
  }
  async redeemInvite() {
    throw new Error(LocalStore.NEEDS_BACKEND);
  }
  async revokeInvite() {
    throw new Error(LocalStore.NEEDS_BACKEND);
  }
  async shareDocument() {
    throw new Error(LocalStore.NEEDS_BACKEND);
  }
  async revokeShare() {
    throw new Error(LocalStore.NEEDS_BACKEND);
  }
  async leaveDocument() {
    throw new Error(LocalStore.NEEDS_BACKEND);
  }
  async disconnect() {
    throw new Error(LocalStore.NEEDS_BACKEND);
  }
  async mergeDocuments() {
    throw new Error(LocalStore.NEEDS_BACKEND);
  }

  async listAnnotations(docId) {
    const all = await tx(this.db, ['annotations'], 'readonly', (t) =>
      wrap(t.objectStore('annotations').index('docId').getAll(docId))
    );
    return all.filter((a) => !a.deletedAt).sort((a, b) => a.createdAt - b.createdAt);
  }

  async saveAnnotation(a) {
    const rec = {
      ...a,
      id: a.id ?? newId(),
      createdAt: a.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    await tx(this.db, ['annotations', 'outbox'], 'readwrite', (t) => {
      t.objectStore('annotations').put(rec);
      t.objectStore('outbox').add({ op: 'upsert', table: 'annotations', row: rec });
    });
    this._emit(rec.docId, { kind: 'annotation', row: rec });
    return rec;
  }

  async deleteAnnotation(id) {
    const rec = await tx(this.db, ['annotations'], 'readonly', (t) =>
      wrap(t.objectStore('annotations').get(id))
    );
    if (!rec) return;
    // Soft delete: undo becomes a column write, and the change feed can carry removals.
    rec.deletedAt = Date.now();
    rec.updatedAt = rec.deletedAt;
    await tx(this.db, ['annotations', 'outbox'], 'readwrite', (t) => {
      t.objectStore('annotations').put(rec);
      t.objectStore('outbox').add({ op: 'upsert', table: 'annotations', row: rec });
    });
    this._emit(rec.docId, { kind: 'annotation', row: rec });
  }

  async getProgress(docId) {
    const all = await tx(this.db, ['progress'], 'readonly', (t) =>
      wrap(t.objectStore('progress').getAll())
    );
    const out = {};
    for (const p of all) if (p.docId === docId) out[p.userId] = p;
    return out;
  }

  async saveProgress(docId, userId, p) {
    const rec = { docId, userId, ...p, updatedAt: Date.now() };
    await tx(this.db, ['progress'], 'readwrite', (t) =>
      t.objectStore('progress').put(rec)
    );
    this._emit(docId, { kind: 'progress', row: rec });
  }

  async listMembers(docId) {
    const all = await tx(this.db, ['members'], 'readonly', (t) =>
      wrap(t.objectStore('members').getAll())
    );
    // revokedAt for shape parity with the hosted adapter, which returns revoked members
    // so their old highlights still have a name on them. Nothing revokes locally.
    return all.filter((m) => m.docId === docId).map((m) => ({ revokedAt: null, ...m }));
  }

  /** One walk of the members store, grouped — same contract as the hosted adapter. */
  async listMembersByDocument(docIds) {
    const wanted = new Set(docIds);
    const all = await tx(this.db, ['members'], 'readonly', (t) =>
      wrap(t.objectStore('members').getAll())
    );
    const out = new Map();
    for (const m of all) {
      if (!wanted.has(m.docId)) continue;
      const list = out.get(m.docId) ?? [];
      list.push({ userId: m.userId, name: m.name, color: m.color });
      out.set(m.docId, list);
    }
    return out;
  }

  async saveMember(docId, m) {
    const rec = { docId, ...m };
    await tx(this.db, ['members'], 'readwrite', (t) =>
      t.objectStore('members').put(rec)
    );
    this._emit(docId, { kind: 'member', row: rec });
  }
}
