# FINPRIX Changelog

## v0.20.0 — Web-first market intelligence terminal

The release that turns Quant Vector into **FINPRIX**: a public,
web-powered quantitative market intelligence terminal.

### Product identity

- Full rebrand to **FINPRIX** across UI, metadata, reports, AI surfaces and
  error states. The brand mark is a pure-typography wordmark (`fin` in
  burgundy italic serif, `Prix` in bold white serif) implemented as a real
  text component (`FinprixLogo`) with navbar / medium / hero / print variants.
- Browser title, report headers and exported PDF names now read FINPRIX.

### Public access

- The access gate is gone. No login, no guest screen, no log-out button —
  opening Finprix lands directly on the global command center.
- Historical developer/PIN infrastructure survives server-side only for
  administrative endpoints; no login UI exists anywhere in the product.
- Destructive/administrative operations remain backend-protected.

### Web-first architecture

- New public symbol-first flow: **SYMBOL → provider → validated history →
  cached dataset → quant engines → UI**. MySQL becomes cache/persistence,
  invisible to normal users.
- `GET /asset/{symbol}` bootstraps any public instrument: resolves it,
  merges a live quote, reuses/incrementally refreshes cached history and
  returns engine readiness — no manual import, no dataset ids.
- `GET /market/global` (indices/commodities/FX/crypto board), `/market/movers`
  (US · India · crypto movers) and `/sectors` (1D/5D/1M sector ETF returns)
  power the homepage from one batched provider call with short-TTL caching.
- `GET /market/news?category=` aggregates real provider headlines by
  category (latest/equities/macro/crypto/commodities/india/watchlist) with
  derived trending-symbol counts. Pass-through only — never fabricated.

### Frontend

- **Global Market Command Center** homepage: regional index strip, Finprix
  Market Pulse (deterministic breadth/momentum/risk/volatility composite),
  market heatmap (indices/sectors/asset classes), top movers tabs, sector
  performance matrix, cross-asset board, live news. Zero datasets required.
- **Asset overview** at `/market/:symbol`: hero quote, key statistics,
  price/drawdown chart, Finprix intelligence signal, symbol news, and a
  RUN FULL ANALYSIS CTA into the shared workspace.
- **Symbol-driven analysis**: `/analysis/{view}?symbol=NVDA` auto-bootstraps
  data behind the scenes; `?dataset=N` deep links keep working.
- **NEWS terminal** as a first-class top-level destination (`/news`).
- **Watchlists** (`/watchlists`): multi-list user watchlists stored locally,
  every symbol routable.
- **Command bar** (Ctrl+K or /): instrument search with quick actions plus
  deterministic commands (`analyze nvda`, `news tesla`, `compare nvda amd`).
- Navigation overhaul: DISCOVER / ANALYZE / RESEARCH / NEWS / DATA — all
  entries always interactive; dataset status bar removed from public pages.
- Analysis views stripped of duplicated asset headers (shell owns context).

### Compatibility

- CSV uploads, custom datasets, compare/correlation research, AI assistant,
  reports and the read-only database inspector remain fully functional.
- Legacy routes (`/fingerprint?dataset=…`, `/overview`) redirect cleanly.

### Tests

- Backend: new `test_web_market.py` (board/movers/sectors/bootstrap/news).
- Frontend: new app-shell suite (public access, branding absence/presence,
  interactive navigation, clickable markets); rewritten discovery-hub suite;
  analysis-shell suite extended for the symbol-first shell.
