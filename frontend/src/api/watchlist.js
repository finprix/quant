import { request } from "./client.js";

export function getWatchlist() {
  return request("/watchlist");
}

export function addToWatchlist(symbol, note) {
  return request("/watchlist", {
    method: "POST",
    body: note ? { symbol, note } : { symbol },
  });
}

export function removeFromWatchlist(symbol) {
  return request(`/watchlist/${encodeURIComponent(symbol.toUpperCase())}`, {
    method: "DELETE",
  });
}
