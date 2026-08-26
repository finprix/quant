import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useSearchParams } from "react-router-dom";
import { useDatasets } from "../../context/DatasetContext.jsx";
import { ANALYSIS_VIEWS, analysisPath } from "../../lib/navigation.js";
import AssetContextBar from "./AssetContextBar.jsx";
import useSymbolBootstrap from "../../hooks/useSymbolBootstrap.js";
import { LoadingState, ErrorState } from "../states/States.jsx";
import { TerminalPanel } from "../common/Panels.jsx";

const POPULAR = [
  { symbol: "^GSPC", label: "S&P 500" },
  { symbol: "^IXIC", label: "NASDAQ" },
  { symbol: "^NSEI", label: "NIFTY 50" },
  { symbol: "NVDA", label: "NVIDIA" },
  { symbol: "AAPL", label: "APPLE" },
  { symbol: "MSFT", label: "MICROSOFT" },
  { symbol: "BTC-USD", label: "BITCOIN" },
  { symbol: "GC=F", label: "GOLD" },
];

/**
 * Shared analysis workspace shell (v0.20.0 — symbol-first).
 *
 * Fingerprint / Analogues / Regimes / Intelligence / Heatmaps are tabs of
 * ONE workspace. Entering with ?symbol=X automatically resolves the
 * instrument and ensures cached history before mounting the views —
 * users never manage datasets manually. ?dataset=N keeps working.
 */
export default function AnalysisLayout() {
  const [params] = useSearchParams();
  const symbolParam = (params.get("symbol") || "").toUpperCase();
  const { activeId, activeDataset, datasets, selectDataset } = useDatasets();

  const [attempt, setAttempt] = useState(0);
  const appliedRef = useRef("");
  const {
    data,
    loading,
    error,
    stage,
  } = useSymbolBootstrap(symbolParam || null, attempt);

  useEffect(() => {
    if (!data?.dataset_id || !symbolParam) return;
    if (appliedRef.current === `${symbolParam}:${data.dataset_id}`) return;
    appliedRef.current = `${symbolParam}:${data.dataset_id}`;
    const existing = datasets.find(
      (d) =>
        (d.filename || "").toUpperCase().startsWith(`${symbolParam}_`) ||
        (d.filename || "").toUpperCase().startsWith(`${symbolParam} `),
    );
    selectDataset(existing ? existing.id : data.dataset_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.dataset_id, symbolParam]);

  const bootstrapping = symbolParam && !activeId;
  const showGate = !bootstrapping && !activeId;

  return (
    <div className="page analysis-shell">
      {bootstrapping && !error ? (
        <TerminalPanel title={`PREPARING ${symbolParam}`} flush>
          <div className="asset-boot">
            <LoadingState label={stage.toUpperCase()} />
            <p className="fineprint">
              Finprix is resolving the instrument and preparing its market
              history for quantitative analysis.
            </p>
          </div>
        </TerminalPanel>
      ) : bootstrapping && error ? (
        <ErrorState
          title={`${symbolParam} COULD NOT BE PREPARED`}
          message={error}
          onRetry={() => setAttempt((a) => a + 1)}
        />
      ) : (
        <>
          {activeId ? <AssetContextBar bootstrapMeta={data} /> : null}

          {showGate ? (
            <TerminalPanel
              title="SELECT A MARKET TO ANALYZE"
              subtitle="Search equities, indices, ETFs, FX or crypto with Ctrl K — or start from a popular market"
            >
              <div className="popular-grid">
                {POPULAR.map((p) => (
                  <Link
                    key={p.symbol}
                    className="market-card market-card--compact"
                    to={`/analysis/fingerprint?symbol=${encodeURIComponent(p.symbol)}`}
                  >
                    <span className="market-card-label mono">{p.label}</span>
                    <span className="fineprint mono">{p.symbol}</span>
                  </Link>
                ))}
              </div>
              <p className="fineprint" style={{ marginTop: 10 }}>
                Custom CSV datasets remain available in{" "}
                <Link to="/datasets" style={{ color: "var(--accent)" }}>
                  DATA → Datasets
                </Link>
                .
              </p>
            </TerminalPanel>
          ) : (
            <>
              <nav className="analysis-tabs" aria-label="Analysis views">
                {ANALYSIS_VIEWS.map((view) => (
                  <NavLink
                    key={view.key}
                    to={
                      symbolParam
                        ? `/analysis/${view.key}?dataset=${activeId}&symbol=${encodeURIComponent(symbolParam)}`
                        : analysisPath(view.key, activeId)
                    }
                    className={({ isActive }) =>
                      `analysis-tab${isActive ? " active" : ""}`
                    }
                  >
                    {view.label}
                  </NavLink>
                ))}
              </nav>

              <div className="analysis-content">
                <Outlet />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
