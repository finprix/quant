import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, API_BASE_URL } from "../api/client.js";

const store = new Map();
const listeners = new Set();

// Lightweight TTL strategy: entries older than their category TTL are
// treated as misses (a refetch happens) while the previous payload stays
// visible until the new one lands. Mutations call invalidateCache().
const DEFAULT_TTL_MS = 30_000;
const TTL_RULES = [
  ["/comparison-presets", 30_000],
  ["/compare/correlation", 60_000],
  ["/compare/fingerprints", 60_000],
  ["/intelligence/summary", 30_000],
  ["/intelligence", 60_000],
  ["/regimes/current", 30_000],
  ["/regimes", 30_000],
  ["/analogues", 60_000],
  ["/fingerprint", 60_000],
  ["/prices", 60_000],
];

function ttlForPath(path) {
  for (const [needle, ttl] of TTL_RULES) {
    if (path.includes(needle)) return ttl;
  }
  return DEFAULT_TTL_MS;
}

function isFresh(entry) {
  return Boolean(entry && Date.now() < entry.expiresAt);
}

function notify(key) {
  for (const listener of listeners) listener(key);
}

export function invalidateCache(prefix) {
  for (const key of Array.from(store.keys())) {
    if (!prefix || key.startsWith(prefix)) {
      store.delete(key);
      notify(key);
    }
  }
}

export function readCache(key) {
  return store.get(key);
}

/**
 * Fetches `${API_BASE_URL}${path}` and caches the last good result per
 * cache key so switching pages does not refire identical requests.
 *
 * path must be a stable string beginning with "/" (null disables fetching).
 * Returns { data, error, loading, refetch }.
 */
export function useApiData(path, { enabled = true } = {}) {
  const key = path ? `${API_BASE_URL}${path}` : null;
  const cached = key ? store.get(key) : undefined;
  const [state, setState] = useState({
    data: cached ? cached.data : null,
    error: null,
    loading: Boolean(key) && enabled && !isFresh(cached),
    stale: !cached,
  });
  const runRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(
    async (force = false) => {
      if (!key || !enabled) {
        setState({ data: null, error: null, loading: false, stale: false });
        return;
      }
      if (!force) {
        const hit = store.get(key);
        if (isFresh(hit)) {
          setState({ data: hit.data, error: null, loading: false, stale: false });
          return;
        }
      }
      const run = ++runRef.current;
      setState((prev) => ({
        ...prev,
        data: force ? null : prev.data ?? store.get(key)?.data ?? null,
        error: null,
        loading: true,
      }));
      try {
        const response = await fetch(key);
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          const detail = payload?.detail;
          throw new ApiError(
            typeof detail === "string"
              ? detail
              : `Request failed with status ${response.status}`,
            response.status,
            payload,
          );
        }
        store.set(key, {
          data: payload,
          expiresAt: Date.now() + ttlForPath(path),
        });
        if (mountedRef.current && run === runRef.current) {
          setState({ data: payload, error: null, loading: false, stale: false });
        }
      } catch (error) {
        const apiError =
          error instanceof ApiError
            ? error
            : new ApiError("Backend unreachable. Verify the QUANT VECTOR API is running.", 0, null);
        if (mountedRef.current && run === runRef.current) {
          setState((prev) => ({
            data: prev.data,
            error: apiError,
            loading: false,
            stale: false,
          }));
        }
      }
    },
    [key, enabled],
  );

  useEffect(() => {
    load(false);
  }, [load]);

  useEffect(() => {
    const listener = (changedKey) => {
      if (changedKey === key) load(false);
    };
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, [key, load]);

  return { ...state, refetch: () => load(true) };
}

/**
 * Fetches many endpoints in parallel with Promise.all, reusing the shared
 * URL-keyed cache. Missing entries are fetched once and stored.
 *
 * paths: array of strings beginning with "/" (empty entries are ignored).
 * Returns { byPath: Map<path, data>, errors: Map<path, Error>, loading }.
 */
export function useParallelApiData(paths) {
  const signature = paths.filter(Boolean).join("|");
  const [state, setState] = useState({ byPath: new Map(), errors: new Map(), loading: true });
  const runRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!signature) {
      setState({ byPath: new Map(), errors: new Map(), loading: false });
      return undefined;
    }
    const activePaths = signature.split("|");
    const cached = new Map();
    const missing = [];
    for (const path of activePaths) {
      const key = `${API_BASE_URL}${path}`;
      const hit = store.get(key);
      if (isFresh(hit)) cached.set(path, hit.data);
      else missing.push(path);
    }

    if (missing.length === 0) {
      setState({ byPath: cached, errors: new Map(), loading: false });
      return undefined;
    }

    const run = ++runRef.current;
    setState((prev) => ({
      byPath: cached.size ? new Map([...prev.byPath, ...cached]) : cached,
      errors: new Map(),
      loading: true,
    }));

    (async () => {
      const results = await Promise.all(
        missing.map(async (path) => {
          try {
            const response = await fetch(`${API_BASE_URL}${path}`);
            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const detail = payload?.detail;
              throw new ApiError(
                typeof detail === "string"
                  ? detail
                  : `Request failed with status ${response.status}`,
                response.status,
                payload,
              );
            }
            store.set(`${API_BASE_URL}${path}`, {
              data: payload,
              expiresAt: Date.now() + ttlForPath(path),
            });
            return { path, data: payload, error: null };
          } catch (error) {
            const apiError =
              error instanceof ApiError
                ? error
                : new ApiError("Backend unreachable. Verify the QUANT VECTOR API is running.", 0, null);
            return { path, data: null, error: apiError };
          }
        }),
      );
      if (!mountedRef.current || run !== runRef.current) return;
      const byPath = new Map(cached);
      const errors = new Map();
      for (const result of results) {
        if (result.error) errors.set(result.path, result.error);
        else byPath.set(result.path, result.data);
      }
      setState({ byPath, errors, loading: false });
    })();
  }, [signature]);

  return state;
}
