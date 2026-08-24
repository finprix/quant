"""Quantitative self-tests for the QUANT VECTOR fingerprinting engine.

Uses deterministic synthetic OHLCV data (seeded) purely to verify the
mathematics. Run directly:  python test_fingerprint.py

The API section exercises FastAPI's in-process TestClient (no Uvicorn is
started) against the real MySQL database and cleans up after itself.
"""

import io
import json
import math
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, r"D:\fin\market-dna\backend")

import fingerprint
from fingerprint import (
    VECTOR_FEATURES,
    build_fingerprint_vector,
    calculate_fingerprint,
    dataframe_from_price_records,
    find_historical_analogues,
    generate_market_windows,
)

FAILURES = []


def check(name, condition, detail=""):
    if condition:
        print(f"PASS  {name}")
    else:
        print(f"FAIL  {name} {detail}")
        FAILURES.append(name)


def build_synthetic_ohlcv(rows=420, seed=42):
    """Deterministic regime-switching geometric random walk."""
    rs = np.random.RandomState(seed)
    idx = np.arange(rows)
    drift = np.where(idx < rows // 2, 0.0008, -0.0004)
    vol = np.where(idx < rows // 2, 0.009, 0.022)

    log_returns = drift + vol * rs.normal(0.0, 1.0, rows)
    close = 100.0 * np.exp(np.cumsum(log_returns))

    high = close * (1.0 + 0.004 + rs.uniform(0.0, 0.004, rows))
    low = close * (1.0 - 0.004 - rs.uniform(0.0, 0.004, rows))
    open_ = np.clip(close * rs.uniform(0.995, 1.005, rows), low, high)
    volume = rs.randint(800_000, 5_000_000, rows).astype(float)

    dates = pd.bdate_range("2022-01-03", periods=rows)
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
    """Recursively verify JSON-safety of a nested structure."""
    if isinstance(payload, dict):
        return all(contains_no_nan_inf(v) for v in payload.values())
    if isinstance(payload, (list, tuple)):
        return all(contains_no_nan_inf(v) for v in payload)
    if isinstance(payload, float):
        return math.isfinite(payload)
    return True


def test_fingerprint_generation():
    df = build_synthetic_ohlcv()
    fp = calculate_fingerprint(df)

    expected_keys = {
        "mean_daily_return", "median_daily_return", "std_daily_return",
        "annualized_volatility", "skewness", "kurtosis",
        "positive_return_ratio", "negative_return_ratio",
        "best_daily_return", "worst_daily_return",
        "max_drawdown", "avg_drawdown", "downside_deviation",
        "var_95", "cvar_95",
        "ma20", "ma50", "ma20_ma50_ratio", "ma20_ma50_relationship",
        "distance_from_ma20", "distance_from_ma50",
        "momentum_20", "momentum_60",
        "volatility_20d", "autocorrelation_lag1", "autocorrelation_lag5",
        "volume_mean", "volume_std", "volume_to_average_ratio",
    }
    check("fingerprint has all keys", expected_keys.issubset(fp.keys()),
          f"missing: {expected_keys - set(fp.keys())}")

    check("volatility positive", fp["annualized_volatility"] > 0)
    check("max drawdown <= 0", fp["max_drawdown"] <= 0)
    check("avg drawdown <= 0", fp["avg_drawdown"] <= 0)
    check("ratio bounds", fp["positive_return_ratio"] + fp["negative_return_ratio"] <= 1.0)
    check("var95 <= cvar95 (left tail)", fp["var_95"] >= fp["cvar_95"])
    check("downside deviation positive", fp["downside_deviation"] > 0)
    check("relationship label valid",
          fp["ma20_ma50_relationship"] in ("above", "below", "equal"))
    check("sample counts", fp["sample_count"] == len(df) and fp["return_sample_count"] == len(df) - 1)

    json.dumps(fp, allow_nan=False)
    check("fingerprint is JSON-safe (no NaN/inf)", True)


def test_fingerprint_insufficient_data():
    tiny = build_synthetic_ohlcv(rows=40).copy()
    fp = calculate_fingerprint(tiny)

    none_expected = ["ma50", "momentum_60", "autocorrelation_lag5", "cvar_95", "var_95"]
    check("insufficient data -> None metrics",
          all(fp[k] is None for k in none_expected),
          f"got: {{k: fp[k] for k in none_expected}}")

    available = ["mean_daily_return", "max_drawdown", "momentum_20"]
    check("short history still yields core metrics",
          all(fp[k] is not None for k in available))

    minimal = build_synthetic_ohlcv(rows=3).copy()
    fp_min = calculate_fingerprint(minimal)
    check("3-row dataset does not crash", fp_min["sample_count"] == 3)
    check("3-row dataset sanitized", contains_no_nan_inf(fp_min))


def test_price_scale_invariance():
    """Vectors must describe behaviour, not price level."""
    df = build_synthetic_ohlcv()
    rescaled = df.copy()
    rescaled[["Open", "High", "Low", "Close"]] *= 7.31
    rescaled["Volume"] *= 3.0

    v1 = build_fingerprint_vector(df)
    v2 = build_fingerprint_vector(rescaled)

    check("vector length matches features", len(v1) == len(VECTOR_FEATURES))
    check("vector ignores absolute price scale", np.allclose(v1, v2, atol=1e-6),
          f"max diff {np.nanmax(np.abs(v1 - v2))}")


def test_rolling_windows():
    df = build_synthetic_ohlcv()
    w, stride = 60, 5
    windows = generate_market_windows(df, window_size=w, stride=stride)

    expected_count = (len(df) - w) // stride + 1
    check("window count formula", len(windows) == expected_count,
          f"got {len(windows)}, expected {expected_count}")

    spans_ok = all(win["end_index"] - win["start_index"] + 1 == w for win in windows)
    check("every window spans exactly 60 bars", spans_ok)

    ordered = all(
        windows[i]["end_date"] <= windows[i + 1]["end_date"]
        for i in range(len(windows) - 1)
    )
    check("windows chronological", ordered)

    first_end = df["Date"].iloc[w - 1].strftime("%Y-%m-%d")
    check("first window ends at bar 59", windows[0]["end_date"] == first_end)

    vector_ok = all(
        len(win["vector"]) == len(VECTOR_FEATURES)
        for win in windows
    )
    check("window vectors aligned to feature list", vector_ok)

    empty = generate_market_windows(df.iloc[:30], window_size=w)
    check("windows insufficient data -> []", empty == [])


def test_analogue_detection():
    df = build_synthetic_ohlcv()
    lookback, top_n = 60, 5
    result = find_historical_analogues(df, lookback=lookback, top_n=top_n)

    analogues = result["analogues"]
    check("analogues found", len(analogues) > 0)
    check("at most top_n analogues", len(analogues) <= top_n)

    current_start = result["current_window"]["start_date"]

    def overlaps_current(a):
        return a["end_date"] >= current_start

    check("current window excluded (no overlap)",
          not any(overlaps_current(a) for a in analogues))

    sims = [a["similarity_score"] for a in analogues]
    check("similarity scores bounded (0, 1]", all(0 < s <= 1.0 for s in sims), f"{sims}")
    check("distances non-negative", all(a["distance"] >= 0 for a in analogues))
    check("ranks ascending", [a["rank"] for a in analogues] == list(range(1, len(analogues) + 1)))
    check("sorted by similarity desc",
          all(sims[i] >= sims[i + 1] for i in range(len(sims) - 1)))

    min_sep = max(1, lookback // 2)
    dates_sorted = sorted(a["end_date"] for a in analogues)
    gap_days = [
        int((pd.Timestamp(dates_sorted[i + 1]) - pd.Timestamp(dates_sorted[i])).days)
        for i in range(len(dates_sorted) - 1)
    ]
    check("temporal suppression applied (~min separation)", all(g >= min_sep * 1.4 for g in gap_days),
          f"gaps(calendar days): {gap_days}")

    earliest = min(analogues, key=lambda a: a["end_date"])
    sma = earliest["subsequent_market_action"]
    check("future outcomes present for early analogue", sma["available"] is True)
    check("forward returns are floats or None",
          all(sma[k] is None or isinstance(sma[k], float)
              for k in ("return_after_5_days", "return_after_10_days", "return_after_20_days")))
    check("MFE >= MAE", sma["max_favourable_move_20d"] >= sma["max_adverse_move_20d"])
    check("observational disclaimer present", "not a prediction" in sma["note"])

    late = max(analogues, key=lambda a: a["end_date"])
    check("analogue structure complete",
          all(k in late for k in ("start_date", "end_date", "distance",
                                  "similarity_score", "characteristics")))


def test_analogue_insufficient_data():
    df = build_synthetic_ohlcv(rows=90)
    result = find_historical_analogues(df, lookback=60, top_n=5)
    check("insufficient history -> empty analogues", result["analogues"] == [])
    check("insufficient history explained", "Need at least" in result.get("message", ""))


def test_api_integration():
    """Exercise the HTTP layer in-process via TestClient (no Uvicorn)."""
    try:
        from fastapi.testclient import TestClient
    except ImportError as exc:
        check("API test skipped (httpx missing)", False, str(exc))
        return

    import test_support as _ts
    from main import app

    with TestClient(app) as client:

        _ts.login(client)
        health = client.get("/health").json()
        check("GET /health", health == {"status": "ok"})

        csv_bytes = build_synthetic_ohlcv().to_csv(index=False).encode()
        upload = client.post(
            "/upload",
            files={"file": ("synthetic_test.csv", io.BytesIO(csv_bytes), "text/csv")},
        )
        check("POST /upload stores dataset", upload.status_code == 200,
              f"status={upload.status_code} body={upload.text[:400]}")
        dataset_id = upload.json()["dataset"]["id"]

        resp = client.get(f"/datasets/{dataset_id}/fingerprint")
        body = resp.json()
        check("GET /datasets/id/fingerprint", resp.status_code == 200)
        check("fingerprint persisted flag", body.get("persisted") is True)
        check("fingerprint response JSON-safe", contains_no_nan_inf(body))

        resp = client.get(f"/datasets/{dataset_id}/analogues")
        body = resp.json()
        check("GET /datasets/id/analogues", resp.status_code == 200)
        check("analogues endpoint respects top_n", len(body["analogues"]) <= 5)
        check("analogues persisted flag", body.get("persisted") is True)
        check("analogues carry disclaimer", "not predictions" in body["disclaimer"])

        resp = client.get(f"/datasets/{dataset_id}/analogues?top_n=2&lookback=80")
        check("query params accepted", resp.status_code == 200 and len(resp.json()["analogues"]) <= 2)

        resp = client.get(f"/datasets/{dataset_id}/analogues?lookback=10")
        check("invalid lookback rejected (422)", resp.status_code == 422)

        resp = client.get("/datasets/999999/fingerprint")
        check("unknown dataset fingerprint 404", resp.status_code == 404)

        resp = client.delete(f"/datasets/{dataset_id}")
        check("cleanup DELETE dataset", resp.status_code == 200)
        check("second DELETE returns 404", client.delete(f"/datasets/{dataset_id}").status_code == 404)


def main():
    test_fingerprint_generation()
    test_fingerprint_insufficient_data()
    test_price_scale_invariance()
    test_rolling_windows()
    test_analogue_detection()
    test_analogue_insufficient_data()
    test_api_integration()

    print("-" * 60)
    if FAILURES:
        print(f"RESULT: {len(FAILURES)} FAILURE(S): {FAILURES}")
        sys.exit(1)
    print("RESULT: ALL TESTS PASSED")


if __name__ == "__main__":
    main()
