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

const toCamel = (r) => ({
  id: r.id,
  docId: r.document_id,
  userId: r.user_id,
  pageNumber: r.page_number,
  type: r.type,
  color: r.color,
  rects: r.rects,
  strokes: r.strokes,
  text: r.text,
  textAnchor: r.text_anchor,
  note: r.note,
  createdAt: Date.parse(r.created_at),
  updatedAt: Date.parse(r.updated_at),
  deletedAt: r.deleted_at ? Date.parse(r.deleted_at) : null,
});

const toSnake = (a) => ({
  id: a.id,
  document_id: a.docId,
  page_number: a.pageNumber,
  type: a.type,
  color: a.color,
  rects: a.rects ?? null,
  strokes: a.strokes ?? null,
  text: a.text ?? null,
  text_anchor: a.textAnchor ?? null,
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

  async putDocument(file) {
    const bytes = await file.arrayBuffer();
    const hash = await sha256(bytes);

    const { data: found } = await this.sb
      .from('documents').select('*').eq('sha256', hash).maybeSingle();
    if (found) return { docId: found.id, title: found.title, storagePath: found.storage_path };

    const path = `${this.user.id}/${hash}.pdf`;
    const up = await this.sb.storage.from('books').upload(path, file, { upsert: true });
    if (up.error) throw up.error;

    const { data, error } = await this.sb
      .from('documents')
      .insert({ title: file.name.replace(/\.pdf$/i, ''), storage_path: path, sha256: hash })
      .select().single();
    if (error) throw error;

    await this.saveMember(data.id, { userId: this.user.id, name: 'You', color: '#E9A13B' });
    return { docId: data.id, title: data.title, storagePath: path };
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
    const { data } = await this.sb
      .from('documents').select('id,title,created_at').order('created_at', { ascending: false });
    return (data ?? []).map((d) => ({
      id: d.id, title: d.title, createdAt: Date.parse(d.created_at),
    }));
  }

  async getInviteCode(docId) {
    const { data } = await this.sb
      .from('documents').select('invite_code').eq('id', docId).single();
    return data?.invite_code ?? null;
  }

  /** Cross the read barrier: you can't see a document until you're a member of it. */
  async joinByCode(code, name) {
    const { data, error } = await this.sb.rpc('join_document', { code, name });
    if (error) throw new Error(error.message);
    return data; // document id
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
        updatedAt: Date.parse(p.updated_at),
      };
    }
    return out;
  }

  async saveProgress(docId, userId, p) {
    await this.sb.from('progress').upsert({
      document_id: docId, user_id: userId,
      page: p.page, y_frac: p.yFrac,
      updated_at: new Date().toISOString(),
    });
  }

  async listMembers(docId) {
    const { data } = await this.sb.from('memberships').select('*').eq('document_id', docId);
    return (data ?? []).map((m) => ({
      docId: m.document_id, userId: m.user_id, name: m.display_name, color: m.color,
    }));
  }

  async saveMember(docId, m) {
    await this.sb.from('memberships').upsert({
      document_id: docId, user_id: m.userId,
      display_name: m.name, color: m.color,
    });
  }

  subscribe(docId, cb) {
    const ch = this.sb
      .channel(`doc:${docId}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'annotations', filter: `document_id=eq.${docId}` },
        (p) => cb({ kind: 'annotation', row: toCamel(p.new) }))
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'progress', filter: `document_id=eq.${docId}` },
        (p) => cb({
          kind: 'progress',
          row: { userId: p.new.user_id, page: p.new.page, yFrac: p.new.y_frac,
                 updatedAt: Date.parse(p.new.updated_at) },
        }))
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'memberships', filter: `document_id=eq.${docId}` },
        (p) => cb({
          kind: 'member',
          row: { docId, userId: p.new.user_id, name: p.new.display_name, color: p.new.color },
        }))
      .subscribe();
    this.channels.set(docId, ch);
    return () => this.sb.removeChannel(ch);
  }
}
