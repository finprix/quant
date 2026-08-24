"""Market intelligence layer for QUANT VECTOR.

Combines the statistical fingerprint, regime discovery and historical
analogue engines into one evidence-based market state assessment. Every
score below is a deterministic function of the uploaded data; nothing is
random, no external model is called, and outputs are historical/conditional
descriptions rather than predictions.

Scoring formulas (all component scores lie in [-1, +1], positive = bullish):

  trend_score     = 0.40 * ma_signal
                  + 0.30 * tanh(momentum_20 / 0.03)
                  + 0.30 * tanh(momentum_60 / 0.06)

  analogue_score  = 0.50 * tanh(mean_fwd20 / 0.03)
                  + 0.25 * (2*freq_fwd5  - 1)
                  + 0.25 * (2*freq_fwd20 - 1)        [needs >= 1 valid analogue]

  regime_score    = 0.40 * tanh(avg_window_return / 0.02)
                  + 0.30 * (2*positive_return_ratio - 1)
                  + 0.30 * tanh(avg_momentum_20 / 0.05)

  risk_score      = -(0.55 * volatility_pressure + 0.45 * drawdown_severity)
                    volatility_pressure = clamp((vol_percentile - 0.50)/0.50, 0, 1)
                    drawdown_severity   = min(1, |current_drawdown| / 0.20)

Evidence weights: trend 0.30, analogues 0.30, regime 0.25, risk 0.15.
The analogue weight scales with sample coverage and shrinks when outcome
dispersion is high; the regime weight scales with cluster confidence.
Unavailable evidence gets weight 0 and its share renormalizes away.

  bias_score      = sum(weight_i * score_i) / sum(weight_i)
  directional_bias= bullish if bias >= +0.15; bearish if <= -0.15;
                    mixed if internal spread of components >= 1.0; else neutral
  risk_index      = 0.50*volatility_pressure + 0.30*drawdown_severity
                  + 0.20*clamp(|vol_20d| / 0.60, 0, 1)
  risk_level      = low < 0.25 <= moderate < 0.50 <= high < 0.75 <= extreme

  confidence      = 0.35*agreement + 0.25*coverage + 0.20*(1-dispersion)
                  + 0.10*regime_confidence + 0.10*sample_depth
where agreement is the sign-agreement rate across available directional
components, coverage the share of usable evidence weight, dispersion the
analogue forward-return dispersion index, and depth the effective analogue/
window sample size.
"""

import math

import numpy as np

from fingerprint import _safe_float, calculate_fingerprint, find_historical_analogues
from regimes import discover_regimes

# Documented quantitative thresholds.
MOMENTUM_SCALES = {"momentum_20": 0.03, "momentum_60": 0.06}
ANALOGUE_RETURN_SCALE = 0.03
REGIME_RETURN_SCALE = 0.02
REGIME_MOMENTUM_SCALE = 0.05
DRAWDOWN_SEVERITY_SCALE = 0.20
VOL20_EXTREME_SCALE = 0.60
DISPERSION_STD_SCALE = 0.10
VOL_PCTL_MIN_SAMPLES = 20

BASE_WEIGHTS = {"trend": 0.30, "analogues": 0.30, "regime": 0.25, "risk": 0.15}
BIAS_BULLISH_THRESHOLD = 0.15
BIAS_BEARISH_THRESHOLD = -0.15
CONFLICT_SPREAD_THRESHOLD = 1.0

RISK_BANDS = ((0.25, "low"), (0.50, "moderate"), (0.75, "high"))
RISK_TOP_BAND = "extreme"

DRAWDOWN_STATES = ((-0.05, "shallow"), (-0.15, "moderate"))

DISCLAIMERS = (
    "All observations describe historical and current statistical "
    "conditions of the uploaded dataset only.",
    "Analogue outcomes and transition probabilities are historical "
    "frequencies, not guarantees or predictions of future returns.",
    "This output is quantitative research information, not investment advice.",
)

METHODOLOGY = {
    "component_scores": {
        "trend_score": "0.40*ma_signal + 0.30*tanh(mom20/0.03) + 0.30*tanh(mom60/0.06)",
        "analogue_score": (
            "0.50*tanh(mean_fwd20/0.03) + 0.25*(2*freq_fwd5-1) "
            "+ 0.25*(2*freq_fwd20-1); requires valid analogues"
        ),
        "regime_score": (
            "0.40*tanh(avg_window_return/0.02) + 0.30*(2*positive_return_ratio-1) "
            "+ 0.30*tanh(avg_momentum_20/0.05)"
        ),
        "risk_score": "-(0.55*volatility_pressure + 0.45*drawdown_severity); always <= 0",
    },
    "aggregation": {
        "weights": BASE_WEIGHTS,
        "bias_score": "sum(w_i*s_i)/sum(w_i) over available evidence",
        "directional_bias": "bullish >= +0.15; bearish <= -0.15; mixed if component spread >= 1.0; else neutral",
        "analogue_weight_modifier": "clamp(valid/top_n, 0, 1) * (1 - 0.5*dispersion_index)",
        "regime_weight_modifier": "regime_assignment_confidence",
    },
    "risk_index": (
        "0.50*volatility_pressure + 0.30*drawdown_severity "
        "+ 0.20*clamp(vol_20d/0.60, 0, 1); bands at 0.25/0.50/0.75"
    ),
    "confidence": (
        "0.35*agreement + 0.25*evidence_coverage + 0.20*(1-analogue_dispersion) "
        "+ 0.10*regime_confidence + 0.10*sample_depth"
    ),
    "state_flags": {
        "volatility_state": (
            "percentile rank of current 20d annualized vol within its own history: "
            "<=p25 low, <=p75 normal, <=p95 elevated, >p95 extreme"
        ),
        "trend_state": "MA20/MA50 alignment combined with 20-day momentum sign",
        "drawdown_state": "current drawdown: >-5% shallow, -5%..-15% moderate, <-15% severe",
        "momentum_state": "sign agreement of 20d and 60d momentum",
    },
}


def _clamp(value, low=0.0, high=1.0):
    return max(low, min(high, value))


def pct_or_na(value, signed=True):
    """Format a return-like fraction as a percentage string; None -> 'n/a'."""
    if value is None:
        return "n/a"
    return f"{value:+.2%}" if signed else f"{value:.2%}"


def _tanh_scaled(value, scale):
    if value is None:
        return None
    return math.tanh(float(value) / scale)


def percentile_rank(history, value):
    """Fraction of `history` entries <= value (0..1); None if too few samples."""
    known = [float(v) for v in history if v is not None]
    if len(known) < VOL_PCTL_MIN_SAMPLES:
        return None
    return sum(1 for v in known if v <= float(value)) / len(known)


def build_current_state(df):
    """Compact description of the most recent market bar plus state flags."""
    fingerprint = calculate_fingerprint(df)
    close = df["Close"].astype(float)
    latest_close = float(close.iloc[-1])
    running_max = float(close.cummax().iloc[-1])
    current_drawdown = latest_close / running_max - 1.0

    vol_history = (
        close.pct_change()
        .rolling(window=20, min_periods=20)
        .std(ddof=1)
        .mul(math.sqrt(252))
        .dropna()
        .tolist()
    )
    vol_current = fingerprint.get("volatility_20d")
    vol_pctl = percentile_rank(vol_history, vol_current) if vol_current is not None else None

    if vol_pctl is None:
        volatility_state = "normal"
    elif vol_pctl <= 0.25:
        volatility_state = "low"
    elif vol_pctl <= 0.75:
        volatility_state = "normal"
    elif vol_pctl <= 0.95:
        volatility_state = "elevated"
    else:
        volatility_state = "extreme"

    if current_drawdown > DRAWDOWN_STATES[0][0]:
        drawdown_state = DRAWDOWN_STATES[0][1]
    elif current_drawdown > DRAWDOWN_STATES[1][0]:
        drawdown_state = DRAWDOWN_STATES[1][1]
    else:
        drawdown_state = "severe"

    m20 = fingerprint.get("momentum_20")
    m60 = fingerprint.get("momentum_60")

    ratio = fingerprint.get("ma20_ma50_ratio")
    relationship = fingerprint.get("ma20_ma50_relationship")
    if relationship in ("above", "below"):
        ma_gap = (ratio or 1.0) - 1.0
        if abs(ma_gap) <= 0.004 and abs(m20 or 0.0) <= 0.02:
            trend_state = "sideways"
        elif ma_gap > 0 and (m20 or 0.0) >= 0:
            trend_state = "bullish"
        elif ma_gap < 0 and (m20 or 0.0) <= 0:
            trend_state = "bearish"
        elif (m20 or 0.0) > 0.03:
            trend_state = "bullish"
        elif (m20 or 0.0) < -0.03:
            trend_state = "bearish"
        else:
            trend_state = "sideways"
    else:
        trend_state = "sideways"

    if m20 is None or m60 is None:
        momentum_state = "mixed"
    elif m20 >= 0 and m60 >= 0:
        momentum_state = "positive"
    elif m20 < 0 and m60 < 0:
        momentum_state = "negative"
    else:
        momentum_state = "mixed"

    return {
        "latest_date": df["Date"].iloc[-1].strftime("%Y-%m-%d"),
        "latest_close": _safe_float(latest_close),
        "annualized_volatility": fingerprint.get("annualized_volatility"),
        "volatility_20d": _safe_float(vol_current),
        "volatility_percentile": _safe_float(vol_pctl),
        "current_drawdown": _safe_float(current_drawdown),
        "momentum_20d": _safe_float(m20),
        "momentum_60d": _safe_float(m60),
        "ma20_relationship": relationship,
        "ma50_relationship": relationship,
        "relative_volume": fingerprint.get("volume_to_average_ratio"),
        "skewness": fingerprint.get("skewness"),
        "kurtosis": fingerprint.get("kurtosis"),
        "state_flags": {
            "volatility_state": volatility_state,
            "trend_state": trend_state,
            "drawdown_state": drawdown_state,
            "momentum_state": momentum_state,
        },
        "_fingerprint": fingerprint,
    }


def analyse_analogues(analogues):
    """Aggregate realized forward outcomes across historical analogues."""
    valid = [
        a for a in analogues
        if a.get("subsequent_market_action", {}).get("available")
    ]
    count = len(valid)

    def collect(key):
        return [
            a["subsequent_market_action"][key]
            for a in valid
            if a["subsequent_market_action"].get(key) is not None
        ]

    result = {
        "valid_analogues": count,
        "total_candidates_reported": len(analogues),
    }
    if count == 0:
        result["available"] = False
        result["note"] = (
            "No analogues carried observable forward data (insufficient "
            "history after the matched windows)."
        )
        return result

    stats = {}
    for horizon in (5, 10, 20):
        values = collect(f"return_after_{horizon}_days")
        if values:
            arr = np.array(values, dtype=float)
            stats[f"mean_{horizon}d_forward_return"] = _safe_float(arr.mean())
            stats[f"median_{horizon}d_forward_return"] = _safe_float(np.median(arr))
            stats[f"positive_{horizon}d_frequency"] = _safe_float((arr > 0).mean())
        else:
            stats[f"mean_{horizon}d_forward_return"] = None
            stats[f"median_{horizon}d_forward_return"] = None
            stats[f"positive_{horizon}d_frequency"] = None

    r20 = collect("return_after_20_days")
    if r20:
        arr20 = np.array(r20, dtype=float)
        q75, q25 = np.percentile(arr20, [75, 25])
        stats["std_dev_20d_forward_return"] = _safe_float(arr20.std(ddof=1)) if len(r20) >= 2 else None
        stats["iqr_20d_forward_return"] = _safe_float(q75 - q25)
        dispersion_index = _clamp(abs(stats["std_dev_20d_forward_return"] or 0.0) / DISPERSION_STD_SCALE)
    else:
        stats["std_dev_20d_forward_return"] = None
        stats["iqr_20d_forward_return"] = None
        dispersion_index = 0.0

    mfe = collect("max_favourable_move_20d")
    mae = collect("max_adverse_move_20d")
    stats["avg_20d_favourable_excursion"] = _safe_float(np.mean(mfe)) if mfe else None
    stats["avg_20d_adverse_excursion"] = _safe_float(np.mean(mae)) if mae else None

    result.update(stats)
    result["dispersion_index"] = _safe_float(dispersion_index)
    result["available"] = True
    result["note"] = (
        "Aggregated historical outcomes of statistically similar past "
        "windows; descriptive, not predictive."
    )
    return result


def build_regime_context(discovery):
    """Extract the current-regime historical context from a discovery run."""
    if not discovery.get("available"):
        return None

    current = discovery["current_regime"]
    profile = next(
        p for p in discovery["regimes"] if p["regime_id"] == current["regime_id"]
    )
    outcomes = profile.get("forward_outcomes", {})

    return {
        "regime_id": current["regime_id"],
        "regime_label": current["label"],
        "historical_frequency": profile.get("percentage_of_windows"),
        "average_duration_days": profile.get("approx_avg_duration_trading_days"),
        "regime_confidence": current.get("confidence"),
        "profile": {
            "avg_window_return": profile.get("avg_window_return"),
            "volatility": profile.get("volatility"),
            "max_drawdown": profile.get("max_drawdown"),
            "skewness": profile.get("skewness"),
            "kurtosis": profile.get("kurtosis"),
            "avg_momentum_20": profile.get("avg_momentum_20"),
            "positive_return_ratio": profile.get("positive_return_ratio"),
        },
        "conditional_outcomes": {
            "samples_with_full_horizon": outcomes.get("samples_with_full_horizon"),
            "probability_positive_after_20_days": outcomes.get(
                "probability_positive_after_20_days"
            ),
            "mean_return_after_20_days": outcomes.get("average_return_after_20_days"),
            "median_return_after_20_days": outcomes.get("median_return_after_20_days"),
            "best_return_after_20_days": outcomes.get("best_return_after_20_days"),
            "worst_return_after_20_days": outcomes.get("worst_return_after_20_days"),
            "note": outcomes.get("note"),
        },
        "common_next_regimes": current.get("most_common_next_regimes", []),
        "duration_windows": current.get("duration_windows"),
        "approx_current_duration_days": current.get("approx_duration_trading_days"),
    }


def compute_evidence(state, consensus, regime_context):
    """Score every evidence source and aggregate the final assessment."""
    flags = state["state_flags"]

    # --- Trend -----------------------------------------------------------
    ma_signal = {"above": 1.0, "below": -1.0}.get(state.get("ma20_relationship"), 0.0)
    t_mom20 = _tanh_scaled(state["momentum_20d"], MOMENTUM_SCALES["momentum_20"]) or 0.0
    t_mom60 = _tanh_scaled(state["momentum_60d"], MOMENTUM_SCALES["momentum_60"]) or 0.0
    trend_score = 0.40 * ma_signal + 0.30 * t_mom20 + 0.30 * t_mom60

    # --- Risk (always non-positive directionally) -------------------------
    vol_pctl = state.get("volatility_percentile")
    vol_pressure = _clamp(((vol_pctl if vol_pctl is not None else 0.5) - 0.50) / 0.50)
    dd_severity = min(1.0, abs(state["current_drawdown"] or 0.0) / DRAWDOWN_SEVERITY_SCALE)
    risk_score = -(0.55 * vol_pressure + 0.45 * dd_severity)

    vol20 = state.get("volatility_20d") or 0.0
    risk_index = _clamp(
        0.50 * vol_pressure
        + 0.30 * dd_severity
        + 0.20 * _clamp(abs(vol20) / VOL20_EXTREME_SCALE)
    )
    risk_level = RISK_TOP_BAND
    for band_edge, label in RISK_BANDS:
        if risk_index < band_edge:
            risk_level = label
            break

    # --- Analogues --------------------------------------------------------
    valid = consensus.get("valid_analogues", 0)
    dispersion = consensus.get("dispersion_index", 0.0) or 0.0
    if consensus.get("available") and valid >= 1:
        mean20 = consensus.get("mean_20d_forward_return")
        freq5 = consensus.get("positive_5d_frequency")
        freq20 = consensus.get("positive_20d_frequency")
        analogue_score = (
            0.50 * (_tanh_scaled(mean20, ANALOGUE_RETURN_SCALE) or 0.0)
            + 0.25 * (2 * (freq5 or 0.5) - 1)
            + 0.25 * (2 * (freq20 or 0.5) - 1)
        )
        analogue_quality = _clamp(valid / max(1, consensus.get("total_candidates_reported", valid))) * (
            1.0 - 0.5 * dispersion
        )
    else:
        analogue_score = None
        analogue_quality = 0.0

    # --- Regime -----------------------------------------------------------
    regime_confidence = 0.0
    regime_score = None
    if regime_context:
        profile = regime_context["profile"]
        conf = regime_context.get("regime_confidence")
        regime_confidence = float(conf) if conf is not None else 0.0
        regime_score = (
            0.40 * (_tanh_scaled(profile.get("avg_window_return"), REGIME_RETURN_SCALE) or 0.0)
            + 0.30 * (2 * (profile.get("positive_return_ratio") or 0.5) - 1)
            + 0.30 * (_tanh_scaled(profile.get("avg_momentum_20"), REGIME_MOMENTUM_SCALE) or 0.0)
        )

    # --- Weighted aggregation ---------------------------------------------
    weights = dict(BASE_WEIGHTS)
    weights["analogues"] *= analogue_quality
    weights["regime"] *= regime_confidence

    contributions = {"trend": trend_score, "risk": risk_score}
    if analogue_score is not None:
        contributions["analogues"] = analogue_score
    if regime_score is not None:
        contributions["regime"] = regime_score

    total_weight = sum(weights[name] for name in contributions)
    bias_score = (
        sum(weights[name] * score for name, score in contributions.items()) / total_weight
        if total_weight > 0 else 0.0
    )
    coverage = total_weight / sum(BASE_WEIGHTS.values())

    directional_components = [
        s for name, s in contributions.items() if name != "risk" and s is not None
    ]
    if len(directional_components) >= 2:
        pairs = 0
        agreeing = 0
        for i in range(len(directional_components)):
            for j in range(i + 1, len(directional_components)):
                si, sj = directional_components[i], directional_components[j]
                pairs += 1
                if si == 0 or sj == 0:
                    agreeing += 0.5
                elif (si > 0) == (sj > 0):
                    agreeing += 1.0
        agreement = agreeing / pairs
    else:
        agreement = 0.5

    spread = max(directional_components) - min(directional_components) if directional_components else 0.0
    if bias_score >= BIAS_BULLISH_THRESHOLD:
        directional_bias = "bullish"
    elif bias_score <= BIAS_BEARISH_THRESHOLD:
        directional_bias = "bearish"
    elif spread >= CONFLICT_SPREAD_THRESHOLD:
        directional_bias = "mixed"
    else:
        directional_bias = "neutral"

    n_windows = regime_context.get("_n_windows") if isinstance(regime_context, dict) else None
    depth = _clamp(0.7 * _clamp(valid / 5.0) + 0.3 * _clamp((n_windows or 0) / 24))
    confidence = _clamp(
        0.35 * agreement
        + 0.25 * coverage
        + 0.20 * (1.0 - dispersion)
        + 0.10 * regime_confidence
        + 0.10 * depth
    )

    evidence = {
        "trend_score": _safe_float(trend_score),
        "analogue_score": _safe_float(analogue_score),
        "regime_score": _safe_float(regime_score),
        "risk_score": _safe_float(risk_score),
        "agreement_score": _safe_float(agreement),
        "bias_score": _safe_float(bias_score),
        "risk_index": _safe_float(risk_index),
        "weights_used": {k: _safe_float(v) for k, v in weights.items()},
        "quality_factors": {
            "analogue_sample_quality": _safe_float(analogue_quality),
            "regime_confidence": _safe_float(regime_confidence),
            "evidence_coverage": _safe_float(coverage),
            "analogue_dispersion_index": _safe_float(dispersion),
        },
    }

    assessment = {
        "directional_bias": directional_bias,
        "risk_level": risk_level,
        "confidence": _safe_float(confidence),
    }
    return evidence, assessment


def detect_contradictions(state, consensus, evidence, regime_context):
    """Deterministic rule-based detection of conflicting market evidence."""
    contradictions = []
    flags = state["state_flags"]
    trend = evidence["trend_score"] or 0.0
    analogue = evidence["analogue_score"]

    def add(ctype, description, severity):
        contradictions.append({"type": ctype, "description": description, "severity": severity})

    if analogue is not None and abs(analogue) > 0.3 and abs(trend) > 0.3 and (analogue > 0) != (trend > 0):
        add(
            "momentum_vs_analogues",
            f"Trend/momentum evidence is {'bullish' if trend > 0 else 'bearish'} "
            f"(score {trend:+.2f}) while historical analogue outcomes lean "
            f"{'bullish' if analogue > 0 else 'bearish'} (score {analogue:+.2f}).",
            "high",
        )

    if regime_context and "Bullish" in (regime_context.get("regime_label") or "") \
            and flags["volatility_state"] in ("elevated", "extreme"):
        add(
            "regime_vs_volatility",
            f"The regime reads bullish but volatility is {flags['volatility_state']} "
            f"({state['volatility_20d']:.1%} annualized over 20 days).",
            "medium",
        )

    if trend > 0.3 and flags["drawdown_state"] == "severe":
        add(
            "trend_vs_drawdown",
            f"Momentum/trend is constructive yet price remains {state['current_drawdown']:.1%} "
            "below its running maximum (severe drawdown).",
            "high",
        )

    if consensus.get("available") and consensus.get("valid_analogues", 0) >= 3 \
            and (consensus.get("dispersion_index") or 0.0) >= 0.6:
        add(
            "analogue_dispersion_weak",
            f"Analogue 20-day outcomes are highly dispersed "
            f"(std dev {pct_or_na(consensus.get('std_dev_20d_forward_return'))}), so the "
            "analogue signal carries limited weight.",
            "medium",
        )

    regime = evidence["regime_score"]
    if regime is not None and abs(regime) > 0.2 and abs(trend) > 0.2 and (regime > 0) != (trend > 0):
        add(
            "regime_vs_trend",
            f"Current regime statistics ({regime:+.2f}) conflict with short-term "
            f"trend/momentum ({trend:+.2f}).",
            "medium",
        )

    return contradictions


def render_summary(state, consensus, regime_context, evidence, assessment, contradictions):
    """Template-generated factual summary built from computed values."""
    pct = pct_or_na
    flags = state["state_flags"]
    parts = []

    if regime_context:
        parts.append(
            f"The current window is classified as '{regime_context['regime_label']}' "
            f"(assignment confidence {regime_context.get('regime_confidence') or 0:.2f}) "
            f"with {flags['volatility_state']} volatility "
            f"({pct(state['annualized_volatility'], signed=False)} annualized) and "
            f"{flags['momentum_state']} 20/60-day momentum "
            f"({pct(state['momentum_20d'])} / {pct(state['momentum_60d'])})."
        )
    else:
        parts.append(
            f"Regime classification was unavailable for this dataset; observed "
            f"volatility is {flags['volatility_state']} and momentum is "
            f"{flags['momentum_state']}."
        )

    if consensus.get("available") and consensus.get("valid_analogues", 0) >= 1:
        freq = consensus.get("positive_20d_frequency")
        parts.append(
            f"Across {consensus['valid_analogues']} historically similar windows, "
            f"{round((freq or 0.0) * consensus['valid_analogues'])} of "
            f"{consensus['valid_analogues']} produced positive 20-day outcomes "
            f"(mean {pct(consensus.get('mean_20d_forward_return'))}, "
            f"std dev {pct(consensus.get('std_dev_20d_forward_return'))}); these are "
            "observed historical frequencies."
        )
    else:
        parts.append(
            "No comparable historical windows carried observable forward data, "
            "so no analogue outcome statistics are available."
        )

    if regime_context:
        co = regime_context["conditional_outcomes"]
        if co.get("samples_with_full_horizon"):
            parts.append(
                f"Historically this regime appeared in "
                f"{pct(regime_context.get('historical_frequency'), signed=False)} of evaluated "
                f"windows and lasted about "
                f"{regime_context.get('average_duration_days')} trading days on average; "
                f"in {co['samples_with_full_horizon']} observed cases the following "
                f"20-day return averaged {pct(co.get('mean_return_after_20_days'))} "
                f"(best {pct(co.get('best_return_after_20_days'))}, "
                f"worst {pct(co.get('worst_return_after_20_days'))})."
            )

    if contradictions:
        strongest = max(
            contradictions, key=lambda c: {"high": 2, "medium": 1, "low": 0}[c["severity"]]
        )
        parts.append(f"Notable inconsistency ({strongest['severity']}): {strongest['description']}")

    parts.append(
        f"Overall statistical read: {assessment['directional_bias']} directional "
        f"evidence with {assessment['risk_level']} risk indicators "
        f"(confidence {assessment['confidence']:.2f}). Historical and conditional "
        "observations only."
    )
    return " ".join(parts)


def build_scorecard(state, assessment, regime_context, consensus):
    flags = state["state_flags"]
    return {
        "directional_bias": assessment["directional_bias"],
        "confidence": assessment["confidence"],
        "risk_level": assessment["risk_level"],
        "regime": {
            "id": regime_context["regime_id"] if regime_context else None,
            "label": regime_context["regime_label"] if regime_context else None,
        },
        "volatility_state": flags["volatility_state"],
        "trend_state": flags["trend_state"],
        "drawdown_state": flags["drawdown_state"],
        "momentum_state": flags["momentum_state"],
        "analogue_agreement": evidence_agreement(assessment),
        "positive_20d_analogue_frequency": consensus.get("positive_20d_frequency"),
        "current_drawdown": state["current_drawdown"],
        "momentum_20d": state["momentum_20d"],
        "momentum_60d": state["momentum_60d"],
    }


def evidence_agreement(assessment):
    """Placeholder-free accessor kept for scorecard/test readability."""
    return assessment.get("agreement")


def build_market_intelligence(df, lookback=60, top_n=5, window_size=60, k=None):
    """Build the full intelligence payload from one OHLCV DataFrame.

    Reuses calculate_fingerprint (Phase 3), find_historical_analogues
    (Phase 3) and discover_regimes (Phase 4); adds state flags, analogue
    consensus, evidence scoring, contradiction detection and templated
    reporting. Purely quantitative; no network calls.
    """
    state = build_current_state(df)

    analogue_result = find_historical_analogues(df, lookback=lookback, top_n=top_n)
    consensus = analyse_analogues(analogue_result.get("analogues", []))

    discovery = discover_regimes(df, window_size=window_size, k=k)
    regime_context = build_regime_context(discovery)
    if regime_context is not None:
        regime_context["_n_windows"] = discovery.get("n_windows")

    evidence, assessment = compute_evidence(state, consensus, regime_context)
    assessment["agreement"] = evidence["agreement_score"]
    fingerprint_summary = state.pop("_fingerprint")

    contradictions = detect_contradictions(state, consensus, evidence, regime_context)
    summary = render_summary(state, consensus, regime_context, evidence, assessment, contradictions)
    scorecard = build_scorecard(state, assessment, regime_context, consensus)

    return {
        "current_state": _public_state(state),
        "scorecard": scorecard,
        "fingerprint_summary": {
            key: fingerprint_summary.get(key)
            for key in (
                "mean_daily_return", "annualized_volatility", "volatility_20d",
                "skewness", "kurtosis", "positive_return_ratio", "max_drawdown",
                "avg_drawdown", "downside_deviation", "var_95", "cvar_95",
                "ma20_ma50_relationship", "distance_from_ma20", "distance_from_ma50",
                "momentum_20", "momentum_60", "autocorrelation_lag1",
                "autocorrelation_lag5", "volume_to_average_ratio",
            )
        },
        "current_regime_context": _strip_private(regime_context),
        "analogue_consensus": consensus,
        "analogue_matches": [
            {
                "rank": a.get("rank"),
                "start_date": a.get("start_date"),
                "end_date": a.get("end_date"),
                "similarity_score": a.get("similarity_score"),
            }
            for a in analogue_result.get("analogues", [])
        ],
        "evidence": evidence,
        "contradictions": contradictions,
        "summary": summary,
        "methodology": METHODOLOGY,
        "disclaimers": list(DISCLAIMERS),
    }


def _public_state(state):
    return {key: value for key, value in state.items() if not key.startswith("_")}


def _strip_private(context):
    if context is None:
        return None
    return {key: value for key, value in context.items() if not key.startswith("_")}
