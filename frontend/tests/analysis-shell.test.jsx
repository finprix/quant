import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../src/App.jsx";
import { AuthProvider } from "../src/context/AuthContext.jsx";
import { DatasetProvider } from "../src/context/DatasetContext.jsx";

/*
 * v0.19.0 shell contract:
 * - legacy deep links (/fingerprint?dataset=N) redirect into /analysis/* preserving context
 * - tab navigation keeps ?dataset=N so switching views never loses the dataset
 * - the asset context bar renders exclusively inside analysis routes
 */

function jsonResponse(payload, status = 200) {
  return {
    ok: status < 400,
    status,
    headers: { get: () => "application/json" },
    json: async () => payload,
  };
}

function route(url) {
  const u = new URL(url, "http://x");
  const p = u.pathname.replace(/^\/api/, "");
  if (p === "/auth/session")
    return jsonResponse({ authenticated: true, role: "developer" });
  if (p === "/health") return jsonResponse({ status: "ok" });
  if (p === "/ai/status") return jsonResponse({ available: false });
  if (p === "/datasets")
    return jsonResponse({
      datasets: [
        {
          id: 166,
          filename: "AAPL — Yahoo Finance",
          start_date: "2020-01-01",
          end_date: "2026-08-21",
          row_count: 1657,
        },
      ],
    });
  if (p === "/datasets/166")
    return jsonResponse({ id: 166, filename: "AAPL", row_count: 1657 });
  if (p === "/datasets/166/prices") return jsonResponse({ prices: [] });
  if (p === "/datasets/166/fingerprint")
    return jsonResponse({ samples_used: 1596, cached: false, fingerprint: {} });
  if (p.startsWith("/datasets/166/regimes"))
    return jsonResponse({
      available: true,
      current_regime: { regime_id: 1 },
      regimes: [],
      timeline: [],
      model: { selected_k: 3 },
      meta: { cached: false },
    });
  if (p.startsWith("/datasets/166/analogues"))
    return jsonResponse({ analogues: [], candidates_evaluated: 12 });
  if (p.startsWith("/market/quote/"))
    return jsonResponse({ price: "250.00", change_percent: 0.52 });
  if (p === "/watchlist")
    return jsonResponse({
      symbols: [
        { symbol: "AAPL", added_at: "2026-08-20T00:00:00", quote: { price: "250.00", change_percent: 0.52 }, source: { provider: "yahoo" } },
      ],
    });
  if (p.startsWith("/market/news"))
    return jsonResponse({ items: [] });
  return jsonResponse({ detail: "not found: " + p }, 404);
}

beforeEach(() => {
  window.localStorage.clear();
  global.fetch = vi.fn(async (url, options = {}) => route(url));
});

const mountApp = (path) =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={[path]}>
        <DatasetProvider>
          <App />
        </DatasetProvider>
      </MemoryRouter>
    </AuthProvider>,
  );

describe("Analysis workspace shell", () => {
  it("legacy /fingerprint deep links redirect into the shell preserving dataset", async () => {
    mountApp("/fingerprint?dataset=166");
    expect(await screen.findByText(/STATISTICAL FINGERPRINT/i)).toBeTruthy();
    // asset identity lives in the shared context bar now
    expect(screen.getAllByText(/AAPL/).length).toBeGreaterThan(0);
    // sibling tabs carry the dataset forward
    const analoguesTab = screen.getByRole("link", { name: /^ANALOGUES$/i });
    expect(analoguesTab.getAttribute("href")).toBe(
      "/analysis/analogues?dataset=166",
    );
  });

  it("tab switches keep ?dataset= so context survives across views", async () => {
    mountApp("/analysis/regimes?dataset=166");
    expect(await screen.findByText(/REGIME ANALYSIS/i)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /^INTELLIGENCE$/i }).getAttribute("href"),
    ).toBe("/analysis/intelligence?dataset=166");
    expect(
      screen.getByRole("link", { name: /^HEATMAPS$/i }).getAttribute("href"),
    ).toBe("/analysis/heatmaps?dataset=166");
  });

  it("asset context bar is exclusive to analysis routes", async () => {
    const { container } = mountApp("/markets");
    await screen.findByText(/^SYMBOL$/i);
    expect(container.querySelector(".asset-bar")).toBeNull();
  });

  it("unknown analysis views fall back home instead of crashing", async () => {
    mountApp("/analysis/nonsense?dataset=166");
    // catch-all redirects to Overview (command center)
    expect(await screen.findByText(/COMMAND CENTER/i)).toBeTruthy();
  });
});
