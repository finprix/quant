import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import App from "../src/App.jsx";
import { AuthProvider } from "../src/context/AuthContext.jsx";
import { DatasetProvider } from "../src/context/DatasetContext.jsx";

/* Realistic payload envelopes; auth behaviour is configurable per test. */
let sessionResponse = { authenticated: false, role: null };
let loginOutcome = { status: 200, body: { authenticated: true, role: "developer" } };

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
  if (p === "/auth/session") return jsonResponse(sessionResponse);
  if (p === "/auth/login") return jsonResponse(loginOutcome.body, loginOutcome.status);
  if (p === "/auth/logout") return jsonResponse({ authenticated: false, role: null });
  if (p === "/health") return jsonResponse({ status: "ok" });
  if (p === "/ai/status") return jsonResponse({ available: false });
  if (p === "/database/status")
    return jsonResponse({ connected: true, database: "market_dna", latency_ms: 5, tables_count: 10 });
  if (p === "/database/stats") return jsonResponse({ datasets: 1, price_observations: 2, size_pretty: "1 KiB" });
  if (p === "/database/tables")
    return jsonResponse({
      tables: [{ name: "price_data", label: "OHLCV", category: "raw", rows: 2 }],
    });
  if (p === "/datasets")
    return jsonResponse({
      datasets: [
        {
          id: 166,
          filename: "AAPL — Yahoo Finance",
          start_date: "2026-05-28",
          end_date: "2026-08-21",
        },
      ],
    });
  if (p === "/datasets/166")
    return jsonResponse({ id: 166, filename: "AAPL", row_count: 2, latest_close: 1 });
  if (p.startsWith("/market/overview"))
    return jsonResponse({
      generated_at: "2026-08-24T00:00:00",
      instruments: [
        {
          dataset_id: 166,
          filename: "AAPL",
          source: { symbol: "AAPL", provider: "yahoo" },
        },
      ],
    });
  return jsonResponse({ detail: "not found: " + p }, 404);
}

beforeEach(() => {
  window.localStorage.clear();
  sessionResponse = { authenticated: false, role: null };
  loginOutcome = {
    status: 200,
    body: { authenticated: true, role: "developer" },
  };
  global.fetch = vi.fn(async (url, options = {}) => route(url));
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

describe("AccessGate — entry experience", () => {
  it("shows hero, capabilities and both access paths", async () => {
    mountApp("/");
    expect(await screen.findByText(/RESTRICTED QUANTITATIVE RESEARCH TERMINAL/i)).toBeTruthy();
    expect(screen.getAllByText(/STATISTICAL FINGERPRINTING/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/CONTINUE AS GUEST/i)).toBeTruthy();
    expect(screen.getByText(/DEVELOPER LOGIN/i)).toBeTruthy();
    // live status indicators present
    expect(screen.getAllByText(/MYSQL/i).length).toBeGreaterThan(0);
  });

  it("expands the developer login form on demand", async () => {
    const user = userEvent.setup();
    mountApp("/");
    await user.click(await screen.findByText(/DEVELOPER LOGIN/i));
    expect(await screen.findByText(/UNLOCK DEVELOPER ACCESS/i)).toBeTruthy();
  });

  it("invalid credentials surface a backend error without entering", async () => {
    const user = userEvent.setup();
    loginOutcome = { status: 401, body: { detail: "Invalid credentials." } };
    mountApp("/");
    await user.click(await screen.findByText(/DEVELOPER LOGIN/i));
    await user.type(screen.getByLabelText(/^DEVELOPER PIN/i), "0000");
    await user.click(screen.getByText(/UNLOCK DEVELOPER ACCESS/i));
    expect(await screen.findByText(/Invalid credentials\./i)).toBeTruthy();
    // still gated — the login form remains, the terminal did not open
    expect(screen.getByText(/UNLOCK DEVELOPER ACCESS/i)).toBeTruthy();
  });
});

describe("Guest mode", () => {
  it("enters immediately, badges GUEST ACCESS, locks dataset management", async () => {
    const user = userEvent.setup();
    mountApp("/");
    await user.click(await screen.findByText(/CONTINUE AS GUEST/i));
    expect(await screen.findByText(/GUEST ACCESS/i)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Data ▾/i }));
    await user.click(await screen.findByText("Datasets"));
    expect(await screen.findByText(/RESEARCH MODE — READ ONLY/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /upload csv/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /fetch market data/i })).toBeNull();
    expect(screen.getAllByText(/DEVELOPER ACCESS REQUIRED/i).length).toBeGreaterThan(0);
    // viewing stays available
    expect(screen.getAllByRole("button", { name: /view mysql data/i }).length).toBeGreaterThan(0);
  });

  it("guest choice persists across remount", async () => {
    const user = userEvent.setup();
    const { unmount } = mountApp("/");
    await user.click(await screen.findByText(/CONTINUE AS GUEST/i));
    await screen.findByText(/GUEST ACCESS/i);
    unmount();
    mountApp("/");
    expect(await screen.findByText(/GUEST ACCESS/i)).toBeTruthy();
  });
});

describe("Developer mode", () => {
  it("valid login unlocks dataset management controls", async () => {
    const user = userEvent.setup();
    mountApp("/");
    await user.click(await screen.findByText(/DEVELOPER LOGIN/i));
    await user.type(screen.getByLabelText(/^DEVELOPER PIN/i), "2729125");
    await user.click(screen.getByText(/UNLOCK DEVELOPER ACCESS/i));
    expect(await screen.findAllByText(/DEVELOPER/i)).toBeTruthy();
    expect(screen.getByText(/LOG OUT/i)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Data ▾/i }));
    await user.click(await screen.findByText("Datasets"));
    await screen.findByRole("button", { name: /upload csv/i });
    expect(screen.getByRole("button", { name: /fetch market data/i })).toBeTruthy();
  });

  it("valid developer cookie restores the session without the gate", async () => {
    sessionResponse = { authenticated: true, role: "developer" };
    mountApp("/datasets");
    expect(await screen.findByText(/LOG OUT/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /continue as guest/i })).toBeNull();
    await screen.findByRole("button", { name: /upload csv/i });
  });

  it("logout returns to the entry gate", async () => {
    const user = userEvent.setup();
    sessionResponse = { authenticated: true, role: "developer" };
    mountApp("/");
    await user.click(await screen.findByText(/LOG OUT/i));
    expect(await screen.findByText(/CONTINUE AS GUEST/i)).toBeTruthy();
  });
});
