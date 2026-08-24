"""Statistical market fingerprinting for QUANT VECTOR.

A "fingerprint" condenses a price history into scale-free behavioural
statistics (return distribution, risk, trend alignment, serial memory,
relative activity) so instruments can be compared regardless of their
absolute price level.

All public functions expect a cleaned OHLCV DataFrame with columns
Date, Open, High, Low, Close, Volume sorted chronologically. Metrics that
cannot be computed due to insufficient history are returned as None, and
no NaN/inf values ever leave this module.
"""

import math

import numpy as np
import pandas as pd
from scipy import stats as scipy_stats
from sklearn.preprocessing import StandardScaler
from statsmodels.tsa.stattools import acf

from analytics import TRADING_DAYS_PER_YEAR, _safe_float


# Scale-free features describing market behaviour. Absolute price-derived
# levels (Close, MA20, MA50 values) are deliberately excluded so that
# instruments trading at different price scales remain comparable.
VECTOR_FEATURES = [
    "mean_daily_return",
    "annualized_volatility",
    "downside_deviation",
    "volatility_20d",
    "skewness",
    "kurtosis",
    "positive_return_ratio",
    "negative_return_ratio",
    "max_drawdown",
    "avg_drawdown",
    "cvar_95",
    "momentum_20",
    "momentum_60",
    "distance_from_ma20",
    "distance_from_ma50",
    "autocorrelation_lag1",
    "autocorrelation_lag5",
    "volume_to_average_ratio",
]

# Headline characteristics reported alongside every historical analogue.
MATCH_KEYS = [
    "annualized_volatility",
    "volatility_20d",
    "momentum_20",
    "momentum_60",
    "max_drawdown",
    "skewness",
    "autocorrelation_lag1",
    "distance_from_ma50",
]

_OBSERVATION_NOTE = (
    "Historical observation of what followed a statistically similar period; "
    "descriptive, not a prediction."
)


def dataframe_from_price_records(records):
    """Convert stored price dictionaries into the canonical OHLCV frame."""
    frame = pd.DataFrame(records).rename(
        columns={
            "date": "Date",
            "open": "Open",
            "high": "High",
            "low": "Low",
            "close": "Close",
            "volume": "Volume",
        }
    )
    frame["Date"] = pd.to_datetime(frame["Date"])
    return frame.sort_values("Date").reset_index(drop=True)


def _return_characteristics(close):
    """Distributional properties of daily simple returns.

    Historical VaR/CVaR at 95% use the empirical 5% quantile; they are
    suppressed until the return sample is large enough (>= 60) for the
    tail estimate to be meaningful.
    """
    returns = close.pct_change().dropna()
    n = len(returns)

    def percentile_or_none(q):
        return float(np.percentile(returns, q)) if n >= 60 else None

    return {
        "mean_daily_return": _safe_float(returns.mean()),
        "median_daily_return": _safe_float(returns.median()),
        "std_daily_return": _safe_float(returns.std(ddof=1)),
        "annualized_volatility": _safe_float(returns.std(ddof=1) * math.sqrt(TRADING_DAYS_PER_YEAR)) if n >= 2 else None,
        "skewness": _safe_float(scipy_stats.skew(returns)) if n >= 3 else None,
        "kurtosis": _safe_float(scipy_stats.kurtosis(returns)) if n >= 4 else None,
        "positive_return_ratio": _safe_float((returns > 0).mean()) if n >= 1 else None,
        "negative_return_ratio": _safe_float((returns < 0).mean()) if n >= 1 else None,
        "best_daily_return": _safe_float(returns.max()) if n >= 1 else None,
        "worst_daily_return": _safe_float(returns.min()) if n >= 1 else None,
        "var_95": percentile_or_none(5),
        "cvar_95": _safe_float(returns[returns <= np.percentile(returns, 5)].mean())
        if n >= 60
        else None,
    }


def _risk_characteristics(close, returns):
    """Drawdown profile and tail-risk measures.

    Drawdown(t) = Close(t) / running_max(Close) - 1.
    Downside deviation annualizes sqrt(mean(r^2 | r < 0)) with sqrt(252).
    VaR/CVaR are historical (empirical-quantile based) at the 95% level.
    """
    running_max = close.cummax()
    drawdown = close / running_max - 1.0

    negative_drawdowns = drawdown[drawdown < 0]
    losses = returns[returns < 0]

    downside_deviation = (
        math.sqrt(float(np.mean(np.square(losses))) ) * math.sqrt(TRADING_DAYS_PER_YEAR)
        if len(losses) >= 1
        else None
    )

    return {
        "max_drawdown": _safe_float(drawdown.min()) if len(drawdown) >= 1 else None,
        "avg_drawdown": _safe_float(negative_drawdowns.mean()) if len(negative_drawdowns) >= 1 else 0.0,
        "downside_deviation": _safe_float(downside_deviation),
    }


def _trend_characteristics(close):
    """Moving-average alignment and momentum of the most recent bar."""
    last = close.iloc[-1]

    ma20_series = close.rolling(window=20, min_periods=20).mean()
    ma50_series = close.rolling(window=50, min_periods=50).mean()

    ma20 = ma20_series.iloc[-1] if len(close) >= 20 else np.nan
    ma50 = ma50_series.iloc[-1] if len(close) >= 50 else np.nan

    if np.isfinite(ma20) and np.isfinite(ma50) and ma50 != 0:
        ratio = float(ma20 / ma50)
        relationship = "above" if ratio > 1.0 else "below" if ratio < 1.0 else "equal"
    else:
        ratio = None
        relationship = "insufficient_data"

    return {
        "ma20": _safe_float(ma20),
        "ma50": _safe_float(ma50),
        "ma20_ma50_ratio": _safe_float(ratio),
        "ma20_ma50_relationship": relationship,
        "distance_from_ma20": _safe_float(last / ma20 - 1.0) if np.isfinite(ma20) and ma20 != 0 else None,
        "distance_from_ma50": _safe_float(last / ma50 - 1.0) if np.isfinite(ma50) and ma50 != 0 else None,
        "momentum_20": _safe_float(last / close.iloc[-21] - 1.0) if len(close) >= 21 else None,
        "momentum_60": _safe_float(last / close.iloc[-61] - 1.0) if len(close) >= 61 else None,
    }


def _behaviour_characteristics(close, volume):
    """Rolling volatility, return serial correlation and relative activity.

    Autocorrelations are estimated with the standard ACF estimator;
    they measure short-term memory of returns.
    """
    returns = close.pct_change().dropna()
    n = len(returns)

    vol20 = (
        returns.rolling(window=20, min_periods=20).std(ddof=1).iloc[-1]
        * math.sqrt(TRADING_DAYS_PER_YEAR)
        if n >= 20
        else np.nan
    )

    avg_volume = float(volume.mean()) if len(volume) >= 1 else np.nan

    return {
        "volatility_20d": _safe_float(vol20),
        "autocorrelation_lag1": _safe_float(acf(returns, nlags=1, fft=False)[1])
        if n >= 10
        else None,
        # ~8 observations per lag before an ACF estimate is reported.
        "autocorrelation_lag5": _safe_float(acf(returns, nlags=5, fft=False)[5])
        if n >= 40
        else None,
        "volume_mean": _safe_float(avg_volume) if np.isfinite(avg_volume) else None,
        "volume_std": _safe_float(volume.std(ddof=1)) if len(volume) >= 2 else None,
        "volume_to_average_ratio": _safe_float(volume.iloc[-1] / avg_volume)
        if np.isfinite(avg_volume) and avg_volume > 0
        else None,
    }


def calculate_fingerprint(df):
    """Compute the full statistical fingerprint of an OHLCV history.

    Combines four families of statistics: return-distribution moments,
    drawdown/tail risk, moving-average trend alignment, and market-behaviour
    measures (rolling volatility, autocorrelation, relative volume).
    Missing history yields None for the affected metrics.
    """
    close = df["Close"].astype(float)
    volume = df["Volume"].astype(float)
    returns = close.pct_change().dropna()

    fingerprint = {}
    fingerprint.update(_return_characteristics(close))
    fingerprint.update(_risk_characteristics(close, returns))
    fingerprint.update(_trend_characteristics(close))
    fingerprint.update(_behaviour_characteristics(close, volume))

    fingerprint["sample_count"] = int(len(close))
    fingerprint["return_sample_count"] = int(len(returns))
    return {key: value for key, value in fingerprint.items()}


def _vector_from_fingerprint(fingerprint):
    """Project an existing fingerprint dict onto VECTOR_FEATURES order."""
    return np.array(
        [
            float(fingerprint[name]) if fingerprint.get(name) is not None else np.nan
            for name in VECTOR_FEATURES
        ],
        dtype=float,
    )


def build_fingerprint_vector(df):
    """Build the ML-ready feature vector for a price history.

    Returns a float ndarray aligned with VECTOR_FEATURES. Positions whose
    underlying metric is unavailable are np.nan; callers comparing multiple
    histories should impute (see _impute_matrix) before scaling.
    """
    return _vector_from_fingerprint(calculate_fingerprint(df))


def _impute_matrix(matrix):
    """Replace NaN entries with the column median (0 if a column is empty)."""
    matrix = np.array(matrix, dtype=float, copy=True)
    for col in range(matrix.shape[1]):
        column = matrix[:, col]
        known = column[np.isfinite(column)]
        if known.size:
            column[~np.isfinite(column)] = np.median(known)
        else:
            column[:] = 0.0
    return matrix


def generate_market_windows(df, window_size=60, stride=5):
    """Slice history into overlapping rolling windows and fingerprint each.

    Window t covers trades [t - window_size + 1, t]; consecutive windows are
    advanced by `stride` bars to bound redundancy. Every window keeps its
    date span, fingerprint vector and headline statistics.
    """
    if window_size < 2 or stride < 1:
        raise ValueError("window_size must be >= 2 and stride >= 1.")

    n = len(df)
    if n < window_size:
        return []

    windows = []
    for end_idx in range(window_size - 1, n, stride):
        start_idx = end_idx - window_size + 1
        window = df.iloc[start_idx : end_idx + 1]
        fingerprint = calculate_fingerprint(window)
        windows.append(
            {
                "start_index": int(start_idx),
                "end_index": int(end_idx),
                "start_date": window["Date"].iloc[0].strftime("%Y-%m-%d"),
                "end_date": window["Date"].iloc[-1].strftime("%Y-%m-%d"),
                "window_return": _safe_float(
                    window["Close"].iloc[-1] / window["Close"].iloc[0] - 1.0
                ),
                "features": {name: fingerprint.get(name) for name in VECTOR_FEATURES},
                "vector": [
                    _safe_float(fingerprint.get(name)) for name in VECTOR_FEATURES
                ],
            }
        )
    return windows


def find_historical_analogues(
    df,
    lookback=60,
    top_n=5,
    min_separation=None,
    future_horizon=20,
):
    """Locate past windows whose market behaviour resembles the recent one.

    Method: the most recent `lookback` bars form the current window; earlier
    disjoint windows are fingerprinted, z-scored with StandardScaler fitted
    on the historical pool only, and ranked by Euclidean distance to the
    current window. Similarity maps distance monotonically onto (0, 1] via
    sim = exp(-d / median(d)). Greedy temporal suppression (minimum bar gap
    between chosen windows) prevents clustered, redundant matches. When
    future bars exist for a matched window, the realized forward moves are
    attached as historical observations, not predictions.
    """
    n = len(df)
    if lookback < 2 or top_n < 1:
        raise ValueError("lookback must be >= 2 and top_n >= 1.")
    if min_separation is None:
        min_separation = max(1, lookback // 2)

    if n < 2 * lookback:
        return {
            "lookback": lookback,
            "window_stride": max(1, lookback // 10),
            "current_window": None,
            "candidates_evaluated": 0,
            "analogues": [],
            "message": (
                f"Need at least {2 * lookback} rows to compare a "
                f"{lookback}-day window against history; got {n}."
            ),
        }

    stride = max(1, lookback // 10)
    current_start_idx = n - lookback

    current = df.iloc[current_start_idx:n]
    current_vector = build_fingerprint_vector(current)

    candidates = []
    for end_idx in range(lookback - 1, current_start_idx, stride):
        start_idx = end_idx - lookback + 1
        window = df.iloc[start_idx : end_idx + 1]
        # One fingerprint per candidate serves BOTH the feature vector and
        # the reported characteristics (previously computed twice).
        window_fingerprint = calculate_fingerprint(window)
        candidates.append(
            {
                "start_index": int(start_idx),
                "end_index": int(end_idx),
                "start_date": window["Date"].iloc[0].strftime("%Y-%m-%d"),
                "end_date": window["Date"].iloc[-1].strftime("%Y-%m-%d"),
                "vector": _vector_from_fingerprint(window_fingerprint),
                "fingerprint": window_fingerprint,
            }
        )

    matrix = _impute_matrix(np.vstack([c["vector"] for c in candidates]))
    scaler = StandardScaler()
    scaled_candidates = scaler.fit_transform(matrix)
    scaled_current = scaler.transform(
        _impute_matrix(current_vector.reshape(1, -1))
    )[0]

    distances = np.linalg.norm(scaled_candidates - scaled_current, axis=1)
    order = np.argsort(distances)
    distance_scale = float(np.median(distances)) if distances.size else 0.0

    selected = []
    for idx in order:
        cand = candidates[int(idx)]
        if any(abs(cand["end_index"] - s["end_index"]) < min_separation for s in selected):
            continue
        cand["distance"] = float(distances[idx])
        cand["similarity_score"] = float(
            np.exp(-distances[idx] / (distance_scale + 1e-12))
        )
        selected.append(cand)
        if len(selected) >= top_n:
            break

    close = df["Close"].astype(float).to_numpy()
    high = df["High"].astype(float).to_numpy()
    low = df["Low"].astype(float).to_numpy()

    analogues = []
    for rank, cand in enumerate(selected, start=1):
        end_idx = cand["end_index"]
        analogues.append(
            {
                "rank": rank,
                "start_date": cand["start_date"],
                "end_date": cand["end_date"],
                "distance": _safe_float(cand["distance"]),
                "similarity_score": _safe_float(cand["similarity_score"]),
                "characteristics": {
                    key: _safe_float(cand["fingerprint"].get(key)) for key in MATCH_KEYS
                },
                "subsequent_market_action": _future_outcomes(
                    close, high, low, end_idx, future_horizon
                ),
            }
        )

    return {
        "lookback": lookback,
        "window_stride": stride,
        "current_window": {
            "start_date": current["Date"].iloc[0].strftime("%Y-%m-%d"),
            "end_date": current["Date"].iloc[-1].strftime("%Y-%m-%d"),
        },
        "candidates_evaluated": int(len(candidates)),
        "analogues": analogues,
    }


def _future_outcomes(close, high, low, end_idx, horizon):
    """Realized forward moves after a historical window (observational)."""
    n = len(close)
    if end_idx + 1 >= n:
        return {
            "available": False,
            "observation_days": 0,
            "note": "No future data exists after this historical window.",
        }

    observed = min(horizon, n - 1 - end_idx)
    base = close[end_idx]

    def forward_return(k):
        if end_idx + k < n:
            return _safe_float(close[end_idx + k] / base - 1.0)
        return None

    future_high = high[end_idx + 1 : end_idx + 1 + observed]
    future_low = low[end_idx + 1 : end_idx + 1 + observed]

    return {
        "available": True,
        "observation_days": int(observed),
        "return_after_5_days": forward_return(5),
        "return_after_10_days": forward_return(10),
        "return_after_20_days": forward_return(20),
        "max_favourable_move_20d": _safe_float(future_high.max() / base - 1.0),
        "max_adverse_move_20d": _safe_float(future_low.min() / base - 1.0),
        "note": _OBSERVATION_NOTE,
    }


def _comparison_reference(frames_by_id, window_size=60):
    """Build a pooled reference distribution from sliding-window fingerprints.

    Each dataset contributes the same rolling windows the analogue engine
    uses. Pooling them yields a per-feature centre (median) and scale
    (standard deviation) that do not depend on how many datasets are being
    compared, keeping standardized distances meaningful even for a pair.
    """
    rows = []
    for frame in frames_by_id.values():
        windows = generate_market_windows(
            frame,
            window_size=min(window_size, max(20, len(frame) - 1)),
            stride=max(5, min(window_size, len(frame)) // 8),
        )
        for window in windows:
            rows.append([float(v) if v is not None else np.nan for v in window["vector"]])

    matrix = np.array(rows, dtype=float)
    if matrix.shape[0] < 8:
        return None

    matrix = _impute_matrix(matrix)
    centre = np.median(matrix, axis=0)
    scale = matrix.std(axis=0, ddof=0)
    usable = scale > 1e-12
    return {
        "centre": centre,
        "scale": np.where(usable, scale, 1.0),
        "usable_mask": usable,
        "usable_count": int(np.count_nonzero(usable)),
        "reference_windows": int(matrix.shape[0]),
        "window_size": int(window_size),
    }


def pairwise_fingerprint_comparison(vectors_by_id, reference):
    """Compare full-history fingerprint vectors across two to four datasets.

    ``vectors_by_id`` maps dataset id -> ndarray aligned with VECTOR_FEATURES.
    All features are price-scale-free (returns, ratios, moments), so raw
    Euclidean distance is meaningful. Standardized distance measures each
    dataset's separation in units of the pooled sliding-window reference
    distribution, so features with different natural dispersion contribute
    equally without the comparison set defining its own yardstick.

    Similarity is anchored absolutely: sim = 1 / (1 + d_std / sqrt(k)), i.e.
    1.0 for identical fingerprints and 0.5 when two fingerprints sit sqrt(k)
    reference-standard-deviations apart (roughly one pooled std per feature).
    """
    ids = list(vectors_by_id.keys())
    if len(ids) < 2:
        raise ValueError("At least two fingerprint vectors are required.")

    raw = _impute_matrix(np.vstack([np.asarray(vectors_by_id[i], dtype=float) for i in ids]))

    size = len(ids)
    euclidean = [[0.0] * size for _ in range(size)]
    for a in range(size):
        for b in range(a + 1, size):
            distance = float(np.linalg.norm(raw[a] - raw[b]))
            euclidean[a][b] = euclidean[b][a] = _safe_float(distance)

    if reference is not None and reference["usable_count"] >= 3:
        centred = (raw - reference["centre"]) / reference["scale"]
        centred[:, ~reference["usable_mask"]] = 0.0
        divisor = math.sqrt(reference["usable_count"])
    else:
        # Degenerate reference: fall back to raw space with unit weighting.
        centred = raw
        divisor = math.sqrt(max(1, raw.shape[1]))

    standardized = [[0.0] * size for _ in range(size)]
    similarity = [[0.0] * size for _ in range(size)]
    for a in range(size):
        similarity[a][a] = 1.0
        for b in range(a + 1, size):
            distance = float(np.linalg.norm(centred[a] - centred[b]))
            standardized[a][b] = standardized[b][a] = _safe_float(distance)
            score = 1.0 / (1.0 + distance / divisor)
            similarity[a][b] = similarity[b][a] = _safe_float(score)

    pairs = []
    for a in range(size):
        for b in range(a + 1, size):
            pairs.append(
                {
                    "dataset_a": ids[a],
                    "dataset_b": ids[b],
                    "euclidean_distance": euclidean[a][b],
                    "standardized_distance": standardized[a][b],
                    "similarity_score": similarity[a][b],
                }
            )

    payload = {
        "pair_count": len(pairs),
        "pairs": pairs,
        "matrix": {
            "ids": [int(i) for i in ids],
            "euclidean": euclidean,
            "standardized": standardized,
            "similarity": similarity,
        },
    }
    if reference is not None:
        payload["reference"] = {
            "method": (
                "Features standardized against the pooled sliding-window "
                "fingerprint distribution of the compared datasets."
            ),
            "reference_windows": reference["reference_windows"],
            "usable_features": reference["usable_count"],
            "total_features": len(VECTOR_FEATURES),
        }
    else:
        payload["reference"] = {
            "method": "Not enough overlapping history for a window-based reference; raw feature space used.",
            "reference_windows": 0,
            "usable_features": 0,
            "total_features": len(VECTOR_FEATURES),
        }
    return payload
