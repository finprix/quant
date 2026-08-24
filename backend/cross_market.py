"""Cross-market statistical analysis for QUANT VECTOR.

All statistics operate on DAILY PERCENT RETURNS derived from close prices,
never on raw price levels. Series from different datasets are inner-joined
on their shared trading dates, so mismatched calendars, missing dates and
non-overlapping ranges are handled explicitly:

- Mismatched date ranges: only the overlapping span is analysed and the
  overlap start/end is reported.
- Missing dates: dates absent from either series simply do not appear in
  the joined frame (no forward filling - gaps stay gaps).
- Insufficient overlap: correlations/regression are reported as null
  instead of unreliable numbers; the observation count is always returned.
- NaN/inf: returns are sanitised (non-finite values dropped) before any
  statistic is computed.

Nothing here implies causation; every number is a historical description.
"""

import math

import numpy as np
import pandas as pd

# Minimum paired observations before a plain correlation/covariance is
# considered meaningful. Below this, values are reported as null.
MIN_OVERLAP_FOR_CORRELATION = 5
# Minimum masked observations for conditional (down/up-side) correlations.
MIN_OVERLAP_FOR_CONDITIONAL = 8
# Rolling windows required by the spec.
ROLLING_WINDOWS = (20, 60)
# Cap for scatter points returned to the frontend (evenly downsampled).
MAX_SCATTER_POINTS = 3000


def daily_returns_from_frame(frame):
    """Return a clean daily-return Series indexed by normalized date."""
    close = (
        frame.assign(Date=pd.to_datetime(frame["Date"]))
        .drop_duplicates(subset="Date", keep="last")
        .set_index("Date")["Close"]
        .astype(float)
        .sort_index()
    )
    returns = close.pct_change()
    returns = returns.replace([np.inf, -np.inf], np.nan).dropna()
    returns.index = pd.to_datetime(returns.index).normalize()
    return returns


def _finite(value):
    """Convert a float to a JSON-safe value (None when not finite)."""
    if value is None:
        return None
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def _safe_correlation(x, y, method="pearson"):
    """Pearson/Spearman between two equal-length arrays, None when unsafe."""
    if len(x) < MIN_OVERLAP_FOR_CORRELATION:
        return None
    sx = pd.Series(x)
    sy = pd.Series(y)
    if sx.std(ddof=1) == 0 or sy.std(ddof=1) == 0 or not np.isfinite(sx).all() or not np.isfinite(sy).all():
        return None
    value = sx.corr(sy, method=method)
    return _finite(value)


def _sample_covariance(x, y):
    """Sample covariance (ddof=1); None below the minimum overlap."""
    if len(x) < MIN_OVERLAP_FOR_CORRELATION:
        return None
    sx = pd.Series(x)
    sy = pd.Series(y)
    if sx.std(ddof=1) == 0 or sy.std(ddof=1) == 0:
        return None
    return _finite(sx.cov(sy))


def _conditional_correlation(x, y, side):
    """Correlation restricted to periods where at least one asset moved down (side='down') or up (side='up')."""
    x_arr = np.asarray(x, dtype=float)
    y_arr = np.asarray(y, dtype=float)
    if side == "down":
        mask = (x_arr < 0) | (y_arr < 0)
    else:
        mask = (x_arr > 0) | (y_arr > 0)
    mx, my = x_arr[mask], y_arr[mask]
    if len(mx) < MIN_OVERLAP_FOR_CONDITIONAL:
        return None, int(len(mx))
    return _safe_correlation(mx, my), int(len(mx))


def rolling_correlation_series(aligned, window):
    """Rolling Pearson correlation of the two columns of `aligned`.

    Returns (dates, values): lists where values[i] may be None while the
    window is still filling up. Length always matches len(aligned).
    """
    if len(aligned) < window:
        return list(aligned.index), [None] * len(aligned)
    rolled = aligned.iloc[:, 0].rolling(window).corr(aligned.iloc[:, 1])
    dates = [d.strftime("%Y-%m-%d") for d in aligned.index]
    values = [_finite(v) for v in rolled]
    return dates, values


def _rolling_summary(aligned, window):
    """Latest / mean / min / max of the rolling-correlation series."""
    if len(aligned) < window:
        return {
            "window": window,
            "observations": int(len(aligned)),
            "latest": None,
            "mean": None,
            "min": None,
            "max": None,
            "available": False,
        }
    rolled = aligned.iloc[:, 0].rolling(window).corr(aligned.iloc[:, 1]).dropna()
    return {
        "window": window,
        "observations": int(len(rolled)),
        "latest": _finite(rolled.iloc[-1]),
        "mean": _finite(rolled.mean()),
        "min": _finite(rolled.min()),
        "max": _finite(rolled.max()),
        "available": True,
    }


def linear_regression_stats(dependent, explanatory):
    """Historical OLS statistics of dependent ~ explanatory (+ intercept).

    beta equals the ordinary-least-squares slope Cov(d,e)/Var(e);
    the 'residual mean' is the fitted intercept (average daily residual),
    R-squared equals the squared Pearson coefficient for this simple
    model, and residual volatility is the sample std of residuals.

    These are descriptive regression statistics over past data only.
    They are NOT guaranteed excess returns and NOT a causal claim.
    """
    dep = np.asarray(dependent, dtype=float)
    exp = np.asarray(explanatory, dtype=float)
    n = int(len(dep))
    if n < MIN_OVERLAP_FOR_CORRELATION:
        return {
            "beta": None,
            "residual_mean_daily": None,
            "r_squared": None,
            "residual_volatility": None,
            "observations": n,
            "available": False,
        }
    sd = pd.Series(dep)
    se = pd.Series(exp)
    var_e = se.var(ddof=1)
    if var_e is None or not np.isfinite(var_e) or var_e == 0:
        return {
            "beta": None,
            "residual_mean_daily": None,
            "r_squared": None,
            "residual_volatility": None,
            "observations": n,
            "available": False,
        }
    beta = float(sd.cov(se) / var_e)
    residuals = dep - beta * exp
    pearson = _safe_correlation(dep, exp)
    r_squared = _finite(pearson**2) if pearson is not None else None
    return {
        "beta": _finite(beta),
        "residual_mean_daily": _finite(residuals.mean()),
        "r_squared": r_squared,
        "residual_volatility": _finite(residuals.std(ddof=1)),
        "observations": n,
        "available": True,
    }


def _aligned_pair(returns_a, returns_b):
    """Inner-join two return series on shared dates (chronological)."""
    aligned = pd.concat(
        [
            returns_a.rename("a"),
            returns_b.rename("b"),
        ],
        axis=1,
        join="inner",
    ).dropna(how="any")
    return aligned.sort_index()


def compute_pair_statistics(returns_a, returns_b):
    """Full pairwise statistics block for one unordered pair."""
    aligned = _aligned_pair(returns_a, returns_b)
    n = int(len(aligned))
    x = aligned["a"].to_numpy(dtype=float)
    y = aligned["b"].to_numpy(dtype=float)

    pearson = _safe_correlation(x, y)
    spearman = _safe_correlation(x, y, method="spearman")
    covariance = _sample_covariance(x, y)
    downside, downside_obs = _conditional_correlation(x, y, "down")
    upside, upside_obs = _conditional_correlation(x, y, "up")

    pair = {
        "overlap_days": n,
        "start_date": aligned.index[0].strftime("%Y-%m-%d") if n else None,
        "end_date": aligned.index[-1].strftime("%Y-%m-%d") if n else None,
        "pearson_correlation": pearson,
        "spearman_correlation": spearman,
        "covariance": covariance,
        "downside_correlation": downside,
        "downside_observations": downside_obs,
        "upside_correlation": upside,
        "upside_observations": upside_obs,
        "insufficient_overlap": n < MIN_OVERLAP_FOR_CORRELATION,
        "rolling": {
            str(window): _rolling_summary(aligned, window)
            for window in ROLLING_WINDOWS
        },
    }
    return pair, aligned


def build_cross_market_analysis(frames_by_id):
    """Pairwise cross-market analysis for every combination of datasets.

    Returns matrices (symmetric, ids ordered as given) plus a pair-level
    detail list that also carries BOTH directional regressions:
    A relative to B and B relative to A.
    """
    ids = list(frames_by_id.keys())
    returns_by_id = {
        dataset_id: daily_returns_from_frame(frames_by_id[dataset_id])
        for dataset_id in ids
    }

    matrix_ids = [int(i) for i in ids]
    size = len(ids)
    zeros = [[None] * size for _ in range(size)]
    matrices = {
        "ids": matrix_ids,
        "pearson": [row[:] for row in zeros],
        "spearman": [row[:] for row in zeros],
        "covariance": [row[:] for row in zeros],
        "downside": [row[:] for row in zeros],
        "upside": [row[:] for row in zeros],
        "overlap_count": [row[:] for row in zeros],
    }

    pairs = []
    for i in range(size):
        id_a = ids[i]
        ra = returns_by_id[id_a]
        # Diagonal: self-overlap equals the dataset's own usable return count.
        matrices["pearson"][i][i] = 1.0
        matrices["spearman"][i][i] = 1.0
        matrices["covariance"][i][i] = _finite(ra.var(ddof=1))
        matrices["downside"][i][i] = 1.0
        matrices["upside"][i][i] = 1.0
        matrices["overlap_count"][i][i] = int(len(ra))

        for j in range(i + 1, size):
            id_b = ids[j]
            rb = returns_by_id[id_b]
            pair, aligned = compute_pair_statistics(ra, rb)

            regression_ab = linear_regression_stats(
                aligned["a"].to_numpy(dtype=float),
                aligned["b"].to_numpy(dtype=float),
            )
            regression_ba = linear_regression_stats(
                aligned["b"].to_numpy(dtype=float),
                aligned["a"].to_numpy(dtype=float),
            )

            pairs.append(
                {
                    "dataset_a": int(id_a),
                    "dataset_b": int(id_b),
                    **pair,
                    "regression_a_relative_to_b": regression_ab,
                    "regression_b_relative_to_a": regression_ba,
                }
            )

            for metric, key in (
                ("pearson", "pearson_correlation"),
                ("spearman", "spearman_correlation"),
                ("covariance", "covariance"),
                ("downside", "downside_correlation"),
                ("upside", "upside_correlation"),
            ):
                matrices[metric][i][j] = pair[key]
                matrices[metric][j][i] = pair[key]
            matrices["overlap_count"][i][j] = pair["overlap_days"]
            matrices["overlap_count"][j][i] = pair["overlap_days"]

    common_start = max(
        (r.index[0] for r in returns_by_id.values() if len(r)), default=None
    )
    common_end = min(
        (r.index[-1] for r in returns_by_id.values() if len(r)), default=None
    )
    # Disjoint calendars produce an inverted span; report no common window.
    if common_start is not None and common_end is not None and common_start > common_end:
        common_start = None
        common_end = None

    return {
        "matrices": matrices,
        "pairs": pairs,
        "overlap": {
            "start_date": common_start.strftime("%Y-%m-%d") if common_start is not None else None,
            "end_date": common_end.strftime("%Y-%m-%d") if common_end is not None else None,
            "minimum_pairwise_overlap": min(
                (p["overlap_days"] for p in pairs), default=0
            ),
        },
        "methodology": {
            "returns": "daily percent returns of close prices",
            "alignment": "inner join on shared trading dates",
            "min_overlap_for_correlation": MIN_OVERLAP_FOR_CORRELATION,
            "min_overlap_for_conditional": MIN_OVERLAP_FOR_CONDITIONAL,
            "downside_definition": (
                "correlation over periods where at least one asset's "
                "return was negative"
            ),
            "upside_definition": (
                "correlation over periods where at least one asset's "
                "return was positive"
            ),
            "regression_note": (
                "Beta/R-squared/residual statistics are historical OLS "
                "regression descriptions of past co-movement. They are not "
                "guaranteed excess returns and do not imply causation."
            ),
        },
        "disclaimer": (
            "Cross-market statistics describe historical co-movement only. "
            "Correlation does not imply causation."
        ),
    }


def build_pair_focus(returns_a, returns_b):
    """Rolling-correlation series + aligned scatter points for two datasets."""
    aligned = _aligned_pair(returns_a, returns_b)
    focus = {"overlap_days": int(len(aligned))}
    for window in ROLLING_WINDOWS:
        dates, values = rolling_correlation_series(aligned, window)
        focus[str(window)] = {"dates": dates, "values": values}
        summary = _rolling_summary(aligned, window)
        focus[f"{window}_summary"] = summary

    step = max(1, math.ceil(len(aligned) / MAX_SCATTER_POINTS))
    sampled = aligned.iloc[::step]
    focus["scatter"] = {
        "points": [
            {
                "date": d.strftime("%Y-%m-%d"),
                "return_a": _finite(row["a"]),
                "return_b": _finite(row["b"]),
            }
            for d, row in sampled.iterrows()
        ],
        "total_points": int(len(aligned)),
        "returned_points": int(len(sampled)),
        "downsampled": bool(step > 1),
    }

    focus["regression_a_relative_to_b"] = linear_regression_stats(
        aligned["a"].to_numpy(dtype=float), aligned["b"].to_numpy(dtype=float)
    )
    focus["regression_b_relative_to_a"] = linear_regression_stats(
        aligned["b"].to_numpy(dtype=float), aligned["a"].to_numpy(dtype=float)
    )
    return focus
