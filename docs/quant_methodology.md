# QUANT VECTOR — Quantitative Methodology

This document explains every calculation the engine performs, in presentation-friendly
language. **Everything described here is a description of past data. QUANT VECTOR does not
predict markets and none of these numbers are advice.**

Conventions: `P_t` = closing price on day *t*, `r_t` = daily return,
252 trading days per year.

---

## A. Return calculations

Daily simple returns:

```
r_t = (P_t − P_{t−1}) / P_{t−1}
```

Cumulative return over the whole history: `P_last / P_first − 1`.
All correlation/regression work uses **returns**, never raw prices, so two datasets at
different price levels can be compared fairly. Non-finite values produced by bad rows
(e.g. a zero price) are dropped before any statistic is computed.

## B. Volatility and drawdown

- **Daily volatility** `σ_d` = sample standard deviation of daily returns.
- **Annualized volatility** = `σ_d × √252` (the square-root-of-time rule).
- **20-day rolling volatility** = standard deviation of the last 20 returns, annualized —
  this shows how calm or violent recent markets are.
- **Drawdown series**: `DD_t = P_t / max(P_1..P_t) − 1` — how far below the running peak we
  are. The minimum of this series is the **maximum drawdown** (worst historical loss from a
  peak).
- **CVaR 95% ("average of the worst 5% days")**: take the mean of the worst 5% of daily
  returns. Related tail figure: **VaR 95%** = the 5th-percentile daily return.

## C. Statistical fingerprint

The fingerprint is a numeric "personality profile" of one dataset, built from four families:

1. **Return characteristics** — mean/median/std of daily returns, skewness (asymmetry),
   kurtosis (fat tails), annualized volatility, min/max daily move.
2. **Risk characteristics** — maximum drawdown, average drawdown, CVaR 95%, VaR-style tails.
3. **Trend characteristics** — distance from the 20-day and 50-day moving averages
   (`P_last / MA − 1`) plus a categorical MA alignment label (API-only).
4. **Behaviour characteristics** — 20-day rolling volatility, autocorrelation of returns at
   lags 1 and 5 (do returns echo themselves?), latest volume relative to average volume.

Short histories degrade gracefully: missing context yields `None` for that metric instead of
a wrong number.

## D. Fingerprint vector

`VECTOR_FEATURES` is an ordered list of 18 numeric fingerprint metrics. For any window of
prices, the vector is simply those metrics in fixed order; unavailable entries become NaN.
This vector is what makes windows mathematically comparable.

## E. Historical analogue detection

The most recent `lookback` bars (default 60) form the **current window**. Earlier, disjoint
windows (advanced in strides of `lookback/10`) are candidate windows. Each candidate's vector
is compared to the current window's vector by Euclidean distance after standardization
(see F). Distances map monotonically onto similarity:

```
similarity = exp(−d / median(d))     ∈ (0, 1]
```

A greedy pass selects top matches while enforcing a **minimum separation** between selected
windows (`lookback/2` bars), preventing five near-identical neighbouring weeks from filling
the list. For each match, what happened *afterwards* historically (next-day through +20-day
moves) is attached as an observation — never as a forecast.

## F. Standardization

Features have wildly different scales (volatility ≈ 0.01–0.05, drawdown ≈ −0.6..0). Before
distance computations each feature column is z-scored:

```
z = (x − mean) / std        (sklearn StandardScaler)
```

For analogue search the scaler is fitted **on the historical pool only** (the current window
never influences its own scaling). Missing entries are imputed with the column median first.
For cross-dataset fingerprint comparison the reference distribution comes from pooled
sliding-window fingerprints of all compared datasets, and similarity is anchored absolutely:
`sim = 1 / (1 + d_std / √k)` — identical profiles score 1.0 regardless of dataset count.

## G. PCA

Principal Component Analysis rotates the standardized window-feature matrix onto axes of
maximum variance. The engine keeps the fewest components in [2, 10] that preserve ≥95%
cumulative explained variance (fallback threshold 85%). This removes noise/duplication
between correlated features and speeds up clustering.

## H. KMeans regime discovery

Sliding windows (default size 60, stride 15) are clustered with KMeans into k groups.
Each group becomes a "market regime" — e.g. *calm uptrend* or *high-volatility decline* —
characterized afterwards by its members' average window return, volatility, momentum,
drawdown and share of windows. `random_state=42`, `n_init=10` make runs deterministic.

## I. Cluster selection

k is chosen automatically by evaluating candidates k = 2…8 and scoring each with:

- **Silhouette score** (higher = better separated clusters), maximized;
- **Davies–Bouldin index** (lower = better), used as tie-breaker.

A user may force any explicit k; the response reports `auto_selected` accordingly so callers
know which path ran.

## J. Regime transition matrix

Ordering every window chronologically gives a sequence of regime labels. Counting pairs
(regime today → regime next window) produces a transition count matrix, normalized row-wise
into probabilities:

```
P(next = j | now = i) = count(i → j) / Σ_j' count(i → j')
```

The dashboard also shows the most common next regimes for whatever regime the market is in
right now — again, a historical frequency table, not a forecast.

## K. Regime-conditional historical outcomes

For every regime, windows assigned to it are examined for realized forward moves
(+5d, +10d, +20d): averages, medians, best/worst cases, probability of a positive +20d.
These are conditional historical summaries: *"in similar past windows, X tended to happen."*

## L. Intelligence evidence scoring

The intelligence layer fuses four independent evidence streams into scores in [−1, 1]
using bounded `tanh` transforms so no single metric can dominate:

```
trend_score    = 0.40·ma_signal + 0.30·tanh(mom20/0.03) + 0.30·tanh(mom60/0.06)
analogue_score = 0.50·tanh(mean_fwd20/0.03) + 0.25·(2·freq_fwd5−1)
               + 0.25·(2·freq_fwd20−1)
regime_score   = 0.40·tanh(avg_window_return/0.02) + 0.30·(2·positive_ratio−1)
               + 0.30·tanh(avg_momentum_20/0.05)
risk_score     = −(0.50·volatility_pressure + 0.30·drawdown_severity + 0.20·momentum_risk)
```

Weighted bias:

```
directional_bias = 0.30·trend + 0.30·analogues + w_regime·regime + 0.15·risk
```

where the regime weight starts at 0.25 and scales with the current regime-assignment
confidence, and analogues lose weight when their forward-return dispersion is high.
Contradictions (e.g. trend says up, analogues say down) are surfaced explicitly rather than
averaged away silently.

## M. Confidence calculation

Confidence ∈ [0, 1] measures how much the inputs agree and how much data backs them:

```
confidence = 0.35·agreement + 0.25·evidence_coverage + 0.20·(1 − dispersion)
           + 0.10·regime_confidence + 0.10·sample_depth
```

Low confidence is itself information: it means evidence streams disagree or samples are thin.

## N. Cross-market correlations

Two datasets' daily returns are inner-joined on shared trading dates. On the overlap:

```
Pearson   ρ = Σ(r_a − ā)(r_b − b̄) / (√Σ(r_a − ā)² · √Σ(r_b − b̄)²)
Spearman  = Pearson applied to rank-transformed returns (robust to outliers/non-linearity)
cov(a,b)  = Σ(r_a − ā)(r_b − b̄) / (n − 1)
Downside  = Pearson restricted to days where at least one asset fell
Upside    = Pearson restricted to days where at least one asset rose
```

Rolling correlations recompute Pearson inside a sliding 20- or 60-day window, producing a
time series of how co-movement evolved. Fewer than 5 overlapping observations → statistics
are reported as null with an explicit insufficient-overlap flag. **Correlation describes
co-movement; it never implies causation.**

## O. Beta / regression analysis

Ordinary least squares of asset A's returns on B's returns:

```
β (beta)      = cov(A, B) / var(B)          sensitivity of A to B's moves
intercept α   = mean(A) − β·mean(B)          reported as "residual mean per day"
R²            = squared Pearson correlation   share of A's variance explained by B
residual vol  = std(A − β·B)                  idiosyncratic daily wiggle
```

The API labels these strictly as **historical regression statistics**; alpha is never
presented as guaranteed excess return.

---

### Determinism

Fixed seeds (`random_state=42`), pure functions of stored prices, and parameter-hashed result
caching mean identical inputs always produce identical outputs — useful for demos and tests.
