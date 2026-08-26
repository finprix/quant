import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import MarketsPage from "../src/pages/MarketsPage.jsx";
import { AuthProvider } from "../src/context/AuthContext.jsx";
import { DatasetProvider } from "../src/context/DatasetContext.jsx";

/* v0.20.0: Markets is the discovery hub — global boards + movers, no auth. */

function jsonResponse(payload, status = 200) {
  return {
    ok: status < 400,
    status,
    headers: { get: () => "application/json" },
    json: async () => payload,
  };
}

function idx(symbol, label, price, pct) {
  return {
    symbol,
    label,
    group: "index",
    region: "US",
    quote: {
      price,
      previous_close: price - 1,
      change: 1,
      change_percent: pct,
      volume: 1000,
      as_of: "2026-08-26",
    },
    error: null,
  };
}

const boardPayload = {
  quotes: [
    idx("^GSPC", "S&P 500", 5000.5, 0.7),
    idx("^IXIC", "NASDAQ", 16000, -0.4),
  ],
  as_of: "2026-08-26T12:00:00Z",
};

function route(url) {
  const u = new URL(url, "http://x");
  const path = u.pathname.replace(/^\/api/, "");
  if (path === "/market/global") return jsonResponse(boardPayload);
  if (path === "/market/movers")
    return jsonResponse({
      gainers: [
        {
          symbol: "NVDA", label: "NVDA", group: "us", region: "US",
          quote: { price: 311.2, change_percent: 0.52, volume: 42_000_000 },
          error: null,
        },
      ],
      losers: [
        {
          symbol: "TSLA", label: "TSLA", group: "us", region: "US",
          quote: { price: 210.1, change_percent: -1.3, volume: 30_000_000 },
          error: null,
        },
      ],
      active: [],
      as_of: "2026-08-26T12:00:00Z",
    });
  if (path === "/sectors")
    return jsonResponse({
      sectors: [
        { symbol: "XLK", label: "TECHNOLOGY", ret_1d: 1.84, ret_5d: 4.21, ret_1m: null },
      ],
    });
  if (path === "/datasets") return jsonResponse({ datasets: [] });
  if (path.startsWith("/market/news"))
    return jsonResponse({
      category: "latest",
      items: [
        {
          title: "Markets rally on strong earnings",
          link: "https://example.com/a",
          publisher: "Example Wire",
          published: "2026-08-26T10:00:00Z",
          related_symbol: "^GSPC",
        },
      ],
      trending: [{ symbol: "^GSPC", stories: 1 }],
      as_of: "now",
    });
  return jsonResponse({ detail: "not found: " + path }, 404);
}

beforeEach(() => {
  window.localStorage.clear();
  global.fetch = vi.fn(async (url, options = {}) => route(url));
});

const mount = () =>
  render(
    <AuthProvider>
      <MemoryRouter>
        <DatasetProvider>
          <MarketsPage />
        </DatasetProvider>
      </MemoryRouter>
    </AuthProvider>,
  );

describe("Markets discovery hub (v0.20.0)", () => {
  it("renders global index cards with real quotes", async () => {
    mount();
    expect(await screen.findByText("5,000.5")).toBeTruthy();
    expect(screen.getAllByText("S&P 500").length).toBeGreaterThan(0);
  });

  it("renders movers with clickable symbols and tabs", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText("311.20");
    const nvdaLink = screen.getByRole("link", { name: /^NVDA$/ });
    expect(nvdaLink.getAttribute("href")).toBe("/market/NVDA");
    // region tabs stay interactive
    await user.click(screen.getByRole("button", { name: /^INDIA$/ }));
    expect(screen.getByText(/No mover data/i)).toBeTruthy();
  });

  it("renders aggregated news with trending symbols", async () => {
    mount();
    expect(
      await screen.findByText(/Markets rally on strong earnings/i),
    ).toBeTruthy();
    const gspcLinks = screen.getAllByRole("link", { name: /GSPC/i });
    const routed = gspcLinks.some(
      (l) => l.getAttribute("href") === `/market/${encodeURIComponent("^GSPC")}`,
    );
    expect(routed).toBe(true);
  });

  it("degrades gracefully when the provider fails", async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse({ detail: "provider down" }, 502),
    );
    mount();
    expect(await screen.findByText(/provider down|unavailable/i)).toBeTruthy();
  });
});
