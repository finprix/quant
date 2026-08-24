# QUANT VECTOR

**A Quantitative Engine for Statistical Fingerprinting, Regime Discovery and Historical
Analogue Detection in Financial Time Series**

QUANT VECTOR lets you upload historical OHLCV market data and explore it through a set of
classical, deterministic quantitative techniques: a statistical "fingerprint" of each
dataset, searches for similar historical windows (analogues), unsupervised discovery of
market regimes with PCA + KMeans, a fused intelligence scorecard, cross-market correlation
and regression analysis, and an exportable research report.

> **This project is descriptive, not predictive.** Every number explains what happened in
> the past. It is an educational DBMS + analytics project, not investment advice.

---

## Overview

- Upload one or many CSV files of OHLCV data; everything persists to Turso / libSQL (MySQL-compatible workflow preserved via SQL).
- Each dataset gets a statistical fingerprint — volatility, drawdown, skewness,
  autocorrelation, trend alignment and more.
- The analogue engine finds the most statistically similar past windows to the present one
  and shows what historically followed them.
- The regime engine groups sliding windows into market regimes (calm uptrend, high-vol
  decline, ...) using PCA + KMeans with automatic cluster-count selection, then derives
  transition probabilities and regime-conditional outcomes.
- The intelligence layer fuses trend / analogue / regime / risk evidence into a bounded,
  explainable scorecard with confidence and explicit contradictions.
- The compare workspace aligns datasets for metric matrices, normalized performance charts,
  fingerprint similarity, daily-return correlations (Pearson/Spearman/downside/upside),
  rolling correlation views and beta/regression analysis. Selections can be saved as
  reusable presets.
- A print-ready research report composes everything into sections with CSV/PNG exports.

## Key Features

- Deterministic analytics: fixed seeds, reproducible outputs, parameter-hashed result cache
- Graceful degradation: short histories yield `null` metrics, never wrong numbers
- Scale-free comparisons: returns-based statistics only, never raw price levels
- Full audit trail of methodology in the API (`methodology`, `disclaimer` fields)
- Lightweight TTL response cache on the frontend; snapshot cache on the backend

## Technology Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.12+, FastAPI, Uvicorn |
| Database | Turso / libSQL (MySQL-compatible workflow preserved via SQL) 8.x (InnoDB), `mysql-connector-python` |
| Quant | pandas, NumPy, SciPy, statsmodels, scikit-learn |
| Frontend | React 19, Vite 7, react-router-dom 7, recharts 3, html-to-image |
| Tests | Self-contained suites using FastAPI `TestClient` against real Turso / libSQL (MySQL-compatible workflow preserved via SQL) |

## Architecture

```
CSV → FastAPI → validation/cleaning → Turso / libSQL (MySQL-compatible workflow preserved via SQL) → quant engines → intelligence layer
    → REST API → React frontend
```

Details: [`docs/architecture.md`](docs/architecture.md)

## Database Design

9 InnoDB tables: `datasets`, `price_data`, `analysis_results`, `fingerprints`,
`analogue_matches`, `regime_models`, `regime_assignments`, `intelligence_snapshots`,
`comparison_presets`. Foreign keys cascade from `datasets`; JSON columns store reproducible
model payloads and cached results.

Details + ER diagram: [`docs/database_schema.md`](docs/database_schema.md)

## Quantitative Features

Returns & volatility · drawdowns · VaR/CVaR · statistical fingerprint · z-score
standardization · PCA · KMeans regime discovery · silhouette/Davies–Bouldin selection ·
transition matrices · conditional outcomes · Pearson/Spearman/downside/upside correlation ·
rolling correlation · OLS beta/R²/residual analysis.

Formulas: [`docs/quant_methodology.md`](docs/quant_methodology.md)

## Project Structure

```
market-dna/
├── backend/
│   ├── main.py              # FastAPI routes & orchestration
│   ├── analytics.py         # cleaning + summary statistics
│   ├── fingerprint.py       # fingerprint, analogues, comparison reference
│   ├── regimes.py           # windowing, PCA, KMeans, transitions
│   ├── intelligence.py      # evidence fusion + snapshot cache
│   ├── cross_market.py      # correlations, rolling series, regression
│   ├── database.py          # all parameterized SQL
│   ├── schema.sql           # idempotent DDL
│   ├── test_*.py            # six self-test suites
│   ├── benchmark_phase8.py  # performance harness
│   └── requirements.txt
├── frontend/
│   └── src/{api,context,hooks,components,pages,lib,styles}
├── sample_data/
│   └── demo_market.csv      # SYNTHETIC demo data (not real markets)
└── docs/                    # schema, methodology, architecture, demo guide, notes
```

## Requirements

- Windows / macOS / Linux
- Python 3.12 or newer
- Node.js 18+ (with npm)
- Turso / libSQL (MySQL-compatible workflow preserved via SQL) Server 8.x running locally

## Installation

Windows (PowerShell):

```powershell
git clone <your-repo-url> market-dna
cd market-dna\backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env      # then edit if needed

cd ..\frontend
npm install
```

## Turso / libSQL (MySQL-compatible workflow preserved via SQL) Setup

1. Ensure the Turso / libSQL (MySQL-compatible workflow preserved via SQL) service is running (`services.msc` → Turso / libSQL (MySQL-compatible workflow preserved via SQL)80, or your own install).
2. Credentials are read by the backend; create the database automatically on first start
   (schema.sql runs `CREATE DATABASE IF NOT EXISTS`), or pre-create it:

   ```sql
   CREATE DATABASE IF NOT EXISTS market_dna CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   ```

3. Tables are created/verified automatically at backend startup.

## Environment Variables

`backend/.env` (see `backend/.env.example`; never commit real credentials):

```
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=
MYSQL_DATABASE=market_dna
```

Frontend optional variable (build-time): `VITE_API_BASE_URL`
(defaults to `http://127.0.0.1:8000`).

## Backend Startup

```powershell
cd backend
uvicorn main:app --reload --port 8000
```

Health check: <http://127.0.0.1:8000/health> · Swagger UI: <http://127.0.0.1:8000/docs>

## Frontend Startup

```powershell
cd frontend
npm run dev
```

Open <http://localhost:5173>.

### AI — VECTOR engine

The AI page is powered by **VECTOR**, Quant Vector's built-in analysis
intelligence. It answers only from the structured tool context produced by
the local engines (fingerprint, regimes, analogues, intelligence, price
series) and may include rendered charts and tables in its answers. The
engine never discloses third-party services or model details; API access is
configured server-side via AI_PROVIDER, AI_API_KEY and AI_MODEL in
ackend/.env (any OpenAI-compatible endpoint works).

# Access modes

Quant Vector opens on an access gate with two intentional roles:

- **GUEST — research mode.** One click, no credentials. Full read access:
  every analysis page, the database inspector, price history, AI and
  reports. All mutating controls are hidden in the UI *and* rejected by
  the backend (401).
- **DEVELOPER — research + data administration.** PIN entry at the gate,
  verified server-side against a scrypt hash stored in `backend/.env`
  (`MARKETDNA_DEV_PIN_HASH`). Unlocks CSV upload, market
  imports/updates/deletes, comparison-preset management, the SQL console
  and the integrity check.

Sessions are HMAC-signed HTTP-only cookies (12 h default) that survive
page refreshes; logout destroys them. Failed logins are rate limited.
In development the Vite dev server proxies `/api/*` to the backend, which
keeps the cookie first-party to `localhost:5173` — unlock once and the
session persists across reloads. For split-host deployments (frontend on
a different origin than the API), set `VITE_API_BASE_URL` at build time
and serve both over HTTPS with `MARKETDNA_COOKIE_SAMESITE=none`,
`MARKETDNA_COOKIE_SECURE=true` and matching CORS origins.
Configure via `backend/.env` (copy `.env.example`). **Change the initial
developer PIN before any public deployment**:

```
python -c "import auth; print(auth.hash_password('YOUR NEW PIN'))"
# then set MARKETDNA_DEV_PIN_HASH in backend/.env and restart
```

## Usage

1. Upload a CSV on the Datasets page (or use `sample_data/demo_market.csv`),
   **or** click FETCH MARKET DATA to search Yahoo Finance and import an
   instrument end-to-end (search → import with stage progress → dataset ready).
2. Browse Overview (incl. the multi-asset market heatmap) → Fingerprint →
   Analogues → Regimes → Intelligence for the active dataset.
3. Compare two or more datasets on the Compare page (Metrics and Cross-market tabs);
   save selections as presets.
4. Ask the AI analyst grounded questions on the AI page.
5. Export the research report from the Report page (print/PDF, PNG charts, CSV tables).
6. Inspect the actual Turso / libSQL (MySQL-compatible workflow preserved via SQL) tables on the Database page: live row counts,
   real stored rows with pagination/filtering/sorting, full schema (primary
   keys, foreign keys, unique constraints such as the one-row-per-dataset-date
   protection), per-dataset storage breakdown, data lineage and a manual
   read-only integrity check. The inspector is strictly read-only and never
   accepts arbitrary SQL.

Imported instruments remember their source; the UPDATE button fetches only
newer sessions (healing the boundary bar), reports a real-count receipt
(fetched/inserted/replaced/unchanged) and invalidates every cached analysis.

## CSV Format

Required columns (case-insensitive headers):

```
Date,Open,High,Low,Close,Volume
2024-01-01,100.5,101.2,99.8,100.9,1234567
```

- `Date` parseable dates, ascending order recommended (cleaning sorts anyway)
- Prices numeric, positive; `Volume` integer-valued
- Rows with missing critical fields are dropped during cleaning

## API Overview

| Group | Endpoints |
|---|---|
| System | `GET /health` |
| Datasets | `POST /upload`, `GET /datasets`, `GET /datasets/{id}`, `GET /datasets/{id}/prices`, `DELETE /datasets/{id}` |
| Fingerprint | `GET /datasets/{id}/fingerprint`, `GET /datasets/{id}/analogues?lookback&top_n` |
| Regimes | `GET /datasets/{id}/regimes?window_size&k`, `GET /datasets/{id}/regimes/current?window_size` |
| Intelligence | `GET /datasets/{id}/intelligence`, `GET /datasets/{id}/intelligence/summary` |
| Comparison | `GET /datasets/compare/fingerprints?ids=` (2–4), `GET /datasets/compare/correlation?ids=&pair_focus=` (2–10) |
| Presets | `POST/GET /comparison-presets`, `GET/PUT/DELETE /comparison-presets/{id}` |
| AI (optional) | `GET /ai/status`, `POST /ai/query` |
| Auth (v0.12.0) | `POST /auth/login`, `POST /auth/logout`, `GET /auth/session` — HTTP-only signed session cookie, backend-verified developer credentials |
| Watchlist (v0.16.0) | \GET /watchlist\ (quotes merged), \POST /watchlist\ 🔒, \DELETE /watchlist/{symbol}\ 🔒 — tracked symbols persisted in libSQL |
| Market data | `GET /market/search?q=&provider=`, `POST /market/import` 🔒, `GET /market/import/status/{job_id}`, `POST /market/update/{dataset_id}` 🔒, `GET /market/overview` |
| Database inspector (read-only) | `GET /database/status`, `GET /database/stats`, `GET /database/tables`, `GET /database/tables/{table}`, `GET /database/tables/{table}/schema`, `GET /database/datasets/{id}/storage`, `POST /database/integrity` 🔒 |
| SQL console (v0.12.1, developer) | `POST /database/query` 🔒 — one validated read-only statement per call (`SELECT`/`WITH`/`SHOW`/`DESCRIBE`/`EXPLAIN`); session is `READ ONLY` server-side, mutations rejected 422, max 500 rows |

🔒 = requires a developer session (guest requests receive 401). Dataset
mutation endpoints (`POST /upload`, `DELETE /datasets/{id}`, preset
create/update/delete) are protected the same way.

Interactive docs at `/docs` (Swagger UI).

## Testing

Backend (from `backend/`, with Turso / libSQL (MySQL-compatible workflow preserved via SQL) running):

```powershell
python -m py_compile main.py analytics.py fingerprint.py regimes.py intelligence.py cross_market.py database.py
python test_fingerprint.py
python test_regimes.py
python test_intelligence.py
python test_compare.py
python test_cross_market.py
python test_presets.py
```

Each suite prints per-check PASS/FAIL lines and a final `RESULT:` summary.

Frontend:

```powershell
npm run build
```

## Limitations

- Simple (not log) returns; no dividend/split adjustment of source data
- Regimes are KMeans clusters of window statistics — useful descriptions, not ground truth
- Analogues and conditional outcomes are historical observations, not predictions
- Correlation/beta describe co-movement; they imply neither causation nor future behaviour
- Single-user local installation: no authentication, no live data feeds, no deployment config

## Disclaimer

QUANT VECTOR is an educational project. Nothing it produces is financial advice, a
recommendation, or a prediction. Markets involve risk; past behaviour never guarantees
future outcomes. All sample data shipped with the repository is synthetic.
