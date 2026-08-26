import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../src/App.jsx";
import { AuthProvider } from "../src/context/AuthContext.jsx";
import { DatasetProvider } from "../src/context/DatasetContext.jsx";

/*
 * v0.20.0 public-access contract:
 * - "/" opens the FINPRIX global command center with no login of any kind
 * - Finprix branding renders; Quant Vector branding is gone
 * - every navbar entry stays interactive (no disabled grey menus)
 * - market cards are real links to asset overviews
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
    return jsonResponse({ authenticated: false, role: null });
  if (p === "/health") return jsonResponse({ status: "ok" });
  if (p === "/ai/status") return jsonResponse({ available: false });
  if (p === "/datasets") return jsonResponse({ datasets: [] });
  if (p === "/market/global")
    return jsonResponse({
      quotes: [
        { symbol: "^GSPC", label: "S&P 500", group: "index", region: "US",
          quote: { price: 5000, previous_close: 4999, change: 1,
                   change_percent: 0.7, volume: 1000 }, error: null },
        { symbol: "^IXIC", label: "NASDAQ", group: "index", region: "US",
          quote: { price: 16000, previous_close: 15999, change: 1,
                   change_percent: 1.1, volume: 1000 }, error: null },
        { symbol: "^VIX", label: "VIX", group: "index", region: "US",
          quote: { price: 13.2, previous_close: 13.5, change: -0.3,
                   change_percent: -2.4, volume: null }, error: null },
      ],
      as_of: "2026-08-26T12:00:00Z",
    });
  if (p === "/market/movers")
    return jsonResponse({
      gainers: [
        { symbol: "NVDA", label: "NVDA", group: "us", region: "US",
          quote: { price: 213.05, change_percent: 2.04, volume: 1000 },
          error: null },
      ],
      losers: [],
      active: [],
      as_of: "now",
    });
  if (p === "/sectors")
    return jsonResponse({
      sectors: [
        { symbol: "XLK", label: "TECHNOLOGY", ret_1d: 1.2, ret_5d: 3.1, ret_1m: null },
      ],
    });
  if (p.startsWith("/market/news"))
    return jsonResponse({ category: "latest", items: [], trending: [], as_of: "now" });
  return jsonResponse({ detail: "nf " + p }, 404);
}

beforeEach(() => {
  window.localStorage.clear();
  global.fetch = vi.fn(async (url) => route(String(url)));
});

const mountApp = (path = "/") =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={[path]}>
        <DatasetProvider>
          <App />
        </DatasetProvider>
      </MemoryRouter>
    </AuthProvider>,
  );

describe("Public access — no authentication wall", () => {
  it("opens the command center directly with zero datasets", async () => {
    mountApp("/");
    expect(
      await screen.findByText(/GLOBAL MARKET COMMAND CENTER/i),
    ).toBeTruthy();
    expect((await screen.findAllByText(/^S&P 500$/i)).length).toBeGreaterThan(0);
  });

  it("renders Finprix branding and never a login/guest flow", async () => {
    mountApp("/");
    await screen.findByText(/GLOBAL MARKET COMMAND CENTER/i);
    expect(screen.getAllByLabelText("FINPRIX").length).toBeGreaterThan(0);
    expect(screen.queryByText(/continue as guest/i)).toBeNull();
    expect(screen.queryByText(/developer login/i)).toBeNull();
    expect(screen.queryByText(/log out/i)).toBeNull();
    expect(screen.queryByText(/unlock developer access/i)).toBeNull();
  });

  it("shows no Quant Vector branding in the shell", async () => {
    const { container } = mountApp("/");
    await screen.findByText(/GLOBAL MARKET COMMAND CENTER/i);
    expect(container.textContent).not.toMatch(/quant vector/i);
  });

  it("navbar entries are interactive and navigate", async () => {
    const { userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    mountApp("/");
    await screen.findByText(/GLOBAL MARKET COMMAND CENTER/i);

    await user.click(screen.getByRole("link", { name: /^NEWS$/ }));
    expect(await screen.findByText(/Market News/i)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /^DATA/i }));
    await user.click(await screen.findByRole("link", { name: /Watchlists/i }));
    expect(await screen.findByText(/Watchlists/i)).toBeTruthy();
  });

  it("global market cards are clickable market objects", async () => {
    mountApp("/");
    await screen.findByText(/GLOBAL MARKET COMMAND CENTER/i);
    const nasdaq = (await screen.findAllByText(/^NASDAQ$/i))[0].closest("a");
    expect(nasdaq.getAttribute("href")).toBe(
      `/market/${encodeURIComponent("^IXIC")}`,
    );
  });
});
