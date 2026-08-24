import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { DatasetProvider } from "../src/context/DatasetContext.jsx";
import { AuthProvider } from "../src/context/AuthContext.jsx";
import AiPage from "../src/pages/AiPage.jsx";

// jsdom has no layout engine: Recharts' ResponsiveContainer measures 0x0.
// Stub the whole library — the fenced-block parsing/markup is what we test
// here; real SVG geometry is verified against the live stack.
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }) => (
    <div className="recharts-wrapper">{children}</div>
  ),
  BarChart: ({ children }) => <div data-chart="bar">{children}</div>,
  LineChart: ({ children }) => <div data-chart="line">{children}</div>,
  AreaChart: ({ children }) => <div data-chart="area">{children}</div>,
  Bar: () => null,
  Line: () => null,
  Area: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}));

const ANSWER = [
  "CURRENT INTERPRETATION",
  "Momentum is positive over the last 20 sessions [intelligence].",
  "",
  "```chart",
  JSON.stringify({
    type: "bar",
    title: "Analogue forward returns",
    x_label: "Analogue period",
    y_label: "% return",
    x: ["2024-01 .. 2024-03", "2024-05 .. 2024-07"],
    series: [{ name: "20d forward %", data: [2.1, -0.4] }],
  }),
  "```",
  "",
  "HISTORICAL CONTEXT",
  "",
  "| Regime | Windows | Median 20d |",
  "| --- | --- | --- |",
  "| Bull | 12 | +3.1% |",
  "",
  "IMPORTANT",
  "Historical similarity does not imply identical future behaviour.",
].join("\n");

let sessionDeveloper = true;

const route = (path, init = {}) => {
  const json = (payload, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  if (path === "/auth/session") {
    return sessionDeveloper
      ? json({ authenticated: true, role: "developer" })
      : json({ authenticated: false, role: null });
  }
  if (path === "/health") return json({ status: "ok" });
  if (path === "/ai/status") return json({ available: true, engine: "Vector" });
  if (path === "/datasets") {
    return json({
      datasets: [
        {
          id: 166,
          filename: "AAPL_1d.csv",
          start_date: "2026-05-28",
          end_date: "2026-08-21",
        },
      ],
    });
  }
  if (path === "/datasets/166") return json({ id: 166, filename: "AAPL_1d.csv" });
  if (path === "/ai/query") {
    const body = JSON.parse(init.body || "{}");
    return json({
      available: true,
      engine: "Vector",
      answer: ANSWER,
      context: { dataset: { row_count: 65 }, intelligence: { available: false } },
      tools_used: ["intelligence", "price_series"],
      question: body.question,
    });
  }
  return json({ detail: "not found" }, 404);
};

const mountPage = () =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={["/ai"]}>
        <DatasetProvider>
          <AiPage />
        </DatasetProvider>
      </MemoryRouter>
    </AuthProvider>,
  );

beforeEach(() => {
  window.localStorage.setItem("market-dna.active-dataset-id", "166");
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn((input, init) => {
      const url = typeof input === "string" ? input : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
      return Promise.resolve(route(path.replace(/^\/api/, ""), init ?? {}));
    }),
  );
});

describe("VECTOR AI page", () => {
  it("renders sections, a chart and a table from the answer", async () => {
    const user = userEvent.setup();
    mountPage();
    const askButton = await screen.findByRole("button", { name: /^analyze$/i });
    await user.type(await screen.findByRole("textbox"), "How are we trending?");
    await user.click(askButton);

    await waitFor(() =>
      expect(screen.getByText(/Momentum is positive/i)).toBeTruthy(),
    );
    expect(screen.getByText("CURRENT INTERPRETATION")).toBeTruthy();
    expect(screen.getByText("HISTORICAL CONTEXT")).toBeTruthy();

    // Chart figure mounted for the fenced chart block (Recharts is stubbed
    // for jsdom; assert our wrapper, the inner chart node and the title).
    await waitFor(() =>
      expect(document.querySelector(".ai-chart .recharts-wrapper")).toBeTruthy(),
    );
    expect(document.querySelector('[data-chart="bar"]')).toBeTruthy();
    // Title appears twice by design: as the panel header and the figcaption.
    expect(screen.getAllByText(/ANALOGUE FORWARD RETURNS/i).length).toBeGreaterThan(0);

    // Markdown pipe table rendered as a real HTML table.
    expect(screen.getByText("Regime")).toBeTruthy();
    expect(screen.getByText("+3.1%")).toBeTruthy();
  });

  it("never exposes the underlying vendor in the UI", async () => {
    mountPage();
    await waitFor(() =>
      expect(screen.getByText(/VECTOR · built-in analysis intelligence/i)).toBeTruthy(),
    );
    const html = document.body.innerHTML.toLowerCase();
    expect(html).not.toContain("groq");
    expect(html).not.toContain("llama-3.3");
  });

  it("badges the engine and source chips on answers", async () => {
    const user = userEvent.setup();
    mountPage();
    await user.type(await screen.findByRole("textbox"), "risk?");
    await user.click(await screen.findByRole("button", { name: /^analyze$/i }));
    expect(await screen.findByText("VECTOR ENGINE ONLINE")).toBeTruthy();
    expect(screen.getByText("[INTELLIGENCE]")).toBeTruthy();
    expect(screen.getByText("[PRICE_SERIES]")).toBeTruthy();
  });
});
