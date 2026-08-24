import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { DatasetProvider } from "../src/context/DatasetContext.jsx";
import { AuthProvider } from "../src/context/AuthContext.jsx";
import MarketsPage from "../src/pages/MarketsPage.jsx";

const watchlistPayload = {
  symbols: [
    {
      id: 1,
      symbol: "AAPL",
      note: null,
      added_at: "2026-08-25T10:00:00Z",
      quote: {
        symbol: "AAPL", price: 311.2, previous_close: 309.6, change: 1.6,
        change_percent: 0.52, currency: "USD", source: "yahoo",
        as_of: "2026-08-25T12:00:00Z", dataset_id: 166,
      },
    },
    {
      id: 2,
      symbol: "TSLA",
      note: null,
      added_at: "2026-08-25T10:05:00Z",
      quote: {
        symbol: "TSLA", price: 240.1, previous_close: 244.0, change: -3.9,
        change_percent: -1.6, currency: "USD", source: "yahoo",
        as_of: "2026-08-25T12:00:00Z",
      },
    },
  ],
};
watchlistPayload.gainers = [watchlistRow("AAPL")];
watchlistPayload.losers = [watchlistRow("TSLA")];

function watchlistRow(symbol) {
  return watchlistPayload.symbols.find((s) => s.symbol === symbol);
}

let sessionDeveloper = true;

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const route = (path, init = {}) => {
  if (path === "/auth/session") {
    return sessionDeveloper
      ? jsonResponse({ authenticated: true, role: "developer" })
      : jsonResponse({ authenticated: false, role: null });
  }
  if (path === "/health") return jsonResponse({ status: "ok" });
  if (path === "/datasets") {
    return jsonResponse({
      datasets: [{ id: 166, filename: "AAPL_1d.csv" }],
    });
  }
  if (path === "/watchlist") {
    if ((init.method || "GET") === "GET") return jsonResponse(watchlistPayload);
    return jsonResponse({ added: true, entry: { symbol: "NVDA" } });
  }
  if (path.startsWith("/watchlist/")) {
    return jsonResponse({ removed: true });
  }
  return jsonResponse({ detail: "not found" }, 404);
};

const mountPage = () =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={["/markets"]}>
        <DatasetProvider>
          <MarketsPage />
        </DatasetProvider>
      </MemoryRouter>
    </AuthProvider>,
  );

beforeEach(() => {
  window.localStorage.setItem("market-dna.active-dataset-id", "166");
  sessionDeveloper = true;
  vi.stubGlobal(
    "fetch",
    vi.fn((input, init) => {
      const url = typeof input === "string" ? input : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
      return Promise.resolve(route(path.replace(/^\/api/, ""), init ?? {}));
    }),
  );
});

describe("Markets page (Finprix-inspired)", () => {
  it("renders gainers/losers cards and the live watch table", async () => {
    mountPage();
    expect(await screen.findByText("TOP GAINERS")).toBeTruthy();
    expect(screen.getByText("TOP LOSERS")).toBeTruthy();
    expect(await screen.findByText(/updated/i)).toBeTruthy();

    await waitFor(() => {
      const cells = screen.getAllByText("AAPL");
      expect(cells.length).toBeGreaterThan(0);
      const tableCell = cells.map((el) => el.closest("tr")).find(Boolean);
      expect(tableCell).toBeTruthy();
    });
    const row = screen
      .getAllByText("AAPL")
      .map((el) => el.closest("tr"))
      .find(Boolean);
    expect(row.textContent).toContain("311.2");
    expect(row.textContent).toContain("+0.52%");
    expect(row.textContent).toContain("ANALYZE");
  });

  it("hides mutations from guests but keeps the table readable", async () => {
    sessionDeveloper = false;
    mountPage();
    await waitFor(() => expect(screen.getByText("WATCHLIST")).toBeTruthy());
    const trackButton = screen.queryByRole("button", { name: /track/i });
    expect(trackButton === null || trackButton.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
    expect(await screen.findAllByText("AAPL").then((els) => els.length > 0)).toBe(true);
  });

  it("adds a tracked symbol as developer and refreshes", async () => {
    const user = userEvent.setup();
    let addedSymbol = null;
    vi.stubGlobal(
      "fetch",
      vi.fn((input, init) => {
        const url = typeof input === "string" ? input : input.url;
        const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]
          .replace(/^\/api/, "");
        if (path === "/watchlist" && init?.method === "POST") {
          addedSymbol = JSON.parse(init.body).symbol;
          watchlistPayload.symbols.push({
            ...watchlistRow("AAPL"),
            id: 3,
            symbol: addedSymbol,
          });
          return Promise.resolve(
            jsonResponse({ added: true, entry: { symbol: addedSymbol } }),
          );
        }
        return Promise.resolve(route(path, init ?? {}));
      }),
    );
    mountPage();
    const input = await screen.findByPlaceholderText(/AAPL/i);
    await user.type(input, "NVDA");
    await user.click(screen.getByRole("button", { name: /track/i }));
    await waitFor(() => expect(addedSymbol).toBe("NVDA"));
  });
});
