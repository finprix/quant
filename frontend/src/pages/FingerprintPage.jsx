import { useDatasets } from "../context/DatasetContext.jsx";
import { useApiData } from "../hooks/useApiData.js";
import { TerminalPanel } from "../components/common/Panels.jsx";
import { StatusBadge } from "../components/common/StatusBadge.jsx";
import {
  LoadingState,
  ErrorState,
  NoDatasetState,
} from "../components/states/States.jsx";
import {
  formatPercent,
  formatSignedPercent,
  formatNumber,
  formatRatio,
} from "../lib/format.js";

const pct = (v) => formatPercent(v);
const spct = (v) => formatSignedPercent(v);
const num = (v) => formatNumber(v, 4);

const GROUPS = [
  {
    title: "Return Structure",
    rows: [
      ["Mean Daily Return", "mean_daily_return", spct],
      ["Median Daily Return", "median_daily_return", spct],
      ["Positive Day Ratio", "positive_return_ratio", pct],
      ["Negative Day Ratio", "negative_return_ratio", pct],
      ["Best Day", "best_daily_return", spct],
      ["Worst Day", "worst_daily_return", spct],
    ],
  },
  {
    title: "Trend",
    rows: [
      ["MA20", "ma20", (v) => formatNumber(v, 2)],
      ["MA50", "ma50", (v) => formatNumber(v, 2)],
      ["MA20 / MA50 Ratio", "ma20_ma50_ratio", formatRatio],
      ["Distance From MA20", "distance_from_ma20", spct],
      ["Distance From MA50", "distance_from_ma50", spct],
      ["MA Alignment", "ma20_ma50_relationship", (v) => String(v ?? "N/A").toUpperCase()],
    ],
  },
  {
    title: "Momentum",
    rows: [
      ["Momentum 20D", "momentum_20", spct],
      ["Momentum 60D", "momentum_60", spct],
    ],
  },
  {
    title: "Volatility",
    rows: [
      ["Daily Std Dev", "std_daily_return", num],
      ["Annualized Volatility", "annualized_volatility", pct],
      ["Volatility 20D (ann.)", "volatility_20d", pct],
      ["Downside Deviation", "downside_deviation", pct],
    ],
  },
  {
    title: "Drawdown & Tail",
    rows: [
      ["Max Drawdown", "max_drawdown", spct],
      ["Average Drawdown", "avg_drawdown", spct],
      ["VaR 95% (daily)", "var_95", spct],
      ["CVaR 95% (daily)", "cvar_95", spct],
    ],
  },
  {
    title: "Distribution",
    rows: [
      ["Skewness", "skewness", num],
      ["Kurtosis (excess)", "kurtosis", num],
      ["Autocorrelation Lag-1", "autocorrelation_lag1", num],
      ["Autocorrelation Lag-5", "autocorrelation_lag5", num],
    ],
  },
  {
    title: "Volume",
    rows: [
      ["Mean Volume", "volume_mean", (v) => formatNumber(v, 0)],
      ["Volume Std Dev", "volume_std", (v) => formatNumber(v, 0)],
      ["Latest vs Average", "volume_to_average_ratio", formatRatio],
    ],
  },
];

const HEADLINE = [
  { key: "annualized_volatility", label: "ANN. VOLATILITY", fmt: pct },
  { key: "max_drawdown", label: "MAX DRAWDOWN", fmt: spct },
  { key: "skewness", label: "SKEWNESS", fmt: num },
  { key: "kurtosis", label: "KURTOSIS", fmt: num },
  { key: "momentum_60", label: "MOMENTUM 60D", fmt: spct },
  { key: "autocorrelation_lag1", label: "AUTOCORR L1", fmt: num },
];

export default function FingerprintPage() {
  const { activeId } = useDatasets();
  const query = useApiData(activeId ? `/datasets/${activeId}/fingerprint` : null);

  if (!activeId) {
    return (
      <div className="analysis-view">
        <div className="view-head">
          <span className="view-title mono">STATISTICAL FINGERPRINT</span>
        </div>
        <NoDatasetState />
      </div>
    );
  }

  if (query.loading && !query.data) {
    return (
      <div className="analysis-view">
        <div className="view-head">
          <span className="view-title mono">STATISTICAL FINGERPRINT</span>
        </div>
        <LoadingState label="COMPUTING FINGERPRINT" />
      </div>
    );
  }

  if (query.error && !query.data) {
    return (
      <div className="analysis-view">
        <div className="view-head">
          <span className="view-title mono">STATISTICAL FINGERPRINT</span>
        </div>
        <ErrorState
          message={query.error.message}
          status={query.error.status}
          onRetry={query.refetch}
        />
      </div>
    );
  }

  const fp = query.data?.fingerprint ?? {};

  return (
    <div className="analysis-view">
      <div className="view-head">
        <span className="view-title mono">STATISTICAL FINGERPRINT</span>
        <span className="view-desc fineprint">Behavioural DNA across the full history.</span>
        <span className="view-badges">
          <StatusBadge>{`${query.data?.samples_used ?? fp.sample_count ?? "?"} SAMPLES`}</StatusBadge>
          {query.data?.cached ? <StatusBadge tone="neutral">CACHED</StatusBadge> : null}
        </span>
      </div>

      <div className="metric-strip">
        {HEADLINE.map(({ key, label, fmt }) => (
          <div className="metric-tile" key={key}>
            <span className="metric-label">{label}</span>
            <span className="metric-value">{fp[key] != null ? fmt(fp[key]) : "N/A"}</span>
          </div>
        ))}
      </div>

      <div className="grid-3">
        {GROUPS.map((group) => (
          <TerminalPanel key={group.title} title={group.title}>
            <table className="dna-table">
              <tbody>
                {group.rows.map(([label, key, fmt]) => (
                  <tr key={key}>
                    <td className="text-cell" style={{ color: "var(--muted)", border: "none", padding: "5px 8px 5px 0" }}>
                      {label}
                    </td>
                    <td style={{ border: "none", textAlign: "right" }}>
                      {fp[key] != null ? fmt(fp[key]) : "N/A"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TerminalPanel>
        ))}
      </div>

      <p className="disclaimer-text">
        The fingerprint summarizes historical behaviour only. Categorical entries
        (e.g. MA alignment) are computed live; numeric entries are persisted in MySQL
        and served from cache when unchanged.
      </p>
    </div>
  );
}
