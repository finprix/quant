"""Unsupervised market regime discovery for QUANT VECTOR.

Rolling market windows (from fingerprint.py) are described by scale-free
behavioural features, standardized, compressed with PCA and grouped with
KMeans. Cluster quality (silhouette, Davies-Bouldin) selects the number of
regimes automatically. Every output is derived from the uploaded data only;
transition probabilities and conditional forward outcomes are historical
descriptions, never predictions.

No NaN/inf value ever reaches scikit-learn: unusable features are dropped,
remaining gaps are median-imputed before scaling.
"""

import json

import numpy as np
import pandas as pd
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA
from sklearn.metrics import davies_bouldin_score, silhouette_score
from sklearn.preprocessing import StandardScaler

from fingerprint import (
    TRADING_DAYS_PER_YEAR,
    _safe_float,
    generate_market_windows,
)

KMEANS_RANDOM_STATE = 42
KMEANS_N_INIT = 10

# Scale-invariant window features used for regime modelling. Raw price
# levels are excluded so instruments at any price scale are comparable.
REGIME_FEATURES = [
    "mean_daily_return",
    "annualized_volatility",
    "downside_deviation",
    "max_drawdown",
    "skewness",
    "kurtosis",
    "positive_return_ratio",
    "momentum_20",
    "momentum_60",
    "distance_from_ma20",
    "distance_from_ma50",
    "autocorrelation_lag1",
    "autocorrelation_lag5",
    "volume_to_average_ratio",
]

MIN_WINDOWS = 12
PCA_MIN_EXPLAINED = 0.85
PCA_TARGET_EXPLAINED = 0.95
PCA_MIN_COMPONENTS = 2
PCA_MAX_COMPONENTS = 10
K_MIN = 2
K_MAX = 8

_DISCLAIMER = (
    "Regimes, transitions and forward outcomes are statistical descriptions "
    "of historical data. They are not predictions."
)


def prepare_feature_matrix(raw_matrix, feature_names):
    """Clean a raw window-feature matrix for unsupervised learning.

    Steps: drop columns that are entirely missing, have too few usable
    observations or are constant (zero variance carries no clustering
    information); median-impute isolated gaps; verify the result is finite.
    Returns (clean_matrix, metadata) where metadata records exactly which
    features were used and why others were excluded.
    """
    matrix = np.array(raw_matrix, dtype=float)
    if matrix.ndim != 2:
        raise ValueError("Feature matrix must be 2-dimensional.")

    keep_idx, dropped = [], []
    for j, name in enumerate(feature_names):
        column = matrix[:, j]
        known = column[np.isfinite(column)]
        if known.size == 0:
            dropped.append({"feature": name, "reason": "all values missing"})
        elif known.size < 3:
            dropped.append({"feature": name, "reason": "insufficient observations"})
        elif float(np.ptp(known)) == 0.0:
            dropped.append({"feature": name, "reason": "constant feature"})
        else:
            keep_idx.append(j)

    if len(keep_idx) < 2:
        return None, {"used": [], "dropped": dropped}

    cleaned = matrix[:, keep_idx]
    for j in range(cleaned.shape[1]):
        column = cleaned[:, j]
        known = np.isfinite(column)
        column[~known] = np.median(column[known])

    if not np.all(np.isfinite(cleaned)):
        raise ValueError("Feature preprocessing produced non-finite values.")

    used_names = [feature_names[j] for j in keep_idx]
    return cleaned, {"used": used_names, "dropped": dropped}


def fit_pca(scaled_matrix):
    """Principal component analysis on standardized regime features.

    Retains the smallest component count whose cumulative explained
    variance reaches PCA_TARGET_EXPLAINED (falling back to the count that
    reaches PCA_MIN_EXPLAINED), bounded to [2, 10] components and by the
    available dimensions. Reports the full variance curve, loadings of the
    retained components and per-window coordinates.
    """
    full = PCA(svd_solver="full").fit(scaled_matrix)
    ratios = [float(r) for r in full.explained_variance_ratio_]
    cumulative = np.cumsum(ratios)

    max_allowed = min(
        PCA_MAX_COMPONENTS,
        scaled_matrix.shape[1],
        scaled_matrix.shape[0],
    )
    chosen = max_allowed
    for count, cum in enumerate(cumulative[:max_allowed], start=1):
        if cum >= PCA_TARGET_EXPLAINED:
            chosen = count
            break
    else:
        for count, cum in enumerate(cumulative[:max_allowed], start=1):
            if cum >= PCA_MIN_EXPLAINED:
                chosen = count
                break
    chosen = max(chosen, min(PCA_MIN_COMPONENTS, max_allowed))

    pca = PCA(n_components=int(chosen), svd_solver="full").fit(scaled_matrix)
    coordinates = pca.transform(scaled_matrix)

    return {
        "n_components": int(chosen),
        "explained_variance_ratio": ratios,
        "cumulative_explained_variance": [float(c) for c in cumulative],
        "variance_target_met": bool(
            cumulative[chosen - 1] >= PCA_MIN_EXPLAINED - 1e-9
        ),
        "loadings": [[float(v) for v in row] for row in pca.components_],
        "coordinates": [[float(v) for v in row] for row in coordinates],
    }


def select_k(scaled_matrix, k=None):
    """Choose the number of regimes via internal cluster quality metrics.

    Evaluates every candidate k in [2, 8] (bounded by sample count) with
    KMeans(fixed random_state). Best k maximizes the silhouette score; ties
    break on lower Davies-Bouldin, then smaller k. A user-supplied k is
    validated and honoured instead.
    """
    n_samples = scaled_matrix.shape[0]
    k_max_effective = min(K_MAX, n_samples - 1)

    evaluations = []
    for candidate in range(K_MIN, k_max_effective + 1):
        model = KMeans(
            n_clusters=candidate,
            random_state=KMEANS_RANDOM_STATE,
            n_init=KMEANS_N_INIT,
        ).fit(scaled_matrix)
        evaluations.append(
            {
                "k": int(candidate),
                "silhouette": float(silhouette_score(scaled_matrix, model.labels_)),
                "davies_bouldin": float(davies_bouldin_score(scaled_matrix, model.labels_)),
                "inertia": float(model.inertia_),
            }
        )

    auto_selected = k is None
    if k is None:
        best = sorted(
            evaluations,
            key=lambda e: (-e["silhouette"], e["davies_bouldin"], e["k"]),
        )[0]
        selected = best["k"]
    else:
        selected = int(k)
        if selected < K_MIN or selected > k_max_effective:
            selected = min(max(selected, K_MIN), k_max_effective)

    return int(selected), auto_selected, evaluations


def _mean_of(values):
    """Arithmetic mean ignoring None entries; None when nothing remains."""
    known = [float(v) for v in values if v is not None]
    return float(np.mean(known)) if known else None


def characterize_regime(profile_metrics, global_medians):
    """Deterministically label a regime from its statistics.

    Priority ladder: severe drawdown -> stress wording; volatility relative
    to the dataset median picks Low/High/Moderate; return sign picks
    Bullish/Bearish/Flat; significant negative lag-1 autocorrelation marks
    mean reversion; otherwise mixed/transition wording.
    """
    vol_ratio = profile_metrics["volatility"] / global_medians["volatility"]
    ret = profile_metrics["avg_window_return"]
    drawdown = profile_metrics["max_drawdown"]
    autocorr = profile_metrics["avg_autocorrelation_lag1"]
    momentum = profile_metrics["avg_momentum_20"]

    if vol_ratio >= 1.4:
        vol_word = "High Volatility"
    elif vol_ratio <= 0.7:
        vol_word = "Low Volatility"
    else:
        vol_word = "Moderate Volatility"

    if drawdown is not None and drawdown <= -0.12:
        direction_word = "Stress / Drawdown"
    elif ret is not None and ret > 0.02:
        direction_word = "Bullish" if momentum is None or momentum >= 0 else "Bullish / Fading"
    elif ret is not None and ret < -0.02:
        direction_word = "Bearish"
    elif momentum is not None and momentum > 0.03:
        direction_word = "High Momentum Bullish"
    elif momentum is not None and momentum < -0.03:
        direction_word = "High Momentum Bearish"
    else:
        direction_word = "Sideways"

    if direction_word == "Sideways" and autocorr is not None and autocorr < -0.05:
        direction_word = "Sideways / Mean-Reverting"
    if abs(ret or 0.0) <= 0.005 and abs(momentum or 0.0) <= 0.01:
        direction_word = f"{direction_word} Transition / Mixed" if direction_word == "Sideways" else direction_word

    return f"{vol_word} {direction_word}".strip()


def _aggregate_profile(windows, indices, stride):
    """Average the behavioural metrics across all windows of one regime."""
    feature_rows = [windows[i]["features"] for i in indices]

    def avg(feature):
        return _mean_of(row.get(feature) for row in feature_rows)

    metrics = {
        "avg_window_return": avg("mean_daily_return"),
        "volatility": avg("annualized_volatility"),
        "downside_deviation": avg("downside_deviation"),
        "max_drawdown": avg("max_drawdown"),
        "skewness": avg("skewness"),
        "kurtosis": avg("kurtosis"),
        "positive_return_ratio": avg("positive_return_ratio"),
        "avg_momentum_20": avg("momentum_20"),
        "avg_momentum_60": avg("momentum_60"),
        "avg_distance_from_ma20": avg("distance_from_ma20"),
        "avg_distance_from_ma50": avg("distance_from_ma50"),
        "avg_autocorrelation_lag1": avg("autocorrelation_lag1"),
        "avg_autocorrelation_lag5": avg("autocorrelation_lag5"),
        "avg_relative_volume": avg("volume_to_average_ratio"),
    }

    # Persistence: length of consecutive same-regime runs, expressed both in
    # windows and approximately in trading days via the window stride.
    runs, current_run = [], 1
    for prev, curr in zip(indices[:-1], indices[1:]):
        if curr == prev + 1:
            current_run += 1
        else:
            runs.append(current_run)
            current_run = 1
    runs.append(current_run)

    return {
        "metrics": metrics,
        "avg_duration_windows": _safe_float(float(np.mean(runs))),
        "approx_avg_duration_trading_days": _safe_float(float(np.mean(runs)) * stride),
    }


def regime_forward_outcomes(close, high, low, end_indices, horizons=(5, 10, 20)):
    """Historical conditional forward statistics for a set of windows.

    Only windows whose end index leaves room for the full horizon are used,
    so no unavailable future data can leak into the aggregates.
    """
    n = len(close)
    base = close.to_numpy(dtype=float) if isinstance(close, pd.Series) else close
    eligible = [int(e) for e in end_indices if int(e) + max(horizons) <= n - 1]
    if not eligible:
        return {
            "available": False,
            "samples_with_full_horizon": 0,
            "note": "No windows have enough future data for outcome statistics.",
        }

    def forward(index_set, h):
        return [
            float(base[e + h] / base[e] - 1.0) for e in index_set if e + h <= n - 1
        ]

    full_h = max(horizons)
    r20 = [float(base[e + full_h] / base[e] - 1.0) for e in eligible]
    r20_array = np.array(r20)

    return {
        "available": True,
        "samples_with_full_horizon": len(eligible),
        "avg_return_after_5_days": _safe_float(np.mean(forward(eligible, 5)))
        if any(e + 5 <= n - 1 for e in eligible)
        else None,
        "avg_return_after_10_days": _safe_float(np.mean(forward(eligible, 10)))
        if any(e + 10 <= n - 1 for e in eligible)
        else None,
        "probability_positive_after_20_days": _safe_float((r20_array > 0).mean()),
        "median_return_after_20_days": _safe_float(np.median(r20_array)),
        "average_return_after_20_days": _safe_float(np.mean(r20_array)),
        "worst_return_after_20_days": _safe_float(np.min(r20_array)),
        "best_return_after_20_days": _safe_float(np.max(r20_array)),
        "note": _DISCLAIMER,
    }


def discover_regimes(df, window_size=60, stride=None, k=None):
    """Full unsupervised regime analysis of one OHLCV history.

    Pipeline: rolling windows (fingerprint.py) -> feature matrix ->
    cleaning/imputation -> StandardScaler -> PCA (85-95% variance target)
    -> KMeans with automatic k selection -> characterization, timeline,
    transition matrix and regime-conditional historical outcomes.
    """
    if window_size < 20:
        raise ValueError("window_size must be >= 20 trading days.")
    if stride is None:
        stride = max(1, window_size // 4)

    windows = generate_market_windows(df, window_size=window_size, stride=stride)
    if len(windows) < MIN_WINDOWS or len(df) < 2 * window_size:
        return {
            "available": False,
            "message": (
                f"Not enough history for regime discovery: {len(windows)} "
                f"{window_size}-day windows found (need at least {MIN_WINDOWS})."
            ),
            "window_size": int(window_size),
            "stride": int(stride),
        }

    raw = np.array(
        [[row["features"].get(name) for name in REGIME_FEATURES] for row in windows],
        dtype=float,
    )
    clean, feature_meta = prepare_feature_matrix(raw, REGIME_FEATURES)
    if clean is None:
        return {
            "available": False,
            "message": "Fewer than two usable regime features; cannot cluster.",
            "features": feature_meta,
        }

    scaler = StandardScaler()
    scaled = scaler.fit_transform(clean)
    if not np.all(np.isfinite(scaled)):
        raise ValueError("Standardization produced non-finite values.")

    pca_result = fit_pca(scaled)
    selected_k, auto_selected, quality = select_k(scaled, k=k)

    final_model = KMeans(
        n_clusters=selected_k,
        random_state=KMEANS_RANDOM_STATE,
        n_init=KMEANS_N_INIT,
    ).fit(scaled)
    labels = [int(x) for x in final_model.labels_]
    distances = final_model.transform(scaled)

    # Softmax over negative centroid distances gives a probability-like
    # confidence for each window's assignment.
    confidences = []
    for row in distances:
        shifted = row - row.min()
        weights = np.exp(-shifted)
        confidences.append(float(weights[int(np.argmin(row))] / weights.sum()))

    members = {rid: [] for rid in range(selected_k)}
    for idx, rid in enumerate(labels):
        members[rid].append(idx)

    all_features = [w["features"] for w in windows]
    global_medians = {
        "volatility": float(
            np.median([f["annualized_volatility"] or 0.0 for f in all_features])
        )
    }
    global_medians["volatility"] = global_medians["volatility"] or 1.0

    profiles = []
    for rid in range(selected_k):
        agg = _aggregate_profile(windows, members[rid], stride)
        profile = {
            "regime_id": rid,
            "label": characterize_regime(agg["metrics"], global_medians),
            "window_count": len(members[rid]),
            "percentage_of_windows": _safe_float(len(members[rid]) / len(windows)),
            **agg["metrics"],
            "avg_duration_windows": agg["avg_duration_windows"],
            "approx_avg_duration_trading_days": agg["approx_avg_duration_trading_days"],
            "forward_outcomes": regime_forward_outcomes(
                df["Close"],
                df["High"],
                df["Low"],
                [windows[i]["end_index"] for i in members[rid]],
            ),
        }
        profiles.append(profile)

    timeline = []
    for idx, window in enumerate(windows):
        rid = labels[idx]
        profile = profiles[rid]
        timeline.append(
            {
                "start_date": window["start_date"],
                "end_date": window["end_date"],
                "window_end_index": int(window["end_index"]),
                "regime_id": rid,
                "regime_label": profile["label"],
                "pca_coordinates": pca_result["coordinates"][idx],
                "distance_to_centroid": _safe_float(distances[idx][rid]),
                "confidence": _safe_float(confidences[idx]),
            }
        )

    transitions = _transition_matrix(timeline, profiles)
    current_block = _current_regime_block(timeline, profiles, transitions, stride)

    return {
        "available": True,
        "window_size": int(window_size),
        "stride": int(stride),
        "n_windows": int(len(windows)),
        "features": feature_meta,
        "model": {
            "algorithm": "KMeans",
            "random_state": KMEANS_RANDOM_STATE,
            "n_init": KMEANS_N_INIT,
            "selected_k": int(selected_k),
            "auto_selected": bool(auto_selected),
            "requested_k": None if k is None else int(k),
            "silhouette": _best_quality(quality, selected_k, "silhouette"),
            "davies_bouldin": _best_quality(quality, selected_k, "davies_bouldin"),
            "quality_by_k": quality,
        },
        "pca": {
            "method": "PCA (full SVD), variance target 85-95%",
            "n_components": pca_result["n_components"],
            "explained_variance_ratio": pca_result["explained_variance_ratio"],
            "cumulative_explained_variance": pca_result[
                "cumulative_explained_variance"
            ],
            "variance_target_met": pca_result["variance_target_met"],
            "loadings_features": feature_meta["used"],
            "loadings": pca_result["loadings"],
        },
        "regimes": profiles,
        "timeline": timeline,
        "transitions": transitions,
        "current_regime": current_block,
        "disclaimer": _DISCLAIMER,
    }


def _best_quality(quality, selected_k, metric):
    for entry in quality:
        if entry["k"] == selected_k:
            return entry[metric]
    return None


def _transition_matrix(timeline, profiles):
    """Empirical transition counts/probabilities between consecutive windows."""
    ids = sorted({entry["regime_id"] for entry in timeline})
    position = {rid: pos for pos, rid in enumerate(ids)}
    size = len(ids)
    counts = [[0] * size for _ in range(size)]

    for prev, curr in zip(timeline[:-1], timeline[1:]):
        counts[position[prev["regime_id"]]][position[curr["regime_id"]]] += 1

    probabilities = []
    for row in counts:
        total = sum(row)
        probabilities.append([round(c / total, 6) for c in row] if total else [0.0] * size)

    label_of = {profile["regime_id"]: profile["label"] for profile in profiles}
    return {
        "regime_ids": [int(rid) for rid in ids],
        "labels": [label_of.get(rid) for rid in ids],
        "counts": counts,
        "probabilities": probabilities,
        "note": _DISCLAIMER,
    }


def _current_regime_block(timeline, profiles, transitions, stride):
    """Current regime summary from the most recent valid window."""
    last = timeline[-1]
    streak_windows = 0
    for entry in reversed(timeline):
        if entry["regime_id"] != last["regime_id"]:
            break
        streak_windows += 1

    profile = next(p for p in profiles if p["regime_id"] == last["regime_id"])
    position = transitions["regime_ids"].index(last["regime_id"])
    probs = transitions["probabilities"][position]
    counts = transitions["counts"][position]

    ranked = sorted(zip(transitions["regime_ids"], probs, counts), key=lambda x: -x[1])
    top_next = [
        {
            "regime_id": int(rid),
            "label": next(p["label"] for p in profiles if p["regime_id"] == rid),
            "historical_probability": prob,
            "historical_count": count,
        }
        for rid, prob, count in ranked[:3]
    ]

    return {
        "regime_id": last["regime_id"],
        "label": last["regime_label"],
        "confidence": last["confidence"],
        "distance_to_centroid": last["distance_to_centroid"],
        "window": {
            "start_date": last["start_date"],
            "end_date": last["end_date"],
        },
        "duration_windows": streak_windows,
        "approx_duration_trading_days": int(streak_windows * stride),
        "profile_summary": {
            "avg_window_return": profile["avg_window_return"],
            "volatility": profile["volatility"],
            "max_drawdown": profile["max_drawdown"],
            "percentage_of_windows": profile["percentage_of_windows"],
        },
        "most_common_next_regimes": top_next,
        "note": _DISCLAIMER,
    }


def summarize_for_persistence(result):
    """Compact JSON-safe snapshot stored alongside the assignments."""
    payload = {key: value for key, value in result.items() if key != "timeline"}
    return json.loads(json.dumps(payload, default=str))
