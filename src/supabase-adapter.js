/**
 * supabase-adapter.js — Phase 4/5 drop-in.
 *
 * Implements the same interface as LocalStore. To switch the app over, change one
 * line in app.js:
 *
 *   import { LocalStore } from './store.js';
 *   const store = new LocalStore();
 * becomes
 *   import { SupabaseStore } from './supabase-adapter.js';
 *   const store = new SupabaseStore(SUPABASE_URL, SUPABASE_ANON_KEY);
 *
 * Nothing else in the app changes. That's what the adapter seam is for.
 *
 * Not yet exercised against a live project — this is the shape, and the schema it
 * targets is in ../schema.sql. Phase 4 is where it earns its keep.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sha256 } from './store.js';

/** Storage's "that object is already there" — a 409 / "Duplicate". See putDocument. */
const isDuplicate = (err) =>
  err?.statusCode === '409' || err?.statusCode === 409 || /exists|duplicate/i.test(err?.message ?? '');

const toCamel = (r) => ({
  id: r.id,
  docId: r.document_id,
  userId: r.user_id,
  pageNumber: r.page_number,
  spineIndex: r.spine_index,
  type: r.type,
  color: r.color,
  rects: r.rects,
  strokes: r.strokes,
  text: r.text,
  textAnchor: r.text_anchor,
  cfi: r.cfi,
  percent: r.percent,
  note: r.note,
  createdAt: Date.parse(r.created_at),
  updatedAt: Date.parse(r.updated_at),
  deletedAt: r.deleted_at ? Date.parse(r.deleted_at) : null,
});

const toSnake = (a) => ({
  id: a.id,
  document_id: a.docId,
  page_number: a.pageNumber ?? null,
  spine_index: a.spineIndex ?? null,
  type: a.type,
  color: a.color,
  rects: a.rects ?? null,
  strokes: a.strokes ?? null,
  text: a.text ?? null,
  text_anchor: a.textAnchor ?? null,
  cfi: a.cfi ?? null,
  percent: a.percent ?? null,
  note: a.note ?? '',
  deleted_at: a.deletedAt ? new Date(a.deletedAt).toISOString() : null,
  // user_id is deliberately omitted. The column defaults to auth.uid() and the RLS
  // WITH CHECK enforces it. Never let the client name its own author.
});

export class SupabaseStore {
  constructor(url, anonKey) {
    this.sb = createClient(url, anonKey);
    this.channels = new Map();
    this.outbox = [];
  }

  async init() {
    const { data } = await this.sb.auth.getSession();
    this.user = data.session?.user ?? null;
    // Flush anything written while offline. Rows are per-user and idempotent by id,
    // so a replayed upsert is harmless.
    addEventListener('online', () => this.flush());
    return this;
  }

  /**
   * Magic link. `redirectTo` is deliberately caller-supplied and defaults to the
   * exact URL they're standing on — including ?join=..., which has to survive the
   * round trip through their inbox or the invite dies the moment they sign in.
   * This URL must be listed under Authentication → URL Configuration in Supabase,
   * or the link silently bounces to the site root.
   */
  async signIn(email, redirectTo = location.href) {
    return this.sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo },
    });
  }

  async putDocument(file, format, meta = {}) {
    const bytes = await file.arrayBuffer();
    const hash = await sha256(bytes);

    const { data: found } = await this.sb
      .from('documents').select('*').eq('sha256', hash).maybeSingle();
    if (found) {
      return {
        docId: found.id, title: found.title, author: found.author ?? null,
        format: found.format, storagePath: found.storage_path,
      };
    }

    // No upsert, deliberately. `upsert: true` sends x-upsert, which turns the write
    // into INSERT ... ON CONFLICT DO UPDATE — and that makes Postgres consult the
    // UPDATE *and SELECT* policies, not just INSERT. read_books (the SELECT policy)
    // requires a documents row whose storage_path matches this object, but that row is
    // written below, *after* the upload. So an upsert can never satisfy it and every
    // upload dies with "new row violates row-level security policy". A plain insert
    // only checks upload_books, which is exactly the rule we mean to enforce.
    //
    // Nothing is lost: the path is content-addressed (sha256), and the lookup above
    // already returns early when this book is known. If the object is somehow present
    // without its documents row — a previous run that died between the two writes —
    // the bytes at that path are byte-identical by definition, so "already exists" is
    // success, not a failure.
    const path = `${this.user.id}/${hash}.${format}`;
    const up = await this.sb.storage.from('books').upload(path, file);
    if (up.error && !isDuplicate(up.error)) throw up.error;

    const { data, error } = await this.sb
      .from('documents')
      .insert({
        title: meta.title ?? file.name.replace(/\.(pdf|epub)$/i, ''),
        author: meta.author ?? null,
        // The cover rides in the row, not the bucket: it's a ~30KB data: URL, and a
        // second storage object would need its own path convention, its own RLS
        // policy, and its own signed URL on every shelf render to show a thumbnail.
        cover: meta.cover ?? null,
        storage_path: path, sha256: hash, format,
      })
      .select().single();
    if (error) throw error;

    // Seed the creator's membership from their profile rather than the old hardcoded
    // "You" / amber. Everyone reads this row, and "You" is only the right word to one
    // person — it used to be what the other reader saw on your highlights.
    const profile = await this.getProfile();
    await this.saveMember(data.id, {
      userId: this.user.id, name: profile.name, color: profile.color,
    });
    return {
      docId: data.id, title: data.title, author: data.author ?? null,
      format: data.format, storagePath: path,
    };
  }

  /**
   * Returns a signed URL rather than bytes. pdf.js takes a url and issues HTTP range
   * requests against it, so a 400MB book streams the pages you're looking at instead
   * of downloading the whole thing before the first render.
   */
  async getDocumentSource(docId) {
    const { data: doc } = await this.sb
      .from('documents').select('storage_path').eq('id', docId).single();
    const { data, error } = await this.sb.storage
      .from('books').createSignedUrl(doc.storage_path, 60 * 60 * 8);
    if (error) throw error;
    return { url: data.signedUrl };
  }

  async listDocuments() {
    const { data, error } = await this.sb
      .from('documents')
      .select('id,title,author,cover,format,created_at')
      .order('created_at', { ascending: false });
    // A schema drift here (a column the deployed database never got) comes back as a
    // 400 and an empty shelf, which reads exactly like "you have no books yet".
    if (error) throw error;
    return (data ?? []).map((d) => ({
      id: d.id, title: d.title, author: d.author ?? null, cover: d.cover ?? null,
      format: d.format, createdAt: Date.parse(d.created_at),
    }));
  }

  /**
   * Hard delete. The storage object has to go first: once the `documents` row is gone,
   * `delete_books`'s policy (which joins back to `documents` to check membership) has
   * nothing left to join against, and the object would be orphaned in the bucket
   * forever. Deleting the row after cascades memberships/progress/annotations via the
   * `on delete cascade` foreign keys in schema.sql — no client-side cleanup needed there.
   */
  async deleteDocument(docId) {
    const { data: doc, error: findErr } = await this.sb
      .from('documents').select('storage_path').eq('id', docId).single();
    if (findErr) throw findErr;

    const { error: storageErr } = await this.sb.storage.from('books').remove([doc.storage_path]);
    if (storageErr) throw storageErr;

    // `.select()` so the delete reports what it actually removed. RLS does not error on
    // a forbidden delete — it filters the row out and returns success — so without this
    // a missing `delete_documents` policy looks exactly like a working delete until the
    // shelf re-renders with the book still on it.
    const { data: gone, error } = await this.sb
      .from('documents').delete().eq('id', docId).select('id');
    if (error) throw error;
    // Deleting is owner-only now (social.sql), where it used to be any member. A
    // non-owner's delete is filtered to zero rows rather than erroring, so without this
    // check it looks like it worked until the shelf re-renders.
    if (!gone?.length) {
      throw new Error('Only the person who added this book can delete it. You can leave it instead.');
    }
  }

  /**
   * A book you don't own is left, not deleted — the owner's copy and everyone else's
   * marks survive. Revoking your own membership is the same call the share sheet makes
   * on someone else, which is why it goes through revoke_share rather than a plain
   * delete on the memberships row.
   */
  async leaveDocument(docId, { leaveMarks = true } = {}) {
    const { error } = await this.sb.rpc('revoke_share', {
      doc: docId, target: this.user.id, leave_marks: leaveMarks,
    });
    if (error) throw new Error(error.message);
  }

  /* ------------------------------------------------------------------ social */

  async getProfile() {
    const { data, error } = await this.sb
      .from('profiles').select('*').eq('user_id', this.user.id).maybeSingle();
    if (error) throw error;
    if (!data) return { userId: this.user.id, name: 'Reader', color: '#E9A13B' };
    return { userId: data.user_id, name: data.display_name, color: data.color };
  }

  /**
   * The profile is the preference. `memberships.color` stays authoritative inside a
   * book, because two readers of one book must not share a color and that can only be
   * settled per book — so the name propagates everywhere and the color does not.
   */
  async saveProfile({ name, color }) {
    const { error } = await this.sb.from('profiles').upsert({
      user_id: this.user.id,
      display_name: name,
      color,
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
    await this.sb
      .from('memberships').update({ display_name: name }).eq('user_id', this.user.id);
  }

  async listConnections() {
    const { data, error } = await this.sb.rpc('list_connections');
    if (error) throw new Error(error.message);
    return (data ?? []).map((c) => ({
      userId: c.user_id, name: c.name, color: c.color,
      status: c.status, bookCount: Number(c.book_count ?? 0),
    }));
  }

  async disconnect(userId) {
    // The pair is stored once, ordered, so either column can hold them.
    const { error } = await this.sb
      .from('connections').delete()
      .or(`user_a.eq.${userId},user_b.eq.${userId}`);
    if (error) throw error;
  }

  /** The books the two of you are both currently in. Grants, not connections. */
  async listSharedBooks(userId) {
    const { data, error } = await this.sb
      .from('memberships')
      .select('document_id, documents(id,title,author,cover,format,created_at)')
      .eq('user_id', userId).is('revoked_at', null);
    if (error) throw error;
    const mine = new Set((await this.listDocuments()).map((d) => d.id));
    return (data ?? [])
      .map((r) => r.documents)
      .filter((d) => d && mine.has(d.id))
      .map((d) => ({
        id: d.id, title: d.title, author: d.author ?? null, cover: d.cover ?? null,
        format: d.format, createdAt: Date.parse(d.created_at),
      }));
  }

  async createInvite({ kind, docId = null, maxUses = 1, expiresInDays = 14 } = {}) {
    const { data, error } = await this.sb
      .from('invites')
      .insert({
        kind,
        document_id: docId,
        max_uses: maxUses,
        expires_at: expiresInDays
          ? new Date(Date.now() + expiresInDays * 864e5).toISOString()
          : null,
      })
      .select('code').single();
    if (error) throw error;
    return { code: data.code };
  }

  /**
   * Cross the read barrier: you can't see a document, or an invite, until the function
   * lets you. Returns {kind, docId} — a book invite lands you in the book, a connect
   * invite only links the two accounts.
   */
  async redeemInvite(code, name) {
    const { data, error } = await this.sb.rpc('redeem_invite', { code, name });
    if (error) throw new Error(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    return { kind: row?.invite_kind ?? null, docId: row?.doc_id ?? null };
  }

  async revokeInvite(code) {
    const { error } = await this.sb.rpc('revoke_invite', { invite_code: code });
    if (error) throw new Error(error.message);
  }

  async listShares(docId) {
    const { data, error } = await this.sb.rpc('list_shares', { doc: docId });
    if (error) throw new Error(error.message);
    return (data ?? []).map((s) => ({
      userId: s.user_id, name: s.name, color: s.color,
      revokedAt: s.revoked_at ? Date.parse(s.revoked_at) : null,
      leftMarks: s.left_marks, isOwner: s.is_owner,
    }));
  }

  async shareDocument(docId, userId) {
    const { error } = await this.sb.rpc('share_document', { doc: docId, target: userId });
    if (error) throw new Error(error.message);
  }

  async revokeShare(docId, userId, { leaveMarks = true } = {}) {
    const { error } = await this.sb.rpc('revoke_share', {
      doc: docId, target: userId, leave_marks: leaveMarks,
    });
    if (error) throw new Error(error.message);
  }

  /** Null unless they hold a byte-identical file. See mergeDocuments. */
  async findDuplicate(docId, userId) {
    const { data, error } = await this.sb.rpc('find_duplicate', { doc: docId, target: userId });
    if (error) throw new Error(error.message);
    return data ? { docId: data } : null;
  }

  /**
   * Books sitting in your library twice — yours, and someone else's copy of the same
   * file that was shared with you. Only pairs you can act on come back: `mine` is always
   * a copy you created, because that is the only kind you are allowed to give up.
   */
  async listDuplicates() {
    const { data, error } = await this.sb.rpc('find_my_duplicates');
    if (error) throw new Error(error.message);
    return (data ?? []).map((d) => ({
      mineId: d.mine, mineTitle: d.mine_title,
      theirsId: d.theirs, theirsTitle: d.theirs_title,
      ownerName: d.owner_name,
    }));
  }

  /**
   * Only ever safe between identical files, which the RPC re-checks by hash before it
   * touches a row. It returns the dropped copy's storage path rather than deleting the
   * object itself: removing the storage.objects row in SQL would drop the record and
   * leave the file orphaned in the bucket.
   */
  async mergeDocuments(keepId, dropId) {
    const { data: path, error } = await this.sb.rpc('merge_documents', {
      keep: keepId, drop_id: dropId,
    });
    if (error) throw new Error(error.message);
    if (path) await this.sb.storage.from('books').remove([path]);
  }

  async listAnnotations(docId) {
    const { data, error } = await this.sb
      .from('annotations').select('*')
      .eq('document_id', docId).is('deleted_at', null)
      .order('created_at');
    if (error) throw error;
    return data.map(toCamel);
  }

  async saveAnnotation(a) {
    const row = toSnake({ ...a, id: a.id ?? crypto.randomUUID() });
    const { data, error } = await this.sb
      .from('annotations').upsert(row).select().single();
    if (error) {
      this.outbox.push(row);
      // Return the optimistic row so the UI paints immediately. The write replays
      // on reconnect; the id is client-generated, so replay is idempotent.
      return { ...a, id: row.id, updatedAt: Date.now() };
    }
    return toCamel(data);
  }

  async deleteAnnotation(id) {
    await this.sb
      .from('annotations')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id);
  }

  async flush() {
    const queued = this.outbox.splice(0);
    for (const row of queued) {
      const { error } = await this.sb.from('annotations').upsert(row);
      if (error) this.outbox.push(row);
    }
  }

  async getProgress(docId) {
    const { data } = await this.sb.from('progress').select('*').eq('document_id', docId);
    const out = {};
    for (const p of data ?? []) {
      out[p.user_id] = {
        userId: p.user_id, page: p.page, yFrac: p.y_frac,
        cfi: p.cfi, percent: p.percent,
        updatedAt: Date.parse(p.updated_at),
      };
    }
    return out;
  }

  async saveProgress(docId, userId, p) {
    await this.sb.from('progress').upsert({
      document_id: docId, user_id: userId,
      page: p.page ?? null, y_frac: p.yFrac ?? null,
      cfi: p.cfi ?? null, percent: p.percent ?? 0,
      updated_at: new Date().toISOString(),
    });
  }

  /**
   * Revoked members come back too, carrying `revokedAt`. They have to: a reader who left
   * their marks behind still has highlights on the page, and those need a name and a
   * color next to them. Callers that mean "who is in this book right now" filter on
   * revokedAt themselves.
   */
  async listMembers(docId) {
    const { data } = await this.sb.from('memberships').select('*').eq('document_id', docId);
    return (data ?? []).map((m) => ({
      docId: m.document_id, userId: m.user_id, name: m.display_name, color: m.color,
      revokedAt: m.revoked_at ? Date.parse(m.revoked_at) : null,
    }));
  }

  async saveMember(docId, m) {
    await this.sb.from('memberships').upsert({
      document_id: docId, user_id: m.userId,
      display_name: m.name, color: m.color,
    });
  }

  /**
   * Every book's readers in one round trip, for the shelf badges. Doing this per card
   * would be one request per book on every render of the library screen — the same
   * mistake the cover column exists to avoid (see putDocument).
   */
  async listMembersByDocument(docIds) {
    if (!docIds.length) return new Map();
    const { data, error } = await this.sb
      .from('memberships')
      .select('document_id,user_id,display_name,color')
      .in('document_id', docIds).is('revoked_at', null);
    if (error) throw error;
    const out = new Map();
    for (const m of data ?? []) {
      const list = out.get(m.document_id) ?? [];
      list.push({ userId: m.user_id, name: m.display_name, color: m.color });
      out.set(m.document_id, list);
    }
    return out;
  }

  /**
   * A DELETE arrives with an empty `new` and the removed row in `old`. Reading `new`
   * unconditionally turned every removal into a row of undefineds, which downstream read
   * as a member with no id. Membership removals are soft now (revoked_at), so this
   * mostly guards annotations — but a hard delete has to be a removal, not a ghost.
   */
  subscribe(docId, cb) {
    const rowOf = (p) => (p.eventType === 'DELETE' ? p.old : p.new) ?? {};
    const ch = this.sb
      .channel(`doc:${docId}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'annotations', filter: `document_id=eq.${docId}` },
        (p) => {
          const row = rowOf(p);
          if (!row.id) return;
          cb({
            kind: 'annotation',
            row: p.eventType === 'DELETE'
              ? { ...toCamel(row), deletedAt: Date.now() }
              : toCamel(row),
          });
        })
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'progress', filter: `document_id=eq.${docId}` },
        (p) => {
          const r = rowOf(p);
          if (!r.user_id) return;
          cb({
            kind: 'progress',
            row: { userId: r.user_id, page: r.page, yFrac: r.y_frac,
                   cfi: r.cfi, percent: r.percent,
                   updatedAt: Date.parse(r.updated_at) },
          });
        })
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'memberships', filter: `document_id=eq.${docId}` },
        (p) => {
          const r = rowOf(p);
          if (!r.user_id) return;
          cb({
            kind: 'member',
            row: {
              docId, userId: r.user_id, name: r.display_name, color: r.color,
              revokedAt: r.revoked_at ? Date.parse(r.revoked_at) : null,
              // A hard delete of the row is a removal; a revoke is a state change.
              removed: p.eventType === 'DELETE',
            },
          });
        })
      .subscribe();
    this.channels.set(docId, ch);
    return () => {
      this.channels.delete(docId);
      this.sb.removeChannel(ch);
    };
  }

  /**
   * Per-user, not per-document — the first channel in the app that isn't scoped to an
   * open book. It exists because the two things you most need to hear about arrive while
   * you're sitting on the shelf with nothing open: someone shared a book with you, or
   * someone connected to you.
   *
   * `connections` carries no filter: the pair is stored ordered, so neither column
   * reliably holds you, and RLS plus replica identity already restrict the rows to yours.
   */
  subscribeUser(cb) {
    const ch = this.sb
      .channel(`user:${this.user.id}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'memberships',
          filter: `user_id=eq.${this.user.id}` },
        (p) => {
          const r = (p.eventType === 'DELETE' ? p.old : p.new) ?? {};
          if (!r.document_id) return;
          cb({
            kind: 'share',
            row: {
              docId: r.document_id,
              revokedAt: r.revoked_at ? Date.parse(r.revoked_at) : null,
              removed: p.eventType === 'DELETE',
            },
          });
        })
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'connections' },
        () => cb({ kind: 'connection' }))
      .subscribe();
    return () => this.sb.removeChannel(ch);
  }
}
