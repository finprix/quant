import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import { getAiStatus, queryAi } from "../api/ai.js";
import { useDatasets } from "../context/DatasetContext.jsx";
import { TerminalPanel, SectionHeader } from "../components/common/Panels.jsx";
import MetricStrip from "../components/common/MetricStrip.jsx";
import StatusBadge, { RegimeBadge } from "../components/common/StatusBadge.jsx";
import {
  LoadingState,
  ErrorState,
  NoDatasetState,
} from "../components/states/States.jsx";
import { NA, formatSignedPercent, formatPercent, formatConfidence } from "../lib/format.js";

const EXAMPLE_PROMPTS = [
  "What is the current market character and trend state?",
  "How similar are historical analogues to today, and what followed them?",
  "Which regime are we in and how did similar regimes resolve?",
  "What are the main risks and contradictions in the evidence?",
];

const SECTION_ORDER = [
  "CURRENT INTERPRETATION",
  "EVIDENCE",
  "HISTORICAL CONTEXT",
  "RISKS & CAVEATS",
  "IMPORTANT",
];

const CHART_COLORS = ["#c8a24b", "#8c2f39", "#5f8d7c", "#7b6f8e"];

/* ------------------------------------------------------------------ */
/* Answer segmentation: text sections + fenced ```chart blocks        */
/* ------------------------------------------------------------------ */

function parseAnswerSegments(answer) {
  const segments = [];
  const fence = /```chart\s*([\s\S]*?)```/g;
  let cursor = 0;
  let match;
  while ((match = fence.exec(String(answer ?? ""))) !== null) {
    if (match.index > cursor) {
      segments.push({ type: "text", text: answer.slice(cursor, match.index) });
    }
    let spec = null;
    try {
      spec = JSON.parse(match[1].trim());
    } catch {
      spec = null;
    }
    segments.push({ type: "chart", spec });
    cursor = match.index + match[0].length;
  }
  const tail = String(answer ?? "").slice(cursor);
  if (tail.trim()) segments.push({ type: "text", text: tail });
  return segments.filter(
    (segment) =>
      segment.type === "chart" || (segment.text && segment.text.trim()),
  );
}

function parseSections(text) {
  if (!text) return [];
  const lines = String(text).split(/\r?\n/);
  const sections = [];
  let current = null;
  for (const line of lines) {
    const header = line.trim().replace(/[:*]+$/, "").toUpperCase();
    if (SECTION_ORDER.includes(header)) {
      current = { title: header, body: [] };
      sections.push(current);
      continue;
    }
    if (current) current.body.push(line);
  }
  return sections
    .map((section) => ({ title: section.title, text: section.body.join("\n").trim() }))
    .filter((section) => section.text.length > 0);
}

/* ------------------------------------------------------------------ */
/* Markdown-lite prose renderer: pipe tables, bullets, **bold**       */
/* ------------------------------------------------------------------ */

function renderInline(text) {
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function ProseTable({ rows }) {
  const header = rows[0]
    .slice(1, -1)
    .map((cell) => cell.trim())
    .filter(Boolean);
  const body = rows
    .slice(2)
    .map((row) => row.slice(1, -1).map((cell) => cell.trim()));
  return (
    <div className="ai-table-wrap">
      <table className="ai-table">
        <thead>
          <tr>
            {header.map((cell, i) => (
              <th key={i}>{renderInline(cell)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{renderInline(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderProse(text) {
  const lines = String(text).split(/\r?\n/);
  const nodes = [];
  let paragraph = [];
  let bullets = [];
  let tableRows = [];

  const flush = () => {
    if (paragraph.length) {
      nodes.push(<p key={nodes.length}>{renderInline(paragraph.join(" "))}</p>);
      paragraph = [];
    }
    if (bullets.length) {
      nodes.push(
        <ul key={nodes.length}>
          {bullets.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ul>,
      );
      bullets = [];
    }
    if (tableRows.length) {
      nodes.push(<ProseTable key={nodes.length} rows={tableRows} />);
      tableRows = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flush();
    } else if (line.startsWith("|") && line.endsWith("|")) {
      flushPartial(paragraph, bullets, () => {
        paragraph = [];
        bullets = [];
      });
      tableRows.push(line.split("|"));
    } else if (/^[-•]\s+/.test(line)) {
      flush();
      bullets.push(line.replace(/^[-•]\s+/, ""));
    } else {
      flush();
      paragraph.push(line);
    }
  }
  flush();
  return nodes;

  function flushPartial(p, b, reset) {
    if (p.length || b.length) {
      flush();
      reset();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Chart block (Recharts)                                             */
/* ------------------------------------------------------------------ */

function AnswerChart({ spec }) {
  const data = useMemo(() => {
    if (!spec || !Array.isArray(spec.x) || !Array.isArray(spec.series)) return null;
    if (!spec.series.length || spec.x.length === 0) return null;
    if (!spec.series.every((s) => Array.isArray(s.data))) return null;
    return spec.x.map((x, i) => {
      const row = { x: x == null ? "" : String(x) };
      for (const s of spec.series) row[s.name] = s.data[i] ?? null;
      return row;
    });
  }, [spec]);

  if (!data) return null;

  const type = ["bar", "line", "area"].includes(spec.type) ? spec.type : "bar";
  const Series =
    type === "line" ? Line : type === "area" ? Area : Bar;
  const Chart = type === "line" ? LineChart : type === "area" ? AreaChart : BarChart;
  const axisTick = { fontSize: 10, fill: "#8a8578" };

  return (
    <figure className="ai-chart">
      <figcaption className="ai-chart-title mono">
        {String(spec.title ?? "Chart").toUpperCase()}
      </figcaption>
      <ResponsiveContainer width="100%" height={230}>
        <Chart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#3a352e" />
          <XAxis dataKey="x" tick={axisTick} interval="preserveStartEnd" />
          <YAxis tick={axisTick} width={52} />
          <Tooltip
            contentStyle={{
              background: "#191613",
              border: "1px solid #3a352e",
              fontSize: 11,
            }}
          />
          {spec.series.map((s, i) => (
            <Series
              key={s.name ?? i}
              dataKey={s.name}
              name={s.name}
              type={type === "bar" ? undefined : "monotone"}
              fill={CHART_COLORS[i % CHART_COLORS.length]}
              stroke={CHART_COLORS[i % CHART_COLORS.length]}
              strokeWidth={type === "bar" ? undefined : 2}
              dot={false}
            />
          ))}
        </Chart>
      </ResponsiveContainer>
      {spec.x_label || spec.y_label ? (
        <span className="fineprint ai-chart-labels">
          {[spec.x_label, spec.y_label].filter(Boolean).join(" · ")}
        </span>
      ) : null}
    </figure>
  );
}

function GroundingPanel({ context }) {
  const dataset = context?.dataset;
  const intelligence = context?.intelligence;
  const regimesTool = context?.regimes;
  const analogues = context?.analogues;

  const metrics = useMemo(() => {
    if (!dataset) return [];
    return [
      { label: "ROWS", value: dataset.row_count ?? NA },
      {
        label: "LAST CLOSE",
        value:
          typeof dataset.latest_close === "number"
            ? dataset.latest_close.toFixed(2)
            : NA,
      },
      ...(intelligence?.available
        ? [
            { label: "BIAS", value: intelligence.directional_bias ?? NA },
            {
              label: "BIAS SCORE",
              value:
                typeof intelligence.bias_score === "number"
                  ? intelligence.bias_score.toFixed(3)
                  : NA,
            },
            { label: "RISK", value: intelligence.risk_level ?? NA },
            {
              label: "AGREEMENT",
              value: formatConfidence(intelligence.agreement_score),
            },
          ]
        : []),
      ...(intelligence?.analogue_consensus?.median_20d_forward_return != null
        ? [
            {
              label: "ANALOGUE MEDIAN 20D",
              value: formatSignedPercent(
                intelligence.analogue_consensus.median_20d_forward_return,
              ),
            },
          ]
        : []),
    ];
  }, [dataset, intelligence]);

  const regime = regimesTool?.current_regime ?? {};
  const consensus = intelligence?.analogue_consensus;

  return (
    <TerminalPanel title="GROUNDING CONTEXT — QUANT VECTOR ENGINES">
      <MetricStrip items={metrics} />
      <div className="ai-grounding-row">
        <div className="ai-grounding-cell">
          <span className="panel-kicker">CURRENT REGIME</span>
          {regimesTool?.available ? (
            <RegimeBadge
              regimeId={regime.regime_id}
              label={regime.label}
              confidence={regime.confidence}
            />
          ) : (
            <StatusBadge tone="warn">UNAVAILABLE</StatusBadge>
          )}
        </div>
        <div className="ai-grounding-cell">
          <span className="panel-kicker">VALID ANALOGUES</span>
          <span className="mono-strong">
            {analogues?.available ? analogues.matches.length : NA}
          </span>
        </div>
        <div className="ai-grounding-cell">
          <span className="panel-kicker">POS. 20D ANALOGUES</span>
          <span className="mono-strong">
            {consensus?.positive_20d_frequency != null
              ? formatPercent(consensus.positive_20d_frequency, { decimals: 0 })
              : NA}
          </span>
        </div>
      </div>
      <p className="fineprint">
        Every number quoted by the assistant is drawn from these engine outputs.
        Quant Vector never lets the model invent values.
      </p>
    </TerminalPanel>
  );
}

function AnswerView({ result }) {
  const segments = parseAnswerSegments(result.answer);
  const tools = result.tools_used || [];
  return (
    <div className="ai-answer">
      <div className="ai-answer-meta">
        <StatusBadge tone="up">VECTOR ENGINE ONLINE</StatusBadge>
        <span className="fineprint mono">built-in analysis intelligence</span>
        <span className="ai-sources">
          {tools.map((tool) => (
            <span key={tool} className="source-chip">
              [{tool.toUpperCase()}]
            </span>
          ))}
        </span>
      </div>
      {segments.map((segment, segIndex) => {
        if (segment.type === "chart") {
          return segment.spec ? (
            <TerminalPanel
              key={`seg-${segIndex}`}
              title={String(segment.spec.title ?? "VECTOR CHART").toUpperCase()}
            >
              <AnswerChart spec={segment.spec} />
            </TerminalPanel>
          ) : null;
        }
        return parseSections(segment.text).map((section) => (
          <TerminalPanel key={`seg-${segIndex}-${section.title}`} title={section.title}>
            <div className="ai-prose">{renderProse(section.text)}</div>
          </TerminalPanel>
        ));
      })}
      <GroundingPanel context={result.context} />
    </div>
  );
}

export default function AiPage() {
  const { activeId } = useDatasets();
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [question, setQuestion] = useState("");
  const [querying, setQuerying] = useState(false);
  const [result, setResult] = useState(null);
  const [queryError, setQueryError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setStatusError(null);
    getAiStatus()
      .then((payload) => {
        if (!cancelled) setStatus(payload);
      })
      .catch((error) => {
        if (!cancelled) setStatusError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = useCallback(
    async (rawQuestion) => {
      const text = (rawQuestion ?? question).trim();
      if (!text || !activeId || querying) return;
      setQuerying(true);
      setQueryError(null);
      try {
        const payload = await queryAi({ question: text, datasetId: activeId });
        setResult({ ...payload, question: text });
      } catch (error) {
        setQueryError(error.message);
      } finally {
        setQuerying(false);
      }
    },
    [activeId, question, querying],
  );

  if (!activeId) {
    return (
      <div className="page">
        <SectionHeader
          title="AI Analysis"
          desc="Natural-language reasoning over Quant Vector's quantitative evidence."
        />
        <NoDatasetState />
      </div>
    );
  }

  const online = status?.available === true;

  return (
    <div className="page">
      <SectionHeader
        title="AI Analysis"
        desc="Natural-language reasoning over Quant Vector's quantitative evidence."
      />

      <TerminalPanel title={`QUERY — DATASET #${activeId}`}>
        {statusError ? (
          <p className="error-text">{statusError}</p>
        ) : status === null ? (
          <LoadingState label="CHECKING AI ENGINE" />
        ) : (
          <div className="ai-status-row">
            {online ? (
              <>
                <StatusBadge tone="up">ONLINE</StatusBadge>
                <span className="fineprint mono">
                  VECTOR · built-in analysis intelligence
                </span>
              </>
            ) : (
              <>
                <StatusBadge tone="down">OFFLINE</StatusBadge>
                <span className="fineprint">{status.reason}</span>
              </>
            )}
          </div>
        )}

        <form
          className="ai-query-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <input
            className="ai-input"
            type="text"
            value={question}
            placeholder={
              online
                ? "Ask about trend, risk, regimes or historical analogues…"
                : "Configure an AI provider to enable natural-language analysis…"
            }
            disabled={!online || querying}
            onChange={(event) => setQuestion(event.target.value)}
          />
          <button
            type="submit"
            className="btn accent"
            disabled={!online || querying || !question.trim()}
          >
            {querying ? "ANALYZING…" : "ANALYZE"}
          </button>
        </form>

        <div className="ai-examples">
          {EXAMPLE_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              className="prompt-chip"
              disabled={!online || querying}
              onClick={() => {
                setQuestion(prompt);
                submit(prompt);
              }}
            >
              {prompt}
            </button>
          ))}
        </div>

        {queryError ? (
          <>
            <ErrorState message={queryError} />
            <p className="fineprint">
              AI interpretation temporarily unavailable. Quantitative results
              remain available below and through every other page.
            </p>
          </>
        ) : null}
      </TerminalPanel>

      {querying && !result ? (
        <LoadingState label="RUNNING QUANT VECTOR TOOLS" />
      ) : null}

      {result ? (
        result.available ? (
          <AnswerView result={result} />
        ) : (
          <>
            <EmptyOffline reason={result.reason} />
            <GroundingPanel context={result.context} />
          </>
        )
      ) : !online && status !== null ? (
        <>
          <EmptyOffline reason={status.reason} />
          <GroundingNote datasetId={activeId} />
        </>
      ) : null}
    </div>
  );
}

function EmptyOffline({ reason }) {
  return (
    <TerminalPanel title="AI ENGINE OFFLINE">
      <p className="body-text">
        No AI provider is configured{reason ? ` (${reason})` : ""}. The
        quantitative engines continue to run normally — every other view of
        this terminal is unaffected.
      </p>
      <p className="fineprint">
        To enable natural-language analysis, set AI_PROVIDER, AI_API_KEY and
        AI_MODEL in the backend environment (any OpenAI-compatible endpoint). No key is ever stored in the repository.
      </p>
    </TerminalPanel>
  );
}

function GroundingNote({ datasetId }) {
  return (
    <p className="fineprint center">
      Grounding context for dataset #{datasetId} will appear here once a query
      runs against the Quant Vector engines.
    </p>
  );
}
