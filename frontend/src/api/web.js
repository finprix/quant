import { request } from "./client.js";

/** Web-first market endpoints (v0.20.0) — public, symbol-first. */

export function getGlobalBoard() {
  return request("/market/global");
}

export function getMovers() {
  return request("/market/movers");
}

export function getSectors() {
  return request("/sectors");
}

export function getAssetBootstrap(symbol) {
  return request(`/asset/${encodeURIComponent(String(symbol || "").trim())}`);
}

export function getNewsFeed({ category = "latest", symbols } = {}) {
  const params = new URLSearchParams();
  if (category) params.set("category", category);
  if (symbols && symbols.length) params.set("symbols", symbols.join(","));
  const qs = params.toString();
  return request(`/market/news${qs ? `?${qs}` : ""}`);
}
