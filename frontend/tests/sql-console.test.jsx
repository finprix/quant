import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DatasetProvider } from "../src/context/DatasetContext.jsx";
import { AuthProvider } from "../src/context/AuthContext.jsx";
import DatabasePage from "../src/pages/DatabasePage.jsx";

const sessionResponse = {
  authenticated: true,
  role: "developer",
  username: "suite-dev",
};

const queryResponse = {
  columns: ["id", "filename", "row_count"],
  rows: [
    [166, "AAPL_1d.csv", 65],
    [225, "GSPC_yahoo_1d.csv", 531],
  ],
  row_count: 2,
  truncated: false,
  max_rows: 500,
  elapsed_ms: 1.4,
  read_only: true,
};

let queryCalls = [];

const route = (path, options = {}) => {
  if (path === "/auth/session") {
    return Response.json(sessionResponse);
  }
  if (path === "/health") {
    return Response.json({ status: "ok" });
  }
  if (path === "/database/status") {
    return Response.json({
      connected: true,
      database: "market_dna",
      server_version: "26.x",
      latency_ms: 1.2,
      tables_count: 10,
    });
  }
  if (path === "/database/tables") {
    return Response.json({
      tables: [
        { name: "datasets", label: "Dataset registry", category: "raw", rows: 2 },
        { name: "price_data", label: "OHLCV observations", category: "raw", rows: 596 },
      ],
    });
  }
  if (path === "/database/stats") {
    return Response.json({
      datasets: 2,
      market_imports: 1,
      csv_imports: 1,
      price_observations: 596,
      oldest_observation: "2025-08-01",
      newest_observation: "2026-08-21",
      size_pretty: "1.2 MiB",
    });
  }
  if (path.startsWith("/database/datasets/")) {
    return Response.json({
      dataset_id: 166,
      counts: {},
      source: null,
    });
  }
  if (path.startsWith("/datasets")) {
    return Response.json({
      datasets: [
        { id: 166, filename: "AAPL_1d.csv" },
        { id: 225, filename: "GSPC_yahoo_1d.csv" },
      ],
    });
  }
  if (path === "/database/query") {
    queryCalls.push(options);
    if (options?.body && JSON.parse(options.body).sql.includes("broken")) {
      return Response.json(
        { detail: "MySQL error 1064: You have an error in your SQL syntax" },
        { status: 422 },
      );
    }
    return Response.json(queryResponse);
  }
  return Response.json({ detail: "not found" }, { status: 404 });
};

const wrap = () =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={["/database"]}>
        <DatasetProvider>
          <DatabasePage />
        </DatasetProvider>
      </MemoryRouter>
    </AuthProvider>,
  );

beforeEach(() => {
  queryCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const path = url
        .replace(/^https?:\/\/[^/]+\/api/, "")
        .replace(/^\/api/, "");
      const base = path.split("?")[0];
      return Promise.resolve(route(base, init ?? {}));
    }),
  );
});

describe("SQL console on the database tab", () => {
  it("developer sees console, runs a query and gets Workbench-style rows", async () => {
    wrap();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /run query/i })).toBeTruthy(),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "SELECT id FROM datasets" },
    });
    fireEvent.click(screen.getByRole("button", { name: /run query/i }));
    await waitFor(() => expect(screen.getByText("AAPL_1d.csv")).toBeTruthy());
    expect(screen.getByText("GSPC_yahoo_1d.csv")).toBeTruthy();
    expect(screen.getByText(/2 rows · 1\.4 ms/i)).toBeTruthy();
    expect(screen.getByText("id")).toBeTruthy();
    expect(screen.getByText("row_count")).toBeTruthy();
    expect(queryCalls).toHaveLength(1);
    expect(JSON.parse(queryCalls[0].body).sql).toBe("SELECT id FROM datasets");
  });

  it("surfaces MySQL errors inline without clearing the editor", async () => {
    wrap();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /run query/i })).toBeTruthy(),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "SELECT broken" },
    });
    fireEvent.click(screen.getByRole("button", { name: /run query/i }));
    await waitFor(() =>
      expect(screen.getByText(/MySQL error 1064/i)).toBeTruthy(),
    );
    expect(screen.queryByText("AAPL_1d.csv")).toBeNull();
    expect((screen.getByRole("textbox").value)).toBe("SELECT broken");
  });

  it("guest sees a locked console with no editor", async () => {
    sessionResponse.authenticated = false;
    sessionResponse.role = null;
    try {
      wrap();
      await waitFor(() =>
        expect(screen.getAllByText(/sql console/i).length).toBeGreaterThan(0),
      );
      expect(screen.getAllByText(/DEVELOPER ACCESS REQUIRED/i).length).toBeGreaterThan(0);
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(
        screen.queryByRole("button", { name: /run query/i }),
      ).toBeNull();
    } finally {
      sessionResponse.authenticated = true;
      sessionResponse.role = "developer";
    }
  });
});
