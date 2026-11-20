import type { PullRequestSummary } from "../../../ts-server/shared/pullRequests.js";

const DB_NAME = "ads-pull-request-cache";
const DB_VERSION = 1;
const STORE_NAME = "first-pages";
const DEFAULT_MAX_ENTRIES = 20;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type PullRequestCacheFilters = {
  state: string;
  involvement: string;
  labels: string[];
  author: string;
  checks: string;
};

export type PullRequestFirstPageRecord = {
  key: string;
  projectId: string;
  filters: PullRequestCacheFilters;
  items: PullRequestSummary[];
  fetchedAt: number;
  storedAt: number;
  bytes: number;
};

export interface PullRequestCacheStore {
  get(key: string): Promise<PullRequestFirstPageRecord | null>;
  put(record: PullRequestFirstPageRecord): Promise<void>;
  list(): Promise<PullRequestFirstPageRecord[]>;
  delete(keys: string[]): Promise<void>;
}

export type PullRequestFirstPageCache = {
  load(projectId: string, filters: PullRequestCacheFilters): Promise<PullRequestFirstPageRecord | null>;
  save(projectId: string, filters: PullRequestCacheFilters, items: PullRequestSummary[], fetchedAt: number): Promise<void>;
  clearProject(projectId: string): Promise<void>;
};

function normalizeFilters(filters: PullRequestCacheFilters): PullRequestCacheFilters {
  return {
    state: String(filters.state ?? "open").trim() || "open",
    involvement: String(filters.involvement ?? "all").trim() || "all",
    labels: [...new Set(filters.labels.map((label) => String(label ?? "").trim()).filter(Boolean))].sort(),
    author: String(filters.author ?? "").trim(),
    checks: String(filters.checks ?? "all").trim() || "all",
  };
}

export function pullRequestCacheKey(projectId: string, filters: PullRequestCacheFilters): string {
  const project = String(projectId ?? "").trim();
  if (!project) throw new Error("projectId is required");
  return JSON.stringify([project, normalizeFilters(filters)]);
}

function encodeSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function createPullRequestFirstPageCache(options: {
  store: PullRequestCacheStore;
  now?: () => number;
  maxEntries?: number;
  maxBytes?: number;
  maxAgeMs?: number;
}): PullRequestFirstPageCache {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;

  async function evict(): Promise<void> {
    const timestamp = now();
    const records = await options.store.list();
    const expired = records.filter((record) => timestamp - record.storedAt > maxAgeMs).map((record) => record.key);
    if (expired.length) await options.store.delete(expired);
    const retained = records
      .filter((record) => !expired.includes(record.key))
      .sort((left, right) => right.storedAt - left.storedAt);
    const evicted: string[] = [];
    let totalBytes = 0;
    for (let index = 0; index < retained.length; index += 1) {
      const record = retained[index]!;
      totalBytes += record.bytes;
      if (index >= maxEntries || totalBytes > maxBytes) evicted.push(record.key);
    }
    if (evicted.length) await options.store.delete(evicted);
  }

  return {
    async load(projectId, filters) {
      const key = pullRequestCacheKey(projectId, filters);
      const record = await options.store.get(key);
      if (!record) return null;
      if (now() - record.storedAt > maxAgeMs) {
        await options.store.delete([key]);
        return null;
      }
      return record;
    },
    async save(projectId, filters, items, fetchedAt) {
      const key = pullRequestCacheKey(projectId, filters);
      const normalizedFilters = normalizeFilters(filters);
      const bytes = encodeSize({ items, fetchedAt });
      if (bytes > maxBytes) {
        await options.store.delete([key]);
        return;
      }
      await options.store.put({
        key,
        projectId: String(projectId).trim(),
        filters: normalizedFilters,
        items,
        fetchedAt,
        storedAt: now(),
        bytes,
      });
      await evict();
    },
    async clearProject(projectId) {
      const project = String(projectId ?? "").trim();
      if (!project) return;
      const records = await options.store.list();
      const keys = records.filter((record) => record.projectId === project).map((record) => record.key);
      if (keys.length) await options.store.delete(keys);
    },
  };
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open pull request cache"));
  });
}

export function createIndexedDbPullRequestCacheStore(factory: IDBFactory = globalThis.indexedDB): PullRequestCacheStore {
  if (!factory) throw new Error("IndexedDB is unavailable");
  return {
    async get(key) {
      const db = await openDatabase(factory);
      try {
        return await requestToPromise(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key)) ?? null;
      } finally {
        db.close();
      }
    },
    async put(record) {
      const db = await openDatabase(factory);
      try {
        const transaction = db.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).put(record);
        await new Promise<void>((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error ?? new Error("Unable to save pull request cache"));
        });
      } finally {
        db.close();
      }
    },
    async list() {
      const db = await openDatabase(factory);
      try {
        return await requestToPromise(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll()) ?? [];
      } finally {
        db.close();
      }
    },
    async delete(keys) {
      if (!keys.length) return;
      const db = await openDatabase(factory);
      try {
        const transaction = db.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        for (const key of keys) store.delete(key);
        await new Promise<void>((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error ?? new Error("Unable to evict pull request cache"));
        });
      } finally {
        db.close();
      }
    },
  };
}

let defaultCache: PullRequestFirstPageCache | null = null;

export function getPullRequestFirstPageCache(): PullRequestFirstPageCache | null {
  if (defaultCache) return defaultCache;
  try {
    defaultCache = createPullRequestFirstPageCache({ store: createIndexedDbPullRequestCacheStore() });
    return defaultCache;
  } catch {
    return null;
  }
}
