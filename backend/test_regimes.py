"""Quantitative self-tests for QUANT VECTOR regime discovery (Phase 4).

Deterministic synthetic OHLCV data with deliberately distinct statistical
sections (low-vol uptrend, high-vol decline, sideways, volatile recovery).
Run directly:  python test_regimes.py

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

import regimes
from fingerprint import generate_market_windows
from regimes import (
    K_MAX,
    K_MIN,
    MIN_WINDOWS,
    REGIME_FEATURES,
    discover_regimes,
    fit_pca,
    prepare_feature_matrix,
)
from sklearn.preprocessing import StandardScaler

FAILURES = []


def check(name, condition, detail=""):
    if condition:
        print(f"PASS  {name}")
    else:
        print(f"FAIL  {name} {detail}")
        FAILURES.append(name)


def build_segment(n_days, daily_drift, daily_vol, level=100.0, ar_coeff=0.0):
    """Deterministic geometric walk; ar_coeff adds mean-reverting memory."""
    rng = np.random.RandomState(hash((n_days, daily_drift, daily_vol)) % (2**31))
    shocks = rng.normal(0.0, 1.0, n_days)
    log_ret = np.empty(n_days)
    prev = 0.0
    for i in range(n_days):
        log_ret[i] = daily_drift + daily_vol * shocks[i] + ar_coeff * prev
        prev = log_ret[i]
    close = level * np.exp(np.cumsum(log_ret))
    high = close * (1.0 + 0.002 + rng.uniform(0.0, 0.003, n_days))
    low = close * (1.0 - 0.002 - rng.uniform(0.0, 0.003, n_days))
    open_ = np.clip(close * rng.uniform(0.998, 1.002, n_days), low, high)
    volume = rng.randint(900_000, 4_000_000, n_days).astype(float)
    return close, high, low, open_, volume


def build_multiregime_ohlcv():
    """Four deliberately different statistical sections."""
    sections = [
        build_segment(160, 0.0012, 0.006),   # low-volatility uptrend
        build_segment(130, -0.0025, 0.030, level=110.0),   # high-vol decline
        build_segment(140, 0.0000, 0.007, level=95.0, ar_coeff=-0.55),  # sideways mean-reverting
        build_segment(120, 0.0018, 0.020, level=95.0),     # volatile recovery
    ]
    rows = len(sections[0][0]) + sum(len(s[0]) for s in sections[1:])
    dates = pd.bdate_range("2022-01-03", periods=rows)

    close = np.concatenate([s[0] for s in sections])
    high = np.concatenate([s[1] for s in sections])
    low = np.concatenate([s[2] for s in sections])
    open_ = np.concatenate([s[3] for s in sections])
    volume = np.concatenate([s[4] for s in sections])

    return pd.DataFrame(
        {
            "Date": dates,
            "Open": open_,
            "High": high,
            "Low": low,
            "Close": close,
            "Volume": volume,
        }
    )


def contains_no_nan_inf(payload):
    if isinstance(payload, dict):
        return all(contains_no_nan_inf(v) for v in payload.values())
    if isinstance(payload, (list, tuple)):
        return all(contains_no_nan_inf(v) for v in payload)
    if isinstance(payload, float):
        return math.isfinite(payload)
    return True


def test_preprocessing_pipeline():
    raw = np.array(
        [
            [0.01, 0.50, 5.0, np.nan],
            [-0.02, 0.55, 5.0, np.nan],
            [0.03, 0.48, 5.0, np.nan],
            [0.01, 0.52, 5.0, np.nan],
            [-0.01, 0.51, 5.0, np.nan],
        ]
    )
    names = ["normal_a", "normal_b", "constant", "all_missing"]
    cleaned, meta = prepare_feature_matrix(raw, names)
    check("preprocessing drops constant/all-missing features",
          cleaned is not None
          and meta["used"] == ["normal_a", "normal_b"]
          and {d["feature"] for d in meta["dropped"]} == {"constant", "all_missing"})
    check("cleaned matrix finite", cleaned is not None and np.all(np.isfinite(cleaned)))

    hopeless = np.full((5, 2), np.nan)
    cleaned_none, _ = prepare_feature_matrix(hopeless, ["a", "b"])
    check("all-unusable matrix -> None", cleaned_none is None)


def test_discovery_core():
    df = build_multiregime_ohlcv()
    result = discover_regimes(df, window_size=60)

    check("discovery available", result["available"] is True,
          result.get("message", ""))

    used_features = result["features"]["used"]
    check("only scale-invariant features used",
          set(used_features).issubset(set(REGIME_FEATURES)))

    k = result["model"]["selected_k"]
    check("selected k within allowed range", K_MIN <= k <= K_MAX, f"k={k}")
    check("regime count equals k", len(result["regimes"]) == k)

    labels = [t["regime_id"] for t in result["timeline"]]
    check("every window assigned a valid regime id",
          all(rid in range(k) for rid in labels))
    check("timeline length matches windows", len(labels) == result["n_windows"])

    scaled_check = not any(
        name in used_features for name in ("ma20", "ma50", "volume_mean")
    )
    check("no absolute price levels among features", scaled_check)

    json.dumps(result, allow_nan=False)
    check("full discovery payload JSON-safe", True)


def test_determinism():
    df = build_multiregime_ohlcv()
    first = discover_regimes(df, window_size=60)
    second = discover_regimes(df, window_size=60)

    check("selected k deterministic",
          first["model"]["selected_k"] == second["model"]["selected_k"])
    check("regime sequence deterministic",
          [t["regime_id"] for t in first["timeline"]]
          == [t["regime_id"] for t in second["timeline"]])
    check("labels deterministic",
          [p["label"] for p in first["regimes"]] == [p["label"] for p in second["regimes"]])


def test_pca():
    df = build_multiregime_ohlcv()
    windows = generate_market_windows(df, window_size=60, stride=max(1, 60 // 4))
    raw = np.array(
        [[w["features"].get(f) for f in REGIME_FEATURES] for w in windows], dtype=float
    )
    clean, meta = prepare_feature_matrix(raw, REGIME_FEATURES)
    scaled = StandardScaler().fit_transform(clean)
    pca = fit_pca(scaled)

    ratios = pca["explained_variance_ratio"]
    cumulative = pca["cumulative_explained_variance"]

    check("explained variances within [0, 1]", all(0 <= r <= 1 for r in ratios))
    check("cumulative variance monotonic non-decreasing",
          all(cumulative[i] <= cumulative[i + 1] + 1e-9 for i in range(len(cumulative) - 1)))
    check("component count bounded", 2 <= pca["n_components"] <= min(10, len(meta["used"])))
    retained_cum = cumulative[pca["n_components"] - 1]
    check("retained components explain >= 85% or cap reached",
          retained_cum >= 0.85 - 1e-9 or pca["n_components"] == min(10, len(meta["used"])),
          f"cum={retained_cum:.3f}")
    check("loadings shape matches", len(pca["loadings"]) == pca["n_components"]
          and all(len(row) == len(meta["used"]) for row in pca["loadings"]))
    check("one coordinate row per window", len(pca["coordinates"]) == len(windows))


def test_profiles_timeline_current():
    df = build_multiregime_ohlcv()
    result = discover_regimes(df, window_size=60)

    profiles = result["regimes"]
    total = sum(p["window_count"] for p in profiles)
    check("profile counts sum to all windows", total == result["n_windows"])

    shares_ok = all(
        abs(p["percentage_of_windows"] - p["window_count"] / result["n_windows"]) < 1e-9
        for p in profiles
    )
    check("percentages correct", shares_ok)

    ends = [t["end_date"] for t in result["timeline"]]
    check("timeline chronologically ordered", ends == sorted(ends))

    current = result["current_regime"]
    check("current regime exists", current is not None)
    check("current regime has profile",
          any(p["regime_id"] == current["regime_id"] for p in profiles))
    check("current duration positive", current["duration_windows"] >= 1)
    check("top next regimes bounded probabilities",
          all(0 <= t["historical_probability"] <= 1
              for t in current["most_common_next_regimes"]))
    check("labels are descriptive strings",
          all(isinstance(p["label"], str) and len(p["label"]) > 3 for p in profiles))


def test_transitions():
    df = build_multiregime_ohlcv()
    result = discover_regimes(df, window_size=60)
    tm = result["transitions"]

    size = len(tm["regime_ids"])
    check("transition matrix square", all(len(r) == size for r in tm["counts"]))
    check("transition counts match window pairs",
          sum(sum(r) for r in tm["counts"]) == result["n_windows"] - 1)

    probs_valid = all(0 <= p <= 1 for row in tm["probabilities"] for p in row)
    check("transition probabilities in [0, 1]", probs_valid)

    rows_sum = [
        sum(row) for row, cnt in zip(tm["probabilities"], tm["counts"]) if sum(cnt) > 0
    ]
    check("rows with transitions sum to ~1",
          all(abs(s - 1.0) < 1e-6 for s in rows_sum), f"{rows_sum}")

    last_rid = result["timeline"][-1]["regime_id"]
    pos = tm["regime_ids"].index(last_rid)
    outgoing = sum(tm["counts"][pos])
    check("current regime transition row consistent",
          outgoing >= 1 if result["n_windows"] > 1 else outgoing >= 0)


def test_forward_outcomes_no_leakage():
    df = build_multiregime_ohlcv()
    n = len(df)
    result = discover_regimes(df, window_size=60)

    timeline = result["timeline"]
    per_regime_eligible = {
        rid: sum(
            1 for t in timeline
            if t["regime_id"] == rid and t["window_end_index"] + 20 <= n - 1
        )
        for rid in range(result["model"]["selected_k"])
    }
    actual = {
        p["regime_id"]: p["forward_outcomes"]["samples_with_full_horizon"]
        for p in result["regimes"]
    }
    check("no future-data leakage in outcomes", actual == per_regime_eligible,
          f"actual={actual} expected={per_regime_eligible}")

    unavailable = [
        p for p in result["regimes"]
        if p["forward_outcomes"]["available"] is False
    ]
    check("regimes without future data flagged unavailable",
          all(u["forward_outcomes"]["samples_with_full_horizon"] == 0 for u in unavailable))

    prob_positive = [
        p["forward_outcomes"]["probability_positive_after_20_days"]
        for p in result["regimes"] if p["forward_outcomes"]["available"]
    ]
    check("probability of positive 20d within [0, 1]",
          all(0 <= x <= 1 for x in prob_positive))


def test_insufficient_data():
    short = build_multiregime_ohlcv().iloc[:100]
    result = discover_regimes(short, window_size=60)
    check("insufficient history -> unavailable", result["available"] is False)
    check("insufficient history explains why", "Not enough history" in result["message"])
    json.dumps(result, allow_nan=False)
    check("insufficient payload JSON-safe", True)

    try:
        discover_regimes(short, window_size=10)
        bad_window_ok = False
    except ValueError:
        bad_window_ok = True
    check("window_size below engine minimum raises cleanly", bad_window_ok)


def test_scale_invariance():
    df = build_multiregime_ohlcv()
    rescaled = df.copy()
    rescaled[["Open", "High", "Low", "Close"]] *= 5.7
    rescaled["Volume"] *= 0.3

    base = discover_regimes(df, window_size=60)
    scaled = discover_regimes(rescaled, window_size=60)

    check("scale invariance: same k selected",
          base["model"]["selected_k"] == scaled["model"]["selected_k"])
    check("scale invariance: identical regime sequence",
          [t["regime_id"] for t in base["timeline"]]
          == [t["regime_id"] for t in scaled["timeline"]])


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
        csv_bytes = build_multiregime_ohlcv().to_csv(index=False).encode()
        upload = client.post(
            "/upload",
            files={"file": ("regime_test.csv", io.BytesIO(csv_bytes), "text/csv")},
        )
        check("POST /upload for regime tests", upload.status_code == 200,
              f"status={upload.status_code}")
        dataset_id = upload.json()["dataset"]["id"]

        resp = client.get(f"/datasets/{dataset_id}/regimes")
        body = resp.json()
        check("GET /datasets/id/regimes", resp.status_code == 200)
        check("regimes persisted flag", body.get("persisted") is True)
        check("regimes payload JSON-safe", contains_no_nan_inf(body))
        check("regimes response has all sections",
              all(key in body for key in (
                  "model", "pca", "features", "regimes", "timeline",
                  "transitions", "current_regime", "disclaimer")))

        resp = client.get(f"/datasets/{dataset_id}/regimes?k=3")
        body_k = resp.json()
        check("k override honoured", resp.status_code == 200
              and body_k["model"]["selected_k"] == 3
              and body_k["model"]["auto_selected"] is False)

        resp = client.get(f"/datasets/{dataset_id}/regimes?window_size=120")
        check("custom window_size accepted", resp.status_code == 200)

        resp = client.get(f"/datasets/{dataset_id}/regimes?k=1")
        check("k below bound rejected (422)", resp.status_code == 422)

        resp = client.get(f"/datasets/{dataset_id}/regimes?window_size=500")
        check("window_size above bound rejected (422)", resp.status_code == 422)

        resp = client.get(f"/datasets/{dataset_id}/regimes/current")
        body_cur = resp.json()
        check("GET /datasets/id/regimes/current", resp.status_code == 200)
        check("current endpoint lightweight",
              set(body_cur.keys()) == {"dataset_id", "window_size", "persisted",
                                       "current_regime", "disclaimer"})
        check("lightweight current has streak info",
              body_cur["current_regime"]["duration_windows"] >= 1)

        resp = client.get("/datasets/999999/regimes")
        check("unknown dataset regimes 404", resp.status_code == 404)

        resp = client.delete(f"/datasets/{dataset_id}")
        check("cleanup DELETE dataset", resp.status_code == 200)


def main():
    test_preprocessing_pipeline()
    test_discovery_core()
    test_determinism()
    test_pca()
    test_profiles_timeline_current()
    test_transitions()
    test_forward_outcomes_no_leakage()
    test_insufficient_data()
    test_scale_invariance()
    test_api_integration()

    print("-" * 60)
    if FAILURES:
        print(f"RESULT: {len(FAILURES)} FAILURE(S): {FAILURES}")
        sys.exit(1)
    print("RESULT: ALL TESTS PASSED")


if __name__ == "__main__":
    main()
