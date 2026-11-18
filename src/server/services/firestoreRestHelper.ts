import { firebaseAppletConfig, getAdminDb } from '../firebaseServer.ts';

type FirestoreRestValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { stringValue: string }
  | { timestampValue: string }
  | { arrayValue: { values?: FirestoreRestValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreRestValue> } };

interface FirestoreRestDoc {
  name: string;
  fields?: Record<string, FirestoreRestValue>;
}

const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${firebaseAppletConfig.projectId}/databases/${firebaseAppletConfig.firestoreDatabaseId}/documents`;

export function toFirestoreValue(val: unknown): FirestoreRestValue {
  if (val === null || val === undefined) {
    return { nullValue: null };
  }
  if (typeof val === 'boolean') {
    return { booleanValue: val };
  }
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return { nullValue: null };
    if (Number.isInteger(val) && Math.abs(val) <= Number.MAX_SAFE_INTEGER) {
      return { integerValue: String(val) };
    }
    return { doubleValue: val };
  }
  if (typeof val === 'string') {
    return { stringValue: val };
  }
  if (Array.isArray(val)) {
    return {
      arrayValue: {
        values: val.map((item) => toFirestoreValue(item)),
      },
    };
  }
  if (typeof val === 'object') {
    const fields: Record<string, FirestoreRestValue> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (v === undefined) continue;
      fields[k] = toFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

export function fromFirestoreValue(val: FirestoreRestValue | undefined): unknown {
  if (!val) return null;
  if ('nullValue' in val) return null;
  if ('booleanValue' in val) return Boolean(val.booleanValue);
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('stringValue' in val) return val.stringValue;
  if ('timestampValue' in val) return Date.parse(val.timestampValue);
  if ('arrayValue' in val) {
    return (val.arrayValue.values ?? []).map((v) => fromFirestoreValue(v));
  }
  if ('mapValue' in val) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val.mapValue.fields ?? {})) {
      out[k] = fromFirestoreValue(v);
    }
    return out;
  }
  return null;
}

function docFromRest(restDoc: FirestoreRestDoc): { id: string; data: Record<string, unknown> } {
  const segments = restDoc.name.split('/');
  const id = decodeURIComponent(segments[segments.length - 1] || '');
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(restDoc.fields ?? {})) {
    data[k] = fromFirestoreValue(v);
  }
  return { id, data };
}

function fieldsToRestBody(data: Record<string, unknown>): { fields: Record<string, FirestoreRestValue> } {
  const fields: Record<string, FirestoreRestValue> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    fields[k] = toFirestoreValue(v);
  }
  return { fields };
}

export interface StoredDocEntry {
  id: string;
  data: Record<string, unknown>;
}

export interface BackupDataStore {
  listCollection(collection: string, bearerToken?: string): Promise<StoredDocEntry[]>;
  getDocument(
    collection: string,
    docId: string,
    bearerToken?: string
  ): Promise<Record<string, unknown> | null>;
  setDocument(
    collection: string,
    docId: string,
    data: Record<string, unknown>,
    bearerToken?: string
  ): Promise<void>;
  deleteDocument(collection: string, docId: string, bearerToken?: string): Promise<void>;
  replaceCollection(
    collection: string,
    docs: StoredDocEntry[],
    bearerToken?: string
  ): Promise<number>;
}

async function restFetch(
  url: string,
  bearerToken: string | undefined,
  init?: RequestInit
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init?.headers as Record<string, string>) || {}),
  };
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }
  return fetch(url, { ...init, headers });
}

export class FirestoreDualDataStore implements BackupDataStore {
  async listCollection(collection: string, bearerToken?: string): Promise<StoredDocEntry[]> {
    const adminDb = getAdminDb();
    if (adminDb) {
      const results: StoredDocEntry[] = [];
      let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
      while (true) {
        let q: FirebaseFirestore.Query = adminDb.collection(collection).orderBy('__name__').limit(300);
        if (lastDoc) q = q.startAfter(lastDoc);
        const snap = await q.get();
        if (snap.empty) break;
        for (const docSnap of snap.docs) {
          results.push({ id: docSnap.id, data: docSnap.data() as Record<string, unknown> });
        }
        lastDoc = snap.docs[snap.docs.length - 1];
        if (snap.size < 300) break;
      }
      return results;
    }

    const results: StoredDocEntry[] = [];
    let pageToken: string | undefined;
    while (true) {
      const params = new URLSearchParams({ pageSize: '300' });
      if (pageToken) params.set('pageToken', pageToken);
      const url = `${FIRESTORE_BASE}/${encodeURIComponent(collection)}?${params.toString()}`;
      const res = await restFetch(url, bearerToken, { method: 'GET' });
      if (res.status === 404) {
        return [];
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Gagal membaca koleksi ${collection} (HTTP ${res.status}): ${text.slice(0, 200)}`);
      }
      const body = (await res.json()) as {
        documents?: FirestoreRestDoc[];
        nextPageToken?: string;
      };
      for (const docItem of body.documents ?? []) {
        results.push(docFromRest(docItem));
      }
      if (!body.nextPageToken) break;
      pageToken = body.nextPageToken;
    }
    return results;
  }

  async getDocument(
    collection: string,
    docId: string,
    bearerToken?: string
  ): Promise<Record<string, unknown> | null> {
    const adminDb = getAdminDb();
    if (adminDb) {
      const snap = await adminDb.collection(collection).doc(docId).get();
      return snap.exists ? (snap.data() as Record<string, unknown>) : null;
    }

    const url = `${FIRESTORE_BASE}/${encodeURIComponent(collection)}/${encodeURIComponent(docId)}`;
    const res = await restFetch(url, bearerToken, { method: 'GET' });
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Gagal membaca dokumen ${collection}/${docId} (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    const body = (await res.json()) as FirestoreRestDoc;
    return docFromRest(body).data;
  }

  async setDocument(
    collection: string,
    docId: string,
    data: Record<string, unknown>,
    bearerToken?: string
  ): Promise<void> {
    const adminDb = getAdminDb();
    if (adminDb) {
      await adminDb.collection(collection).doc(docId).set(data);
      return;
    }

    const url = `${FIRESTORE_BASE}/${encodeURIComponent(collection)}/${encodeURIComponent(docId)}`;
    const res = await restFetch(url, bearerToken, {
      method: 'PATCH',
      body: JSON.stringify(fieldsToRestBody(data)),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Gagal menulis dokumen ${collection}/${docId} (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
  }

  async deleteDocument(collection: string, docId: string, bearerToken?: string): Promise<void> {
    const adminDb = getAdminDb();
    if (adminDb) {
      await adminDb.collection(collection).doc(docId).delete();
      return;
    }

    const url = `${FIRESTORE_BASE}/${encodeURIComponent(collection)}/${encodeURIComponent(docId)}`;
    const res = await restFetch(url, bearerToken, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => '');
      throw new Error(`Gagal menghapus dokumen ${collection}/${docId} (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
  }

  async replaceCollection(
    collection: string,
    docs: StoredDocEntry[],
    bearerToken?: string
  ): Promise<number> {
    const existing = await this.listCollection(collection, bearerToken);
    const targetIds = new Set(docs.map((d) => d.id));
    const toDelete = existing.filter((e) => !targetIds.has(e.id));

    const adminDb = getAdminDb();
    if (adminDb) {
      const BATCH_LIMIT = 400;
      for (let i = 0; i < docs.length; i += BATCH_LIMIT) {
        const chunk = docs.slice(i, i + BATCH_LIMIT);
        const batch = adminDb.batch();
        for (const item of chunk) {
          batch.set(adminDb.collection(collection).doc(item.id), item.data);
        }
        await batch.commit();
      }
      for (let i = 0; i < toDelete.length; i += BATCH_LIMIT) {
        const chunk = toDelete.slice(i, i + BATCH_LIMIT);
        const batch = adminDb.batch();
        for (const item of chunk) {
          batch.delete(adminDb.collection(collection).doc(item.id));
        }
        await batch.commit();
      }
      return docs.length;
    }

    // REST batch execution with controlled concurrency
    const CONCURRENCY = 8;
    for (let i = 0; i < docs.length; i += CONCURRENCY) {
      const chunk = docs.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map((item) => this.setDocument(collection, item.id, item.data, bearerToken))
      );
    }
    for (let i = 0; i < toDelete.length; i += CONCURRENCY) {
      const chunk = toDelete.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map((item) => this.deleteDocument(collection, item.id, bearerToken))
      );
    }
    return docs.length;
  }
}

export const defaultFirestoreDataStore = new FirestoreDualDataStore();
