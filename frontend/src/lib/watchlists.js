/**
 * Client-side watchlists (v0.20.0) — no account required.
 * Multiple named lists persisted in the browser. Symbols are uppercase
 * provider tickers so every entry is directly routable.
 */

const KEY = "finprix.watchlists.v1";

export function defaultWatchlists() {
  return [
    {
      id: "core",
      name: "MY LIST",
      symbols: ["^GSPC", "^IXIC", "^NSEI", "NVDA", "AAPL", "BTC-USD"],
    },
  ];
}

export function loadWatchlists() {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return defaultWatchlists();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return defaultWatchlists();
    }
    return parsed.map((l) => ({
      id: String(l.id),
      name: String(l.name || "LIST"),
      symbols: Array.isArray(l.symbols)
        ? [...new Set(l.symbols.map((s) => String(s).toUpperCase()))]
        : [],
    }));
  } catch {
    return defaultWatchlists();
  }
}

export function saveWatchlists(lists) {
  window.localStorage.setItem(KEY, JSON.stringify(lists));
}

export function addSymbol(lists, listId, symbol) {
  const up = String(symbol || "").trim().toUpperCase();
  if (!up) return lists;
  return lists.map((l) =>
    l.id === listId && !l.symbols.includes(up)
      ? { ...l, symbols: [...l.symbols, up] }
      : l,
  );
}

export function removeSymbol(lists, listId, symbol) {
  const up = String(symbol).toUpperCase();
  return lists.map((l) =>
    l.id === listId ? { ...l, symbols: l.symbols.filter((s) => s !== up) } : l,
  );
}

export function createList(lists, name) {
  const clean = String(name || "").trim().toUpperCase().slice(0, 24);
  if (!clean) return lists;
  const id = `l${Date.now().toString(36)}`;
  return [...lists, { id, name: clean, symbols: [] }];
}

export function deleteList(lists, listId) {
  const next = lists.filter((l) => l.id !== listId);
  return next.length ? next : defaultWatchlists();
}

export function moveSymbol(lists, listId, index, direction) {
  return lists.map((l) => {
    if (l.id !== listId) return l;
    const target = index + direction;
    if (target < 0 || target >= l.symbols.length) return l;
    const symbols = [...l.symbols];
    [symbols[index], symbols[target]] = [symbols[target], symbols[index]];
    return { ...l, symbols };
  });
}
