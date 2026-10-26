import { startTransition, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { currentLiveVersion, useLiveVersion } from "./live";

interface CacheEntry {
  data: unknown;
  updatedAt: number;
  version: number;
}

interface CacheBucket {
  entries: Map<string, CacheEntry>;
  limit: number;
}

interface Inflight {
  promise: Promise<unknown>;
  controller: AbortController;
  /** Queries waiting on this request. */
  waiters: number;
}

/** Handed to every fetcher. */
export interface QueryFetchContext {
  /** Aborted once no query waits for this request any more. */
  signal: AbortSignal;
}

export type QueryFetcher<T> = (context: QueryFetchContext) => Promise<T>;

const defaultBucket: CacheBucket = { entries: new Map(), limit: 128 };
/** Full session traces: MBs each, at most a few worth keeping. */
const traceBucket: CacheBucket = { entries: new Map(), limit: 4 };
/** Request detail payloads (full prompts and responses). */
const requestBucket: CacheBucket = { entries: new Map(), limit: 16 };

const inflight = new Map<string, Inflight>();

const LIVE_REFETCH_THROTTLE_MS = 1500;

function bucketFor(key: string): CacheBucket {
  if (key.startsWith('["trace"')) return traceBucket;
  if (key.startsWith('["request"')) return requestBucket;
  return defaultBucket;
}

function cachedEntry(key: string): CacheEntry | undefined {
  return bucketFor(key).entries.get(key);
}

function remember(key: string, entry: CacheEntry): void {
  const { entries, limit } = bucketFor(key);
  entries.delete(key);
  entries.set(key, entry);
  if (entries.size > limit) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
}

/** Fetch into the cache, sharing one request among callers of the same key. */
function load<T>(key: string, version: number, fetcher: QueryFetcher<T>): Inflight {
  const pending = inflight.get(key);
  if (pending) {
    pending.waiters++;
    return pending;
  }
  const controller = new AbortController();
  const request: Inflight = {
    promise: fetcher({ signal: controller.signal })
      .then(data => {
        remember(key, { data, updatedAt: Date.now(), version });
        return data;
      })
      .finally(() => {
        if (inflight.get(key) === request) inflight.delete(key);
      }),
    controller,
    waiters: 1,
  };
  inflight.set(key, request);
  return request;
}

/** Drop one waiter; the last one out aborts the request. */
function release(key: string, request: Inflight): void {
  request.waiters--;
  if (request.waiters > 0) return;
  if (inflight.get(key) === request) inflight.delete(key);
  request.controller.abort();
}

export interface QueryOptions {
  /** Only enabled queries fetch; hidden (kept-alive) pages pass `false`. Default true. */
  enabled?: boolean;
  /** Additionally refetch on this interval while enabled and the tab is visible. */
  pollMs?: number;
}

export interface QueryResult<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  stale: boolean;
  refreshing: boolean;
  updatedAt: number | null;
  refetch: () => void;
}

export function useQuery<T>(
  key: readonly unknown[],
  fetcher: QueryFetcher<T>,
  options?: QueryOptions,
): QueryResult<T> {
  const keyString = JSON.stringify(key);
  const enabled = options?.enabled ?? true;
  const pollMs = options?.pollMs;
  const version = useLiveVersion(enabled);

  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [error, setError] = useState<{ key: string; error: Error } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const keyRef = useRef(keyString);
  keyRef.current = keyString;
  const lastShown = useRef<{ key: string; data: unknown; updatedAt: number } | null>(null);
  const lastFetchAt = useRef(0);
  /** The request this query currently waits on. */
  const waiting = useRef<{ key: string; request: Inflight } | null>(null);

  const run = useCallback((targetKey: string) => {
    lastFetchAt.current = Date.now();
    const current = waiting.current;
    if (current?.key === targetKey && inflight.get(targetKey) === current.request) return;
    const shownBefore = cachedEntry(targetKey)?.data;
    setRefreshing(true);
    const request = load(targetKey, currentLiveVersion(), fetcherRef.current);
    waiting.current = { key: targetKey, request };
    // Join the new request before leaving the old one, so a shared request isn't aborted in between.
    if (current) release(current.key, current.request);
    request.promise
      .then(data => {
        if (keyRef.current !== targetKey) return;
        // Revalidated to the very same object: nothing on screen changes.
        if (data === shownBefore) {
          setError(prev => (prev === null ? prev : null));
          return;
        }
        startTransition(() => {
          setError(null);
          rerender();
        });
      })
      .catch((err: unknown) => {
        if (keyRef.current !== targetKey || request.controller.signal.aborted) return;
        setError({ key: targetKey, error: err instanceof Error ? err : new Error(String(err)) });
      })
      .finally(() => {
        if (waiting.current?.request === request) waiting.current = null;
        if (keyRef.current === targetKey) setRefreshing(false);
      });
  }, []);

  /** Stop waiting so an abandoned multi-MB fetch can be aborted. */
  const leave = useCallback(() => {
    const current = waiting.current;
    waiting.current = null;
    if (current) release(current.key, current.request);
  }, []);

  // Unmounting, disabling, or switching keys abandons the current request.
  useEffect(() => leave, [leave]);

  useEffect(() => {
    // A key change abandons the previous key's request.
    if (!enabled || (waiting.current && waiting.current.key !== keyString)) leave();
    if (!enabled) return;
    const entry = cachedEntry(keyString);
    if (entry && entry.version >= version) return;
    const wait = entry ? lastFetchAt.current + LIVE_REFETCH_THROTTLE_MS - Date.now() : 0;
    if (wait <= 0) {
      run(keyString);
      return;
    }
    const timer = setTimeout(() => run(keyString), wait);
    return () => clearTimeout(timer);
  }, [keyString, enabled, version, run, leave]);

  useEffect(() => {
    if (!enabled || !pollMs) return;
    const interval = setInterval(() => {
      if (!document.hidden) run(keyRef.current);
    }, pollMs);
    return () => clearInterval(interval);
  }, [enabled, pollMs, run]);

  const refetch = useCallback(() => run(keyRef.current), [run]);

  const entry = cachedEntry(keyString);
  if (entry) lastShown.current = { key: keyString, data: entry.data, updatedAt: entry.updatedAt };
  const shown = lastShown.current;
  const currentError = error?.key === keyString ? error.error : null;

  return {
    data: (shown?.data as T | undefined) ?? null,
    error: currentError,
    loading: !shown && !currentError,
    stale: !!shown && shown.key !== keyString,
    refreshing,
    updatedAt: shown?.updatedAt ?? null,
    refetch,
  };
}
