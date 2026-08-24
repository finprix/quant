"""Quantitative self-tests for the QUANT VECTOR intelligence layer (Phase 5).

All fixtures are deterministic synthetic OHLCV data. Run directly:
python test_intelligence.py

The API section uses FastAPI's in-process TestClient against real MySQL;
Uvicorn is never started.
"""

import io
import json
import math
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, r"D:\fin\market-dna\backend")

import database
import intelligence
from intelligence import analyse_analogues, build_market_intelligence, detect_contradictions

FAILURES = []
REQUIRED_SECTIONS = {
    "current_state", "scorecard", "fingerprint_summary", "current_regime_context",
    "analogue_consensus", "evidence", "contradictions", "summary",
    "methodology", "disclaimers",
}
VALID_BIASES = {"bullish", "bearish", "neutral", "mixed"}
VALID_RISK = {"low", "moderate", "high", "extreme"}
FORBIDDEN_WORDS = ["buy", "sell", "guarantee", "will rise", "will fall", "target price"]


def check(name, condition, detail=""):
    if condition:
        print(f"PASS  {name}")
    else:
        print(f"FAIL  {name} {detail}")
        FAILURES.append(name)


def segment(n_days, daily_drift, daily_vol, level=100.0):
    rng = np.random.RandomState(abs(hash((n_days, daily_drift, daily_vol))) % (2**31))
    shocks = rng.normal(0.0, 1.0, n_days)
    close = level * np.exp(np.cumsum(daily_drift + daily_vol * shocks))
    high = close * (1.0 + 0.002 + rng.uniform(0.0, 0.002, n_days))
    low = close * (1.0 - 0.002 - rng.uniform(0.0, 0.002, n_days))
    open_ = np.clip(close * rng.uniform(0.998, 1.002, n_days), low, high)
    volume = rng.randint(900_000, 4_000_000, n_days).astype(float)
    return close, high, low, open_, volume


def make_df(sections, start="2022-01-03"):
    total = sum(len(s[0]) for s in sections)
    dates = pd.bdate_range(start, periods=total)
    return pd.DataFrame(
        {
            "Date": dates,
            "Open": np.concatenate([s[3] for s in sections]),
            "High": np.concatenate([s[1] for s in sections]),
            "Low": np.concatenate([s[2] for s in sections]),
            "Close": np.concatenate([s[0] for s in sections]),
            "Volume": np.concatenate([s[4] for s in sections]),
        }
    )


def scenario_bullish():
    return make_df([segment(240, 0.0015, 0.007)])


def scenario_bearish():
    return make_df([segment(240, -0.0018, 0.010)])


def scenario_mixed():
    return make_df([
        segment(130, 0.0012, 0.008),
        segment(110, -0.0025, 0.020),
    ])


def scenario_high_vol():
    # Calm history followed by a violent final stretch: current vol must rank
    # near the top of the dataset's own distribution.
    return make_df([
        segment(180, 0.0002, 0.008),
        segment(60, -0.0010, 0.055),
    ])


def scenario_short():
    return make_df([segment(90, 0.0010, 0.008)])


def contains_no_nan_inf(payload):
    if isinstance(payload, dict):
        return all(contains_no_nan_inf(v) for v in payload.values())
    if isinstance(payload, (list, tuple)):
        return all(contains_no_nan_inf(v) for v in payload)
    if isinstance(payload, float):
        return math.isfinite(payload)
    return True


def validate_common(name, result, json_safe=True):
    check(f"{name}: required sections present", REQUIRED_SECTIONS.issubset(result.keys()),
          f"missing {REQUIRED_SECTIONS - set(result.keys())}")

    scorecard = result["scorecard"]
    conf = scorecard["confidence"]
    check(f"{name}: confidence bounded [0,1]", conf is not None and 0.0 <= conf <= 1.0, f"{conf}")
    check(f"{name}: directional bias valid", scorecard["directional_bias"] in VALID_BIASES)
    check(f"{name}: risk level valid", scorecard["risk_level"] in VALID_RISK)

    ev = result["evidence"]
    component_scores = [ev[k] for k in ("trend_score", "analogue_score", "regime_score", "risk_score") if ev[k] is not None]
    check(f"{name}: component scores within [-1,1]", all(-1.0 <= s <= 1.0 for s in component_scores))

    if json_safe:
        try:
            json.dumps(result, allow_nan=False)
            ok = True
        except ValueError:
            ok = False
        check(f"{name}: JSON-safe (no NaN/inf)", ok and contains_no_nan_inf(result))

    lowered = result["summary"].lower()
    banned = [w for w in FORBIDDEN_WORDS if w in lowered]
    check(f"{name}: summary avoids advice language", not banned, f"found {banned}")


def run_scenario_tests():
    bull = build_market_intelligence(scenario_bullish())
    validate_common("bullish scenario", bull)
    check("bullish scenario reads bullish (not bearish)",
          bull["scorecard"]["directional_bias"] != "bearish"
          and bull["evidence"]["trend_score"] > 0,
          f"bias={bull['scorecard']['directional_bias']}")

    bear = build_market_intelligence(scenario_bearish())
    validate_common("bearish scenario", bear)
    check("bearish scenario reads bearish (not bullish)",
          bear["scorecard"]["directional_bias"] != "bullish"
          and bear["evidence"]["trend_score"] < 0,
          f"bias={bear['scorecard']['directional_bias']}")

    mixed = build_market_intelligence(scenario_mixed())
    validate_common("mixed scenario", mixed)

    wild = build_market_intelligence(scenario_high_vol())
    validate_common("high-volatility scenario", wild)
    check("high-vol scenario flagged elevated/extreme",
          wild["scorecard"]["volatility_state"] in ("elevated", "extreme"),
          wild["scorecard"]["volatility_state"])
    check("high-vol scenario risk high/extreme",
          wild["scorecard"]["risk_level"] in ("high", "extreme"),
          wild["scorecard"]["risk_level"])
    check("high-vol risk score negative", wild["evidence"]["risk_score"] < 0)

    short = build_market_intelligence(scenario_short(), lookback=60)
    validate_common("short-history scenario", short)
    check("short history -> zero valid analogues",
          short["analogue_consensus"]["valid_analogues"] == 0)
    check("short history -> no analogue score", short["evidence"]["analogue_score"] is None)
    check("short history -> regime context absent",
          short["current_regime_context"] is None)

    return bull, mixed


def test_determinism():
    df = scenario_mixed()
    first = build_market_intelligence(df)
    second = build_market_intelligence(df)
    check("intelligence fully deterministic", first == second)


def test_scale_invariance():
    df = scenario_bullish()
    rescaled = df.copy()
    rescaled[["Open", "High", "Low", "Close"]] *= 4.2
    rescaled["Volume"] *= 0.5

    base = build_market_intelligence(df)
    scaled = build_market_intelligence(rescaled)

    keys_equal = ["directional_bias", "risk_level", "confidence", "trend_state",
                  "volatility_state", "drawdown_state", "momentum_state",
                  "current_drawdown", "momentum_20d", "momentum_60d"]
    sc_a, sc_b = base["scorecard"], scaled["scorecard"]
    mismatches = [
        k for k in keys_equal
        if sc_a.get(k) != sc_b.get(k)
        and not (isinstance(sc_a.get(k), float) and isinstance(sc_b.get(k), float)
                 and abs(sc_a[k] - sc_b[k]) < 1e-9)
    ]
    check("scale invariance across scorecard fields", not mismatches, f"differ: {mismatches}")


def mk_analogue(ret5, ret10, ret20, mfe, mae, available=True):
    action = {"available": available, "note": ""}
    if available:
        action.update({
            "return_after_5_days": ret5,
            "return_after_10_days": ret10,
            "return_after_20_days": ret20,
            "max_favourable_move_20d": mfe,
            "max_adverse_move_20d": mae,
        })
    return {"subsequent_market_action": action}


def test_analogue_aggregation_and_leakage():
    analogues = [
        mk_analogue(0.010, 0.020, 0.100, 0.120, -0.020),
        mk_analogue(0.000, 0.010, 0.020, 0.050, -0.050),
        mk_analogue(-0.005, -0.010, -0.040, 0.030, -0.090),
        mk_analogue(None, None, None, None, None, available=False),
    ]
    consensus = analyse_analogues(analogues)

    check("aggregation excludes unavailable analogues",
          consensus["valid_analogues"] == 3 and consensus["total_candidates_reported"] == 4)

    expected_mean20 = (0.100 + 0.020 - 0.040) / 3
    check("mean 20d aggregate correct",
          abs(consensus["mean_20d_forward_return"] - expected_mean20) < 1e-12,
          f"{consensus['mean_20d_forward_return']}")

    arr = np.array([0.100, 0.020, -0.040])
    check("median 20d aggregate correct",
          abs(consensus["median_20d_forward_return"] - np.median(arr)) < 1e-12)
    check("positive frequency correct",
          abs(consensus["positive_20d_frequency"] - 2 / 3) < 1e-12)
    check("std dev matches sample statistic",
          abs(consensus["std_dev_20d_forward_return"] - arr.std(ddof=1)) < 1e-12)
    q75, q25 = np.percentile(arr, [75, 25])
    check("IQR correct", abs(consensus["iqr_20d_forward_return"] - (q75 - q25)) < 1e-12)

    mfe_expected = (0.120 + 0.050 + 0.030) / 3
    mae_expected = (-0.020 - 0.050 - 0.090) / 3
    check("excursion averages correct",
          abs(consensus["avg_20d_favourable_excursion"] - mfe_expected) < 1e-12
          and abs(consensus["avg_20d_adverse_excursion"] - mae_expected) < 1e-12)

    empty = analyse_analogues([mk_analogue(None, None, None, None, None, available=False)])
    check("all-unavailable -> unavailable consensus", empty["available"] is False)


def test_contradiction_rules():
    base_state = {
        "state_flags": {
            "volatility_state": "normal",
            "trend_state": "bullish",
            "drawdown_state": "shallow",
            "momentum_state": "positive",
        },
        "volatility_20d": 0.15,
        "current_drawdown": -0.01,
        "ma20_relationship": "above",
    }
    clean_evidence = {
        "trend_score": 0.5, "analogue_score": 0.4,
        "regime_score": 0.5, "risk_score": -0.1,
    }

    # Case A: bullish trend vs bearish analogues.
    contradicted = detect_contradictions(
        base_state,
        {"available": True, "valid_analogues": 4, "dispersion_index": 0.2,
         "std_dev_20d_forward_return": 0.02},
        {"trend_score": 0.60, "analogue_score": -0.50, "regime_score": None},
        None,
    )
    types = {c["type"] for c in contradicted}
    check("conflict rule: momentum vs analogues", "momentum_vs_analogues" in types, str(types))
    check("conflict entries carry severity/description/template",
          all(c["severity"] in ("low", "medium", "high") and c["description"] and c["type"]
              for c in contradicted))

    # Case B: stacked inconsistencies.
    stressed_state = {
        **base_state,
        "state_flags": {**base_state["state_flags"],
                        "volatility_state": "extreme", "drawdown_state": "severe"},
        "volatility_20d": 0.85,
        "current_drawdown": -0.22,
    }
    stacked = detect_contradictions(
        stressed_state,
        {"available": True, "valid_analogues": 5, "dispersion_index": 0.8,
         "std_dev_20d_forward_return": 0.09},
        {"trend_score": 0.55, "analogue_score": 0.30, "regime_score": 0.45},
        {"regime_label": "Low Volatility Bullish"},
    )
    stacked_types = {c["type"] for c in stacked}
    check("stacked conflicts detected",
          {"regime_vs_volatility", "trend_vs_drawdown",
           "analogue_dispersion_weak"} <= stacked_types, str(stacked_types))

    quiet = detect_contradictions(base_state, {"available": False}, clean_evidence, None)
    check("consistent inputs -> no contradictions", quiet == [])

    regime_flip = detect_contradictions(
        base_state,
        {"available": True, "valid_analogues": 4, "dispersion_index": 0.2,
         "std_dev_20d_forward_return": 0.02},
        {"trend_score": -0.40, "analogue_score": -0.35, "regime_score": 0.45},
        {"regime_label": "Moderate Volatility Bullish"},
    )
    check("regime-vs-trend conflict rule fires",
          any(c["type"] == "regime_vs_trend" for c in regime_flip))


def test_api_integration():
    try:
        from fastapi.testclient import TestClient
    except ImportError as exc:
        check("API test skipped (httpx missing)", False, str(exc))
        return

    import test_support as _ts
    from main import app

    with TestClient(app) as client:

        _ts.login(client)
        csv_bytes = scenario_mixed().to_csv(index=False).encode()
        upload = client.post(
            "/upload",
            files={"file": ("intelligence_test.csv", io.BytesIO(csv_bytes), "text/csv")},
        )
        check("POST /upload for intelligence tests", upload.status_code == 200,
              f"status={upload.status_code}")
        dataset_id = upload.json()["dataset"]["id"]

        resp = client.get(f"/datasets/{dataset_id}/intelligence")
        body = resp.json()
        check("GET /datasets/id/intelligence", resp.status_code == 200)
        check("intelligence response has required sections",
              REQUIRED_SECTIONS.issubset(body.keys()))
        check("first call persisted, not cached",
              body.get("persisted") is True and body["meta"]["cached"] is False)

        resp2 = client.get(f"/datasets/{dataset_id}/intelligence")
        body2 = resp2.json()
        check("second identical call served from cache",
              resp2.status_code == 200 and body2["meta"]["cached"] is True)
        differing = [k for k in REQUIRED_SECTIONS if body.get(k) != body2.get(k)]
        check("cached payload identical to fresh payload", not differing, f"differ: {differing}")

        resp = client.get(f"/datasets/{dataset_id}/intelligence?lookback=80&top_n=3&k=4")
        check("custom parameters accepted", resp.status_code == 200)

        resp = client.get(f"/datasets/{dataset_id}/intelligence?lookback=5")
        check("invalid lookback rejected (422)", resp.status_code == 422)
        resp = client.get(f"/datasets/{dataset_id}/intelligence?top_n=0")
        check("invalid top_n rejected (422)", resp.status_code == 422)
        resp = client.get(f"/datasets/{dataset_id}/intelligence?window_size=999")
        check("invalid window_size rejected (422)", resp.status_code == 422)
        resp = client.get("/datasets/999999/intelligence")
        check("unknown dataset intelligence 404", resp.status_code == 404)

        resp = client.get(f"/datasets/{dataset_id}/intelligence/summary")
        light = resp.json()
        expected_keys = {
            "dataset_id", "current_regime", "directional_bias", "risk_level",
            "confidence", "trend_state", "volatility_state", "analogue_agreement",
            "summary", "disclaimers", "meta",
        }
        check("GET /intelligence/summary lightweight shape",
              resp.status_code == 200 and set(light.keys()) == expected_keys,
              f"keys={set(light.keys()) ^ expected_keys}")

        resp = client.delete(f"/datasets/{dataset_id}")
        check("cleanup DELETE dataset", resp.status_code == 200)

        with database.get_cursor(dictionary=True) as cursor:
            cursor.execute(
                "SELECT COUNT(*) AS n FROM intelligence_snapshots WHERE dataset_id = %s",
                (dataset_id,),
            )
            remaining = cursor.fetchone()["n"]
        check("cascade removed intelligence snapshots", remaining == 0, f"rows={remaining}")
        check("cache lookup after delete is empty",
              database.get_cached_intelligence(dataset_id, "x") is None)


def main():
    run_scenario_tests()
    test_determinism()
    test_scale_invariance()
    test_analogue_aggregation_and_leakage()
    test_contradiction_rules()
    test_api_integration()

    print("-" * 60)
    if FAILURES:
        print(f"RESULT: {len(FAILURES)} FAILURE(S): {FAILURES}")
        sys.exit(1)
    print("RESULT: ALL TESTS PASSED")


if __name__ == "__main__":
    main()
