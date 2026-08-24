import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DatasetProvider } from "../src/context/DatasetContext.jsx";
import { AuthProvider } from "../src/context/AuthContext.jsx";
import DatabasePage from "../src/pages/DatabasePage.jsx";

// Payload shapes mirror the live API exactly — including the
// { tables: [...] } envelope that once crashed the page.
const PAYLOADS = {
  "/database/status": {
    connected: true,
    database: "market_dna",
    server_version: "26.7.0-commercial",
    latency_ms: 31,
    tables_count: 10,
  },
  "/database/stats": {
    datasets: 2,
    market_imports: 1,
    csv_imports: 1,
    price_observations: 581,
    oldest_observation: "2022-01-03",
    newest_observation: "2026-08-21",
    size_bytes: 638976,
    size_pretty: "624.0 KiB",
    connected: true,
    database: "market_dna",
  },
  "/database/tables": {
    tables: [
      { name: "datasets", label: "Dataset registry", category: "raw", rows: 2 },
      { name: "price_data", label: "OHLCV observations", category: "raw", rows: 579 },
      { name: "dataset_sources", label: "Import provenance", category: "raw", rows: 1 },
      { name: "fingerprints", label: "Fingerprint cache", category: "cache", rows: 30 },
      { name: "regime_models", label: "Regime models", category: "cache", rows: 0 },
      { name: "comparison_presets", label: "Presets", category: "config", rows: 0 },
    ],
  },
  "/database/tables/price_data/schema": {
    table: "price_data",
    category: "raw",
    label: "OHLCV observations",
    columns: [
      { name: "id", type: "int", nullable: false, key: "PRI", default: null, extra: "" },
      { name: "dataset_id", type: "int", nullable: false, key: "MUL", default: null, extra: "" },
      { name: "date", type: "date", nullable: false, key: "UNI", default: null, extra: "" },
      { name: "open", type: "double", nullable: false, key: "", default: null, extra: "" },
    ],
    primary_key: ["id"],
    foreign_keys: [
      { name: "fk", column: "dataset_id", references_table: "datasets", references_column: "id" },
    ],
    unique_keys: [
      { name: "uq_price_data_dataset_date", columns: ["dataset_id", "date"] },
    ],
    indexes: [{ name: "uq_price_data_dataset_date", columns: ["dataset_id", "date"] }],
  },
  "/database/tables/price_data": {
    table: "price_data",
    category: "raw",
    columns: ["id", "dataset_id", "date", "open"],
    rows: [
      { id: 165, dataset_id: 166, date: "2026-08-21", open: 300.5 },
      { id: 164, dataset_id: 166, date: "2026-08-20", open: 299.1 },
    ],
    total: 65,
    limit: 100,
    offset: 0,
    order_by: null,
    order_dir: "asc",
    filters: {},
  },
  "/database/datasets/166/storage": {
    dataset_id: 166,
    filename: "AAPL — Yahoo Finance",
    start_date: "2026-05-28",
    end_date: "2026-08-21",
    row_count: 65,
    latest_close: 309.35,
    created_at: "2026-08-24T12:00:00",
    source: {
      provider: "yahoo",
      symbol: "AAPL",
      price_interval: "1d",
      last_updated: "2026-08-24T12:00:00",
    },
    counts: {
      datasets: 1,
      price_data: 65,
      dataset_sources: 1,
      analysis_results: 1,
      fingerprints: 30,
      analogue_matches: 10,
      regime_models: 0,
      regime_assignments: 0,
      intelligence_snapshots: 1,
    },
  },
};

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => payload,
  };
}

function route(url) {
  const u = new URL(url, "http://x");
  const p = u.pathname.replace(/^\/api/, "");
  for (const key of [
    "/database/tables/price_data/schema",
    "/database/tables/price_data",
    "/database/datasets/166/storage",
    "/database/status",
    "/database/stats",
    "/database/tables",
  ]) {
    if (p === key) return PAYLOADS[key];
  }
  // library sidebar fetch — GET /datasets answers { datasets: [...] }
  if (p === "/datasets") {
    return {
      datasets: [
        { id: 166, filename: "AAPL — Yahoo Finance", start_date: "2026-05-28", end_date: "2026-08-21" },
      ],
    };
  }
  throw new Error("unexpected fetch: " + url);
}

beforeEach(() => {
  global.fetch = vi.fn(async (url) => jsonResponse(route(url)));
});

const wrap = (initial) =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={[initial]}>
        <DatasetProvider>
          <DatabasePage />
        </DatasetProvider>
      </MemoryRouter>
    </AuthProvider>,
  );

describe("DatabasePage", () => {
  it("renders status, stats and grouped table registry without crashing", async () => {
    wrap("/database");
    await waitFor(
      () => expect(screen.getAllByText(/MYSQL CONNECTED/i).length).toBeGreaterThan(0),
      { timeout: 4000 },
    );
    expect(screen.getAllByText(/DATASET INSPECTOR/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/#166/).length).toBeGreaterThan(0);
    // grouped registry shows raw + cache + config entries
    expect(screen.getAllByText(/^RAW \/ SOURCE DATA$/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^ANALYSIS \/ CACHE DATA$/).length).toBeGreaterThan(0);
  });

  it("deep link ?table=price_data&dataset_id=166 opens a filtered viewer", async () => {
    wrap("/database?table=price_data&dataset_id=166");
    await waitFor(
      () => expect(screen.getAllByText(/TABLE — PRICE_DATA/i).length).toBeGreaterThan(0),
      { timeout: 4000 },
    );
    await waitFor(() => expect(screen.queryAllByText(/QUERYING MYSQL/i).length).toBe(0), {
      timeout: 4000,
    });
    expect(screen.getAllByText("2026-08-21").length).toBeGreaterThan(0);
    expect(screen.getByText(/Showing 1–65 of 65/i)).toBeTruthy();
  });

  it("schema panel exposes PK / FK / unique constraints", async () => {
    wrap("/database?table=price_data");
    const schemaBtn = await waitFor(() => screen.getByText("SCHEMA"), { timeout: 4000 });
    schemaBtn.click();
    await waitFor(() =>
      expect(screen.getAllByText(/uq_price_data_dataset_date/i).length).toBeGreaterThan(0),
    );
    expect(screen.getAllByText(/FOREIGN KEY/i).length).toBeGreaterThan(0);
  });
});
