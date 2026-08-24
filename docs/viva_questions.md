# QUANT VECTOR — Viva / Interview Questions

~40 questions with concise answers. Deeper detail: `docs/quant_methodology.md`,
`docs/dbms_notes.md`, `docs/database_schema.md`, `docs/architecture.md`.

## Project & Architecture

**1. What does QUANT VECTOR do in one sentence?**
It ingests OHLCV CSVs into MySQL and applies deterministic quantitative techniques —
statistical fingerprinting, historical analogue search, PCA+KMeans regime discovery,
evidence fusion, cross-market correlation/regression — behind a FastAPI API and React
dashboard.

**2. Walk through the full data flow of an upload.**
Browser posts the file → FastAPI reads it → pandas validates headers and cleans rows
(`clean_ohlcv`: type coercion, NaN/zero-price drops, date sorting, deduplication) → summary
statistics computed → dataset row + price rows + metrics inserted in MySQL → id returned;
frontend refreshes its dataset list and invalidates caches.

**3. Why are datasets immutable? What breaks without that rule?**
Every upload creates a new id; nothing is ever edited in place. This makes result caching
provably safe: cached intelligence keyed by (dataset_id, param_hash) can never go stale due
to edits — only new data means a new id. Without immutability every cache would need
invalidation logic tied to writes.

**4. Why is the backend the only place statistics are computed?**
One implementation of each formula, testable in isolation, consistent between dashboard and
report; the frontend stays a presentation layer and cannot drift from stored results.

**5. How do the frontend and backend communicate?**
REST over HTTP with JSON. One fetch wrapper (`client.js`) centralizes base URL and error
handling (`ApiError`); hooks add TTL caching, dedup and parallel fetching.

## Database & MySQL

**6. Which storage engine does the project use and why?**
InnoDB: transactions, foreign keys with cascade deletes, row locking, crash recovery via
redo log.

**7. List the tables and their relationships.**
`datasets` is the parent of `price_data`, `analysis_results`, `fingerprints`,
`analogue_matches`, `regime_models` and `intelligence_snapshots`; `regime_models` parents
`regime_assignments`. `comparison_presets` is standalone with JSON references (no FK) so
presets survive dataset deletion.

**8. Why DECIMAL for prices but DOUBLE for metrics?**
Prices are user-entered exact values where rounding errors compound; DECIMAL(18,6) stores
them exactly. Metrics are derived floats where binary floating point is appropriate.

**9. Explain the composite index on price_data.**
`(dataset_id, date)` serves both "all bars of a dataset ordered by date" and point lookups
by date, thanks to the leftmost-prefix rule; it also makes cascade scans efficient.

**10. How does the schema prevent SQL injection?**
All queries are parameterized (`%s` placeholders bound by mysql-connector-python); no user
input is ever concatenated into SQL strings.

**11. What happens on DELETE of a dataset?**
A single statement cascades through all child tables (prices, metrics, matches, models,
timeline, intelligence snapshots). FKs make orphan rows impossible.

**12. Why JSON columns instead of more tables for model payloads?**
The payloads are read/written whole, versioned as documents, and never queried field-by-field
in SQL — JSON gives flexibility without losing relational integrity elsewhere.

**13. What is the EAV-style design used for metrics? Trade-offs?**
Rows of (dataset_id, metric_name, metric_value): new metrics need no ALTER TABLE, and unique
(dataset_id, metric_name) keeps re-runs idempotent. Cost: reading all metrics touches many
rows — fine because we always want the whole set.

**14. How is the intelligence cache validated?**
Snapshot stores `latest_market_date`; it may be reused only while equal to the dataset's
current `end_date`. Combined with immutable datasets and parameter hashing this yields exact
cache correctness.

**15. Why delete-then-insert instead of UPDATE when re-running regime discovery?**
A model plus hundreds of assignment rows is replaced atomically in one commit; "exactly one
current model per dataset" holds without diffing logic.

## Backend / API

**16. Why FastAPI?**
Automatic request validation (Pydantic), async-friendly routing, generated OpenAPI docs at
/docs, dependency-free TestClient testing.

**17. How does an analogue search work end-to-end?**
Take last N bars → build 18-feature vector → standardize using scaler fitted on historical
pool only → compare against earlier disjoint windows (stride N/10) by Euclidean distance →
similarity = exp(−d/median d) → greedy selection enforcing minimum temporal separation →
attach forward outcomes of each match.

**18. Why standardize features before distance computations?**
Features have different scales (volatility ~0.01 vs drawdown −0.6); raw Euclidean distance
would be dominated by large-scale features. z-scoring puts them on one footing.

**19. Why is the scaler fitted on the historical pool only?**
If the current window influenced scaling, adding it could shift scales and change past
similarities — non-stationary comparisons. Pool-only fitting keeps the current window a pure
observer.

**20. How is PCA used here?**
Standardized sliding-window feature matrices are rotated onto axes of maximum variance; the
fewest components in [2,10] preserving ≥95% cumulative variance (fallback ≥85%) are kept —
denoising correlated features before clustering.

**21. How is k chosen for KMeans?**
Candidates k=2..8 scored by silhouette (maximize) with Davies–Bouldin (minimize) as
tie-breaker; explicit k can be forced and `auto_selected` reports which path ran.
Deterministic via random_state=42, n_init=10.

**22. What is a transition matrix and how is it built?**
Chronologically ordered window labels give consecutive pairs; counts normalize row-wise to
P(next regime | current regime) — a historical frequency table, not a forecast.

**23. How does the intelligence layer fuse evidence?**
Four bounded scores (trend, analogues, regime, risk) via tanh transforms, combined with
weights 0.30/0.30/~0.25/0.15; regime weight scales with assignment confidence, analogues lose
weight when forward-return dispersion is high; contradictions are surfaced explicitly.

**24. What does the confidence number mean?**
Agreement between evidence streams, coverage of available inputs, inverse dispersion,
regime confidence and sample depth, weighted 0.35/0.25/0.20/0.10/0.10 — low confidence flags
disagreeing or thin evidence.

**25. What performance optimizations were made?**
Analogue loop computes one fingerprint per candidate window (deduped helper) — measured −39%
at 10k rows with float-identical output; intelligence checks its DB snapshot before loading
price rows; bounded in-process LRU caches; frontend TTL cache + route-level code splitting.

**26. How do you know optimizations didn't change results?**
Float-identical output verified on benchmark frames, and all six regression suites still
pass after each change.

## Statistics & Quant concepts

**27. Why compare returns instead of prices?**
Returns are scale-free: a ₹100 stock and a ₹5000 stock become comparable; correlations and
betas would otherwise reflect price levels, not behaviour.

**28. Define annualized volatility.**
Daily return standard deviation × √252 (square-root-of-time scaling).

**29. What is maximum drawdown vs CVaR?**
Max drawdown: worst peak-to-trough decline of the price path. CVaR 95%: average of the worst
5% of daily returns — expected loss given a tail day.

**30. Pearson vs Spearman correlation — when does each help?**
Pearson measures linear co-movement; Spearman correlates ranks, staying robust to outliers
and monotonic-but-nonlinear relationships. Reporting both exposes rank-driven agreement.

**31. What are downside/upside correlations?**
Pearson restricted to days where at least one asset fell / rose — tail co-movement often
differs from average days ("correlation rises in crashes").

**32. Interpret beta and R².**
Beta = cov(A,B)/var(B): how strongly A moves per unit move of B. R² (= squared Pearson):
fraction of A's return variance explained by B. Both are historical descriptions.

**33. What is autocorrelation of returns measuring here?**
Whether returns echo their own recent values (lag 1, lag 5) — near-zero suggests
unpredictable short-term structure; it is also a fingerprint feature.

**34. What do skewness and kurtosis tell us about a series?**
Skewness: asymmetry of the return distribution (crash-prone vs rally-prone tails).
Kurtosis: tail fatness — higher than normal means extreme days happen more often.

**35. Are the analogue "forward outcomes" predictions?**
No. They are what historically followed similar windows — descriptive conditional
statistics, always labelled as observations with disclaimers.

**36. What are the known statistical limitations?**
Simple not log returns; no dividend/split adjustment; KMeans regimes are clusters of window
statistics, not ground truth; small samples widen everything; correlation ≠ causation;
single-asset universe (no portfolio optimization).

## Frontend

**37. How does the frontend avoid duplicate or stale requests?**
URL-keyed shared cache with per-category TTLs, single-flight dedup, stale-while-revalidate
display, explicit invalidation after mutations (upload/delete/presets).

**38. How is the bundle kept fast?**
React.lazy code splitting for the four heavy pages (main chunk 270→220 kB), recharts as the
only chart dependency, memoized heavy widgets.

**39. How does print/PDF export work?**
A dedicated print stylesheet flips to light tokens, hides chrome/buttons, relaxes overflow,
avoids page-breaks inside sections/charts, and inverts SVG fills for dark charts — triggered
via the browser's print dialog.

## Process

**40. How is the project tested?**
Six self-contained backend suites run against real MySQL via TestClient (fingerprint,
regimes, intelligence, comparison, cross-market, presets) printing PASS/FAIL per check plus
RESULT summaries; py_compile gates syntax; npm run build gates the frontend; a benchmark
harness tracks timings at 1k/5k/10k rows.

**41. Where would real deployment differ from this project?**
Authentication/authorization, connection pooling, migrations tooling instead of idempotent
DDL, object storage for files, monitoring, HTTPS/reverse proxy, CI pipelines — all
deliberately out of scope for a single-user educational build.
