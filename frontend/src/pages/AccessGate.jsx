import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { request } from "../api/client.js";
import { APP_VERSION } from "../lib/version.js";

const CAPABILITIES = [
  {
    title: "STATISTICAL FINGERPRINTING",
    desc: "Identify the statistical structure of the current market state.",
  },
  {
    title: "REGIME DISCOVERY",
    desc: "Detect recurring volatility, trend and momentum environments.",
  },
  {
    title: "HISTORICAL ANALOGUES",
    desc: "Find past periods that most closely resemble the present.",
  },
  {
    title: "MARKET HEATMAPS",
    desc: "Compare multi-asset returns, momentum, volatility and drawdown.",
  },
  {
    title: "MARKET INTELLIGENCE",
    desc: "Combine trend, analogue, regime and risk evidence.",
  },
  {
    title: "MYSQL DATA ENGINE",
    desc: "External market data → Python → MySQL → quantitative analysis.",
  },
  {
    title: "AI RESEARCH",
    desc: "Ask natural-language questions grounded in Quant Vector calculations.",
  },
  {
    title: "REPORTING",
    desc: "Generate structured institutional-style analysis reports.",
  },
];

const PIPELINE = [
  "MARKET DATA",
  "PYTHON INGESTION",
  "MYSQL",
  "QUANT ENGINE",
  "INTELLIGENCE",
  "AI / FRONTEND",
];

function StatusDot({ state }) {
  return <span className={`gate-dot ${state ?? "pending"}`} aria-hidden="true" />;
}

export default function AccessGate() {
  const { enterAsGuest, login, loginError, authenticating } = useAuth();
  const [showLogin, setShowLogin] = useState(false);
  const [pin, setPin] = useState("");
  const [status, setStatus] = useState(null);

  // Real health endpoints only — never fabricated status.
  useEffect(() => {
    let cancelled = false;
    const probe = () => {
      const result = { api: null, mysql: null, ai: null };
      const mark = (key, ok) => !cancelled && (result[key] = ok);
      Promise.allSettled([
        request("/health").then((r) => mark("api", r?.status === "ok")),
        request("/database/status")
          .then((r) => mark("mysql", Boolean(r?.connected)))
          .catch(() => mark("mysql", false)),
        request("/ai/status").then((r) => mark("ai", Boolean(r?.available))),
      ])
        .then(() => !cancelled && setStatus(result))
        .catch(() => {});
    };
    probe();
    const timer = setInterval(probe, 20000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const onSubmit = async (event) => {
    event.preventDefault();
    if (!pin) return;
    const ok = await login(pin);
    if (!ok) setPin("");
  };

  return (
    <div className="access-gate">
      <div className="gate-grid" aria-hidden="true" />

      <main className="gate-main">
        {/* ---------------------------------------------------- HERO */}
        <section className="gate-hero">
          <p className="gate-kicker mono">RESTRICTED QUANTITATIVE RESEARCH TERMINAL</p>
          <h1 className="gate-title">
            QUANT<span className="gate-title-accent"> VECTOR</span>
          </h1>
          <p className="gate-subtitle">Quantitative Market Intelligence Engine</p>
          <p className="gate-desc">
            Quant Vector analyzes real historical market data using statistical
            fingerprinting, regime discovery, historical analogue detection,
            cross-sectional market intelligence and AI-assisted interpretation.
          </p>
          <div className="gate-status-row" role="status">
            <span className="gate-status-item">
              <StatusDot state={status ? (status.api ? "ok" : "down") : null} />
              API {status ? (status.api ? "ONLINE" : "OFFLINE") : "…"}
            </span>
            <span className="gate-status-item">
              <StatusDot state={status ? (status.mysql ? "ok" : "down") : null} />
              MYSQL {status ? (status.mysql ? "CONNECTED" : "OFFLINE") : "…"}
            </span>
            <span className="gate-status-item">
              <StatusDot state={status ? (status.ai ? "ok" : "down") : null} />
              AI {status ? (status.ai ? "ONLINE" : "OFFLINE") : "…"}
            </span>
            <span className="gate-version mono">v{APP_VERSION}</span>
          </div>
        </section>

        {/* -------------------------------------------- CAPABILITIES */}
        <section className="gate-caps" aria-label="System capabilities">
          {CAPABILITIES.map((cap) => (
            <article className="gate-cap" key={cap.title}>
              <h2>{cap.title}</h2>
              <p>{cap.desc}</p>
            </article>
          ))}
        </section>

        {/* ------------------------------------------------ PIPELINE */}
        <section className="gate-pipeline-wrap" aria-label="Data pipeline">
          <div className="gate-pipeline">
            {PIPELINE.map((step, index) => (
              <div className="gate-pipe-step" key={step}>
                <span className="mono">{step}</span>
                {index < PIPELINE.length - 1 ? (
                  <span className="gate-pipe-arrow" aria-hidden="true">▼</span>
                ) : null}
              </div>
            ))}
          </div>
        </section>

        {/* -------------------------------------------------- ACCESS */}
        <section className="gate-access" aria-label="Access terminal">
          <h2 className="panel-kicker">ACCESS TERMINAL</h2>

          {!showLogin ? (
            <>
              <button type="button" className="btn accent gate-btn" onClick={enterAsGuest}>
                CONTINUE AS GUEST
              </button>
              <button
                type="button"
                className="btn gate-btn"
                onClick={() => setShowLogin(true)}
              >
                DEVELOPER LOGIN
              </button>
              <p className="fineprint">
                Guest mode is read-only research. Dataset administration requires a
                developer session validated by the backend.
              </p>
            </>
          ) : (
            <form className="gate-login-form" onSubmit={onSubmit}>
              <label className="control-inline">
                DEVELOPER PIN
                <input
                  className="ai-input gate-pin-input mono"
                  type="password"
                  inputMode="numeric"
                  autoComplete="current-password"
                  autoFocus
                  value={pin}
                  placeholder="•••••••"
                  onChange={(event) => setPin(event.target.value)}
                />
              </label>
              {loginError ? <p className="error-text">{loginError}</p> : null}
              <div className="row-actions">
                <button
                  type="submit"
                  className="btn accent gate-btn"
                  disabled={authenticating || !pin}
                >
                  {authenticating ? "VALIDATING…" : "UNLOCK DEVELOPER ACCESS"}
                </button>
                <button
                  type="button"
                  className="btn gate-btn"
                  onClick={() => setShowLogin(false)}
                >
                  BACK
                </button>
              </div>
              <p className="fineprint">
                The PIN is verified server-side against a scrypt hash — the raw
                value is never stored. Failed attempts are rate limited.
              </p>
            </form>
          )}
        </section>
      </main>

      <footer className="gate-footer fineprint">
        QUANT VECTOR · internal research system · fingerprint · regimes · analogues · intelligence
      </footer>
    </div>
  );
}
