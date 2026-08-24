import { useEffect, useState } from "react";
import { useDatasets } from "../context/DatasetContext.jsx";
import { useApiData } from "../hooks/useApiData.js";
import { TerminalPanel, SectionHeader } from "../components/common/Panels.jsx";
import MetricStrip from "../components/common/MetricStrip.jsx";
import StatusBadge, { RegimeBadge } from "../components/common/StatusBadge.jsx";
import { PercentileBar } from "../components/common/PercentileBar.jsx";
import { PriceTimeline } from "../components/charts/primitives.jsx";
import {
  ErrorState,
  LoadingState,
  NoDatasetState,
} from "../components/states/States.jsx";
import { APP_VERSION } from "../lib/version.js";
import {
  formatConfidence,
  formatDate,
  formatDateRange,
  formatInteger,
  formatNumber,
  formatPercent,
  formatPrice,
  formatSignedPercent,
} from "../lib/format.js";

const LOOKBACK_OPTIONS = [20, 40, 60, 90, 120];

function Cell({ label, value }) {
  return (
    <div className="report-cell">
      <span className="label">{label}</span>
      <span className="value">{value ?? "N/A"}</span>
    </div>
  );
}

export default function ReportPage() {
  const { activeId } = useDatasets();
  const [lookback, setLookback] = useState(60);
  const [showDrawdown, setShowDrawdown] = useState(false);

  const datasetQuery = useApiData(activeId ? `/datasets/${activeId}` : null);
  const fingerprintQuery = useApiData(
    activeId ? `/datasets/${activeId}/fingerprint` : null,
  );
  const analoguesQuery = useApiData(
    activeId ? `/datasets/${activeId}/analogues?lookback=${lookback}&top_n=8` : null,
  );
  const regimesQuery = useApiData(
    activeId ? `/datasets/${activeId}/regimes?window_size=60` : null,
  );
  const intelligenceQuery = useApiData(
    activeId
      ? `/datasets/${activeId}/intelligence?lookback=${lookback}&top_n=8&window_size=60`
      : null,
  );
  const pricesQuery = useApiData(activeId ? `/datasets/${activeId}/prices` : null);

  // Browser print-to-PDF uses document.title as the default file name and
  // printed header — keep it branded while the report is open.
  useEffect(() => {
    const previous = document.title;
    const datasetName = datasetQuery.data?.filename;
    document.title = datasetName
      ? `Quant Vector — Research Report — ${datasetName}`
      : "Quant Vector — Research Report";
    return () => {
      document.title = previous;
    };
  }, [datasetQuery.data?.filename, activeId]);

  if (!activeId) {
    return (
      <div className="page">
        <SectionHeader title="Research Report" />
        <NoDatasetState />
      </div>
    );
  }

  const loading =
    (datasetQuery.loading && !datasetQuery.data) ||
    (intelligenceQuery.loading && !intelligenceQuery.data);

  if (loading) return <LoadingState label="COMPILING RESEARCH REPORT" />;

  const firstError =
    intelligenceQuery.error || fingerprintQuery.error || datasetQuery.error;
  if (firstError && !intelligenceQuery.data) {
    return (
      <div className="page">
        <SectionHeader title="Research Report" />
        <ErrorState
          message={firstError.message}
          status={firstError.status}
          onRetry={intelligenceQuery.refetch}
        />
      </div>
    );
  }

  const dataset = datasetQuery.data;
  const fpMeta = fingerprintQuery.data;
  const fp = fpMeta?.fingerprint ?? {};
  const analoguesPayload = analoguesQuery.data;
  const regimesPayload = regimesQuery.data;
  const intel = intelligenceQuery.data ?? {};
  const scorecard = intel.scorecard ?? {};
  const evidence = intel.evidence ?? {};
  const state = intel.current_state ?? {};
  const flags = state.state_flags ?? {};
  const consensus = intel.analogue_consensus ?? {};
  const contradictions = intel.contradictions ?? [];
  const prices = pricesQuery.data?.prices;

  const currentRegime = regimesPayload?.available
    ? regimesPayload.current_regime?.current_regime ?? null
    : null;
  const regimeProfile =
    regimesPayload?.available && currentRegime
      ? regimesPayload.regimes.find((r) => r.regime_id === currentRegime.regime_id) ??
        null
      : null;

  const weights = evidence.weights_used ?? {};
  const contributionRows = [
    ["TREND", evidence.trend_score, weights.trend],
    ["ANALOGUES", evidence.analogue_score, weights.analogues],
    ["REGIME", evidence.regime_score, weights.regime],
    ["RISK", evidence.risk_score, weights.risk],
  ].filter(([, score]) => typeof score === "number");
  const maxAbsScore = Math.max(...contributionRows.map(([, score]) => Math.abs(score)), 0.01);
  const contributions = contributionRows.map(([name, score, weight]) => ({
    name,
    score,
    weight: typeof weight === "number" ? weight : null,
    width: (Math.abs(score) / maxAbsScore) * 50,
    positive: score >= 0,
  }));

  const generatedAt = new Date();

  const printReport = () => window.print();

  return (
    <div className="page report-page">
      {/* Masthead */}
      <header className="report-masthead">
        <div>
          <span className="report-brand">QUANT VECTOR</span>
          <h1>RESEARCH REPORT</h1>
          <p className="report-meta mono">
            DATASET #{dataset?.id} · {dataset?.filename} ·{" "}
            {formatDateRange(dataset?.start_date, dataset?.end_date)} ·{" "}
            {formatInteger(dataset?.row_count)} ROWS
          </p>
          <p className="report-meta fineprint">
            Generated {generatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC ·
            engine v{APP_VERSION} · analogue lookback {lookback}d
          </p>
        </div>
        <div className="report-actions print-hidden">
          <label className="control-inline">
            LOOKBACK
            <select
              value={lookback}
              onChange={(event) => setLookback(Number(event.target.value))}
            >
              {LOOKBACK_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {value}D
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn primary" onClick={printReport}>
            PRINT / PDF
          </button>
        </div>
      </header>
      <hr className="section-rule" />

      {/* A. Executive summary */}
      <TerminalPanel title="A — EXECUTIVE SUMMARY">
        <MetricStrip
          items={[
            { label: "DIRECTIONAL BIAS", value: String(scorecard.directional_bias ?? NA_U).toUpperCase() },
            { label: "RISK LEVEL", value: String(scorecard.risk_level ?? NA_U).toUpperCase(), tone: riskTone(scorecard.risk_level) },
            { label: "BIAS SCORE", value: fmtScore(evidence.bias_score), tone: scoreTone(evidence.bias_score) },
            { label: "CONFIDENCE", value: formatConfidence(scorecard.confidence) },
            { label: "AGREEMENT", value: formatConfidence(evidence.agreement_score) },
            { label: "LAST CLOSE", value: formatPrice(state.latest_close ?? dataset?.latest_close) },
          ]}
        />
        <p className="report-summary">{summaryText(intel) ?? "Summary unavailable."}</p>
        {contradictions.length > 0 ? (
          <div className="report-contradictions">
            {contradictions.map((contradiction) => (
              <div key={contradiction.type} className="report-contradiction">
                <StatusBadge tone={contradiction.severity === "high" ? "down" : "warn"}>
                  {String(contradiction.severity ?? "?").toUpperCase()}
                </StatusBadge>
                <div>
                  <strong className="mono">{safeUpper(contradiction.type)}</strong>
                  <p>{toText(contradiction.description)}</p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="fineprint">No contradictions detected between evidence components.</p>
        )}
      </TerminalPanel>

      {/* B. Market state */}
      <TerminalPanel title="B — CURRENT MARKET STATE">
        <MetricStrip
          items={[
            { label: "LATEST DATE", value: formatDate(state.latest_date) },
            { label: "MOMENTUM 20D", value: formatSignedPercent(state.momentum_20d), tone: toneOf(state.momentum_20d) },
            { label: "MOMENTUM 60D", value: formatSignedPercent(state.momentum_60d), tone: toneOf(state.momentum_60d) },
            { label: "VOL (ANN.)", value: formatPercent(state.annualized_volatility) },
            { label: "VOL PERCENTILE", value: pctText(state.volatility_percentile) },
            { label: "CURRENT DRAWDOWN", value: formatSignedPercent(state.current_drawdown), tone: "down" },
            { label: "MA20 / MA50", value: `${shortRel(state.ma20_relationship)} / ${shortRel(state.ma50_relationship)}` },
          ]}
        />
        {(state.volatility_percentile != null ||
          state.current_drawdown != null) && (
          <div className="report-bars">
            <PercentileBar
              label="VOLATILITY PERCENTILE"
              value={(state.volatility_percentile ?? 0) * 100}
              format={() => pctText(state.volatility_percentile)}
            />
            <PercentileBar
              label="DRAWDOWN RECOVERY HEADROOM"
              value={state.current_drawdown != null ? 100 + state.current_drawdown * 100 : 0}
              format={() => formatSignedPercent(state.current_drawdown)}
              variant="biscuit"
            />
          </div>
        )}
      </TerminalPanel>

      {/* C. Statistical fingerprint */}
      <TerminalPanel
        title="C — STATISTICAL FINGERPRINT"
        subtitle={`${formatInteger(fpMeta?.samples_used)} daily observations`}
      >
        <div className="report-grid">
          <Cell label="Mean daily return" value={formatSignedPercent(fp.mean_daily_return)} />
          <Cell label="Annualized volatility" value={formatPercent(fp.annualized_volatility)} />
          <Cell label="Skewness / kurtosis" value={`${formatNumber(fp.skewness, 3)} / ${formatNumber(fp.kurtosis, 3)}`} />
          <Cell label="Max drawdown" value={formatSignedPercent(fp.max_drawdown)} />
          <Cell label="VaR 95% (1d)" value={formatSignedPercent(fp.var_95)} />
          <Cell label="CVaR 95% (1d)" value={formatSignedPercent(fp.cvar_95)} />
          <Cell label="Best / worst day" value={`${formatSignedPercent(fp.best_daily_return)} / ${formatSignedPercent(fp.worst_daily_return)}`} />
          <Cell label="Positive-day ratio" value={formatPercent(fp.positive_return_ratio, { decimals: 1 })} />
          <Cell label="Autocorr lag1 / lag5" value={`${formatNumber(fp.autocorrelation_lag1, 3)} / ${formatNumber(fp.autocorrelation_lag5, 3)}`} />
          <Cell label="Relative volume" value={fp.volume_to_average_ratio != null ? `${formatNumber(fp.volume_to_average_ratio, 2)}x` : null} />
        </div>
        {prices?.length ? (
          <div className="report-chart">
            <div className="report-chart-controls print-hidden">
              <label className="check-inline">
                <input
                  type="checkbox"
                  checked={showDrawdown}
                  onChange={(event) => setShowDrawdown(event.target.checked)}
                />
                DRAWDOWN OVERLAY
              </label>
            </div>
            <PriceTimeline data={prices} height={260} showDrawdown={showDrawdown} />
          </div>
        ) : null}
      </TerminalPanel>

      {/* D. Regime analysis */}
      <TerminalPanel title="D — REGIME ANALYSIS">
        {regimesPayload?.available && currentRegime ? (
          <>
            <div className="report-regime-row">
              <RegimeBadge
                regimeId={currentRegime.regime_id}
                label={currentRegime.label}
                confidence={currentRegime.confidence}
              />
              <span className="fineprint">
                model K={regimesPayload.model?.selected_k} · silhouette{" "}
                {formatNumber(regimesPayload.model?.silhouette, 3)} ·{" "}
                {regimesPayload.n_windows} windows
              </span>
            </div>
            {regimeProfile ? (
              <div className="report-grid">
                <Cell label="Window share" value={regimeProfile.window_count != null && regimesPayload.n_windows > 0 ? `${Math.round((regimeProfile.window_count / regimesPayload.n_windows) * 100)}%` : null} />
                <Cell label="Avg volatility (ann.)" value={formatPercent(regimeProfile.volatility)} />
                <Cell label="Avg max drawdown" value={formatSignedPercent(regimeProfile.max_drawdown)} />
                <Cell label="Avg momentum 20d" value={formatSignedPercent(regimeProfile.avg_momentum_20)} />
                <Cell label="Median +20d outcome" value={formatSignedPercent(regimeProfile.forward_outcomes?.median_return_after_20_days)} />
                <Cell label="P(positive after 20d)" value={formatPercent(regimeProfile.forward_outcomes?.probability_positive_after_20_days, { decimals: 1 })} />
              </div>
            ) : null}
          </>
        ) : (
          <p className="fineprint">
            Regime discovery is unavailable for this dataset at the default window
            size.
          </p>
        )}
      </TerminalPanel>

      {/* E. Historical analogues */}
      <TerminalPanel
        title="E — HISTORICAL ANALOGUES"
        subtitle={`LOOKBACK ${analoguesPayload?.lookback ?? lookback}D · ${analoguesPayload?.candidates_evaluated ?? "?"} CANDIDATES`}
      >
        <span className="observation-banner">HISTORICAL OBSERVATIONS — NOT FORECASTS</span>
        {analoguesPayload?.analogues?.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th><th>PERIOD</th><th>SIMILARITY</th>
                  <th>+5D</th><th>+10D</th><th>+20D</th>
                  <th>MAX FAV 20D</th><th>MAX ADV 20D</th>
                </tr>
              </thead>
              <tbody>
                {analoguesPayload.analogues.map((analogue) => {
                  const action = analogue.subsequent_market_action ?? {};
                  return (
                    <tr key={analogue.rank}>
                      <td className="mono">{analogue.rank}</td>
                      <td className="mono">
                        {formatDate(analogue.start_date)} → {formatDate(analogue.end_date)}
                      </td>
                      <td className="mono">{formatNumber(analogue.similarity_score, 4)}</td>
                      <td className="mono num-pos">{formatSignedPercent(action.return_after_5_days)}</td>
                      <td className="mono num-pos">{formatSignedPercent(action.return_after_10_days)}</td>
                      <td className="mono num-pos">{formatSignedPercent(action.return_after_20_days)}</td>
                      <td className="mono">{formatSignedPercent(action.max_favourable_move_20d)}</td>
                      <td className="mono">{formatSignedPercent(action.max_adverse_move_20d)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="fineprint">No analogue windows matched at this setting.</p>
        )}
        {consensus.valid_analogues ? (
          <>
            <h3 className="report-subhead">ANALOGUE CONSENSUS ({consensus.valid_analogues} valid)</h3>
            <MetricStrip
              items={[
                { label: "MEDIAN +5D", value: formatSignedPercent(consensus.median_5d_forward_return) },
                { label: "MEDIAN +10D", value: formatSignedPercent(consensus.median_10d_forward_return) },
                { label: "MEDIAN +20D", value: formatSignedPercent(consensus.median_20d_forward_return), tone: toneOf(consensus.median_20d_forward_return) },
                { label: "P(+20D)", value: formatPercent(consensus.positive_20d_frequency, { decimals: 1 }) },
                { label: "DISPERSION σ(20D)", value: formatPercent(consensus.std_dev_20d_forward_return) },
              ]}
            />
          </>
        ) : null}
      </TerminalPanel>

      {/* F. Evidence decomposition */}
      <TerminalPanel title="F — COMPOSITE EVIDENCE DECOMPOSITION">
        <div className="report-contributions">
          {contributions.map((row) => (
            <div key={row.name} className="contribution-row">
              <span className="contribution-label">{row.name}</span>
              <div className="contribution-track">
                <div className="contribution-center" />
                <div
                  className={`contribution-bar ${row.positive ? "pos" : "neg"}`}
                  style={{ width: `${row.width}%`, left: row.positive ? "50%" : undefined, right: row.positive ? undefined : "50%" }}
                />
              </div>
              <span className={`contribution-value mono ${row.positive ? "pos" : "neg"}`}>
                {formatSignedPercent(row.score, 1)}
              </span>
              <span className="contribution-weight mono">
                w={row.weight != null ? row.weight.toFixed(2) : "—"}
              </span>
            </div>
          ))}
        </div>
        <p className="fineprint">
          Aggregate bias {fmtScore(evidence.bias_score)} — adaptive weights respond to
          evidence quality (analogue dispersion, regime confidence, coverage).
        </p>
      </TerminalPanel>

      {/* G. Methodology & disclaimers */}
      <TerminalPanel title="G — METHODOLOGY & DISCLAIMERS">
        {intel.methodology ? (
          <details className="report-methodology" open>
            <summary>How the scores were computed</summary>
            <MethodologyList methodology={intel.methodology} />
          </details>
        ) : null}
        <ul className="report-disclaimers">
          {(intel.disclaimers ?? []).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </TerminalPanel>
    </div>
  );
}

const NA_U = "N/A";

/** Render any API value as safe React text (never an object/array). */
function toText(value) {
  if (value === null || value === undefined || value === "") return NA_U;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return NA_U;
  }
}

function summaryText(intel) {
  const raw = intel?.summary;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && typeof raw.summary === "string") {
    return raw.summary;
  }
  return null;
}

function safeUpper(value) {
  return toText(value) === NA_U ? NA_U : String(value).replaceAll("_", " ").toUpperCase();
}

function fmtScore(value) {
  return typeof value === "number" ? formatSignedPercent(value, 1) : NA_U;
}

function scoreTone(value) {
  if (typeof value !== "number") return "";
  return value > 0.05 ? "up" : value < -0.05 ? "down" : "";
}

function riskTone(level) {
  switch (String(level ?? "").toLowerCase()) {
    case "elevated":
    case "high":
      return "down";
    case "low":
      return "up";
    default:
      return "";
  }
}

function toneOf(value) {
  if (typeof value !== "number") return "";
  return value > 0 ? "up" : value < 0 ? "down" : "";
}

function shortRel(relationship) {
  return relationship ? String(relationship).replace("_above", "+").replace("_below", "−").toUpperCase() : NA_U;
}

function pctText(value) {
  return value == null ? NA_U : `${Math.round(value * 100)}%`;
}

function MethodologyList({ methodology }) {
  const groups = [
    ["Component scores", methodology.component_scores],
    ["Aggregation", methodology.aggregation],
    ["State flags", methodology.state_flags],
  ];
  return (
    <div className="stack" style={{ gap: 8 }}>
      {groups.map(([label, entries]) => (
        <div key={label}>
          <strong>{label}</strong>
          <ul style={{ margin: "2px 0 0", paddingLeft: 18 }}>
            {Object.entries(entries ?? {}).map(([key, formula]) => (
              <li key={key}>
                <span className="mono">{key}</span>: {toText(formula)}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div>
        <strong>Risk index</strong>
        <p className="mono" style={{ margin: "2px 0 0" }}>{toText(methodology.risk_index)}</p>
      </div>
      <div>
        <strong>Confidence</strong>
        <p className="mono" style={{ margin: "2px 0 0" }}>{toText(methodology.confidence)}</p>
      </div>
    </div>
  );
}
