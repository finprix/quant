import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = join(process.cwd(), "tests", "fixtures");
const load = (name) => JSON.parse(readFileSync(join(FIXTURES, name), "utf-8"));

// Report reads the active dataset from context; pin it to #121.
vi.mock("../src/context/DatasetContext.jsx", () => ({
  useDatasets: () => ({ activeId: 121, activeDataset: { id: 121 } }),
  DatasetProvider: ({ children }) => children,
}));

import ReportPage from "../src/pages/ReportPage.jsx";

function routeFor(url) {
  const u = new URL(url, "http://x");
  const path = u.pathname.replace(/^\/api/, "");
  if (path === "/datasets/121") return { name: "dataset.json" };
  if (path === "/datasets/121/fingerprint") return { name: "fingerprint.json" };
  if (path.startsWith("/datasets/121/analogues")) return { name: "analogues.json" };
  if (path.startsWith("/datasets/121/regimes")) return { name: "regimes.json" };
  if (path.startsWith("/datasets/121/intelligence"))
    return { name: "intelligence.json" };
  if (path.startsWith("/datasets/121/prices")) return { name: "prices.json" };
  throw new Error("unexpected fetch: " + url);
}

export function installFetchMock(overrides = {}) {
  global.fetch = vi.fn(async (url) => {
    let route;
    try {
      route = routeFor(url);
    } catch {
      return {
        ok: false,
        status: 404,
        json: async () => ({ detail: "not found: " + url }),
      };
    }
    const override = overrides[route.name];
    if (override === "404") {
      return { ok: false, status: 404, json: async () => ({ detail: "missing" }) };
    }
    if (override === "500") {
      return { ok: false, status: 500, json: async () => ({ detail: "boom" }) };
    }
    if (override && override.status) {
      return {
        ok: false,
        status: override.status,
        json: async () => ({ detail: override.detail ?? "error" }),
      };
    }
    if (override && override.payload) {
      return { ok: true, status: 200, json: async () => override.payload };
    }
    return {
      ok: true,
      status: 200,
      json: async () => load(route.name),
    };
  });
}

beforeEach(() => installFetchMock());

describe("ReportPage — dataset #121 realistic payloads", () => {
  it("renders every section without crashing", async () => {
    render(<ReportPage />);
    await waitFor(
      () => expect(screen.getByText(/A — EXECUTIVE SUMMARY/i)).toBeTruthy(),
      { timeout: 4000 },
    );
    for (const title of [
      /B — CURRENT MARKET STATE/i,
      /C — STATISTICAL FINGERPRINT/i,
      /D — REGIME ANALYSIS/i,
      /E — HISTORICAL ANALOGUES/i,
      /F — COMPOSITE EVIDENCE DECOMPOSITION/i,
      /G — METHODOLOGY & DISCLAIMERS/i,
    ]) {
      expect(screen.getAllByText(title).length).toBeGreaterThan(0);
    }
  });

  it("drawdown overlay toggle does not crash", async () => {
    const user = userEvent.setup();
    render(<ReportPage />);
    await waitFor(() => screen.getByText(/C — STATISTICAL FINGERPRINT/i), {
      timeout: 4000,
    });
    const checkbox = await waitFor(() => {
      const el = screen.queryByRole("checkbox");
      expect(el).toBeTruthy();
      return el;
    });
    await user.click(checkbox);
    expect(checkbox.checked).toBe(true);
  });
});

describe("ReportPage — degenerate payloads must never crash", () => {
  const cases = [
    ["fingerprint missing", { "fingerprint.json": "404" }],
    ["regimes unavailable shape", {
      "regimes.json": { payload: { available: false, message: "INSUFFICIENT DATA" } },
    }],
    ["no analogues", { "analogues.json": { payload: { lookback: 60, candidates_evaluated: 0, analogues: [] } } }],
    ["prices empty", { "prices.json": { payload: { dataset_id: 121, count: 0, prices: [] } } }],
    ["intelligence error but cached data absent", { "intelligence.json": "500" }],
    ["everything empty-ish", {
      "fingerprint.json": "404",
      "regimes.json": { payload: { available: false } },
      "analogues.json": { payload: { analogues: [] } },
      "prices.json": { payload: { count: 0, prices: [] } },
    }],
  ];

  for (const [label, overrides] of cases) {
    it(`survives: ${label}`, async () => {
      installFetchMock(overrides);
      render(<ReportPage />);
      // Either the full report or the graceful error state must appear.
      await waitFor(
        () => {
          const ok =
            screen.queryAllByText(/A — EXECUTIVE SUMMARY/i).length > 0 ||
            screen.queryAllByText(/REQUEST FAILED/i).length > 0 ||
            screen.queryAllByText(/COMPILING RESEARCH REPORT/i).length > 0;
          expect(ok).toBe(true);
        },
        { timeout: 4000 },
      );
    });
  }

  it("renders null-heavy intelligence payload without crashing", async () => {
    installFetchMock({
      "intelligence.json": {
        payload: {
          scorecard: {},
          evidence: {},
          current_state: {},
          analogue_consensus: {},
          contradictions: [],
          disclaimers: [],
          summary: null,
        },
      },
    });
    render(<ReportPage />);
    await waitFor(() => screen.getByText(/A — EXECUTIVE SUMMARY/i), {
      timeout: 4000,
    });
    expect(screen.queryByText(/REQUEST FAILED/i)).toBeFalsy();
  });
});
