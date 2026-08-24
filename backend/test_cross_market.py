"""Quantitative self-tests for the Phase 8 cross-market correlation engine.

Run directly: python test_cross_market.py
Uses FastAPI's in-process TestClient against real MySQL; Uvicorn is never started.
"""

import io
import json
import math
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, r"D:\fin\market-dna\backend")

import cross_market
import database

FAILURES = []


def check(name, condition, detail=""):
    if condition:
        print(f"PASS  {name}")
    else:
        print(f"FAIL  {name} {detail}")
        FAILURES.append(name)


def contains_no_nan_inf(payload):
    if isinstance(payload, dict):
        return all(contains_no_nan_inf(v) for v in payload.values())
    if isinstance(payload, (list, tuple)):
        return all(contains_no_nan_inf(v) for v in payload)
    if isinstance(payload, float):
        return math.isfinite(payload)
    return True


def make_frame(closes, start="2022-01-03"):
    closes = np.asarray(closes, dtype=float)
    n = len(closes)
    dates = pd.bdate_range(start, periods=n)
    rng = np.random.RandomState(n * 7 + int(closes[0]))
    high = closes * (1.0 + 0.002)
    low = closes * (1.0 - 0.002)
    open_ = np.clip(closes * rng.uniform(0.998, 1.002, n), low, high)
    volume = np.full(n, 1_000_000.0)
    return pd.DataFrame(
        {
            "Date": dates,
            "Open": open_,
            "High": high,
            "Low": low,
            "Close": closes,
            "Volume": volume,
        }
    )


def series_from(values, start="2022-01-03"):
    index = pd.bdate_range(start, periods=len(values))
    return pd.Series(np.asarray(values, dtype=float), index=index)


def unit_tests():
    # Perfect linear relation: pearson/spearman = 1, covariance hand-checked.
    x = series_from([1.0, 2.0, 3.0, 4.0, 5.0])
    y = series_from([2.0, 4.0, 6.0, 8.0, 10.0])
    pair, aligned = cross_market.compute_pair_statistics(x, y)
    check("unit: aligned on shared dates", pair["overlap_days"] == 5 and len(aligned) == 5)
    check("unit: perfect positive pearson = 1", abs(pair["pearson_correlation"] - 1.0) < 1e-12)
    check("unit: perfect spearman = 1", abs(pair["spearman_correlation"] - 1.0) < 1e-12)
    # cov(x,y) ddof=1 with y=2x equals 2*var(x) = 2*2.5 = 5.
    check("unit: sample covariance exact", abs(pair["covariance"] - 5.0) < 1e-12)

    # Anti-correlated: pearson = -1.
    y_neg = series_from([10.0, 8.0, 6.0, 4.0, 2.0])
    anti, _ = cross_market.compute_pair_statistics(x, y_neg)
    check("unit: perfect negative pearson = -1",
          abs(anti["pearson_correlation"] + 1.0) < 1e-12)

    # Spearman vs Pearson divergence: monotone but non-linear.
    x5 = series_from([1.0, 2.0, 3.0, 4.0, 5.0], start="2023-01-02")
    sq = series_from([1.0, 4.0, 9.0, 16.0, 25.0], start="2023-01-02")
    nonlin, _ = cross_market.compute_pair_statistics(x5, sq)
    check("unit: spearman = 1 for monotone non-linear",
          abs(nonlin["spearman_correlation"] - 1.0) < 1e-12)
    check("unit: pearson < 1 for non-linear relation",
          nonlin["pearson_correlation"] is not None
          and nonlin["pearson_correlation"] < 0.999)

    # Downside/upside conditional correlations are reported with counts.
    rng = np.random.RandomState(42)
    a = series_from(rng.normal(0.0, 0.01, 120))
    b = series_from(rng.normal(0.0, 0.01, 120))
    mixed, _ = cross_market.compute_pair_statistics(a, b)
    check("unit: downside/upside keys present with bounds or null",
          all(v is None or -1.0 <= v <= 1.0
              for v in (mixed["downside_correlation"], mixed["upside_correlation"])))
    check("unit: conditional observation counts reported",
          mixed["downside_observations"] > 0 and mixed["upside_observations"] > 0
          and mixed["downside_observations"] <= 119
          and mixed["upside_observations"] <= 119)

    # Beta recovery: A = 2*B exactly -> beta 2, R^2 1, zero residual stats.
    b120 = series_from(rng.normal(0.0, 0.01, 120), start="2024-01-01")
    a120 = b120 * 2.0
    reg = cross_market.linear_regression_stats(a120.to_numpy(), b120.to_numpy())
    check("unit: beta recovered exactly", abs(reg["beta"] - 2.0) < 1e-9, f"beta={reg['beta']}")
    check("unit: R^2 = 1 for exact relation", abs(reg["r_squared"] - 1.0) < 1e-9)
    check("unit: residual mean ~ 0 for exact relation",
          abs(reg["residual_mean_daily"]) < 1e-12)
    check("unit: residual volatility ~ 0 for exact relation",
          abs(reg["residual_volatility"]) < 1e-12)

    # R^2 bounds on noisy data.
    noisy = b120 + series_from(rng.normal(0.0, 0.005, 120), start="2024-01-01")
    reg_noisy = cross_market.linear_regression_stats(noisy.to_numpy(), b120.to_numpy())
    check("unit: R^2 within [0,1]",
          0.0 <= reg_noisy["r_squared"] <= 1.0,
          f"r2={reg_noisy['r_squared']}")

    # Insufficient overlap: below minimum everything degrades to nulls.
    tiny_a = series_from([0.01, -0.01, 0.02])
    tiny_b = series_from([0.01, -0.01, 0.02])
    tiny, _ = cross_market.compute_pair_statistics(tiny_a, tiny_b)
    check("unit: insufficient overlap flags and nulls",
          tiny["insufficient_overlap"]
          and tiny["overlap_days"] == 3
          and tiny["pearson_correlation"] is None
          and tiny["covariance"] is None)
    tiny_reg = cross_market.linear_regression_stats(
        tiny_a.to_numpy(), tiny_b.to_numpy()
    )
    check("unit: regression unavailable below minimum",
          tiny_reg["available"] is False and tiny_reg["beta"] is None)

    # Rolling correlation length matches alignment; summary windows behave.
    long_aligned = pd.concat([b120.rename("a"), a120.rename("b")], axis=1)
    dates, values = cross_market.rolling_correlation_series(long_aligned, 20)
    check("unit: rolling series length equals observations",
          len(dates) == len(values) == len(long_aligned))
    check("unit: rolling window fills progressively",
          values[18] is None and values[19] is not None)
    summary = cross_market._rolling_summary(long_aligned, 60)
    check("unit: rolling summary available with stats",
          summary["available"]
          and summary["observations"] == len(long_aligned) - 59
          and all(summary[k] is not None for k in ("latest", "mean", "min", "max")))
    short_summary = cross_market._rolling_summary(long_aligned[:30], 60)
    check("unit: rolling summary unavailable when window exceeds data",
          short_summary["available"] is False and short_summary["latest"] is None)

    # Missing dates: only shared dates align.
    left = series_from([0.01, 0.02, -0.01, 0.03, -0.02, 0.01], start="2022-01-03")
    right = series_from([0.01, -0.01, 0.03, -0.02, 0.01], start="2022-01-04")
    gap, _ = cross_market.compute_pair_statistics(left, right)
    check("unit: missing dates excluded from alignment", gap["overlap_days"] == 5,
          f"overlap={gap['overlap_days']}")

    # daily_returns sanitisation: inf from a zero close is dropped.
    frame = make_frame([100, 101, 0, 102, 103, 104, 105])
    returns = cross_market.daily_returns_from_frame(frame)
    check("unit: daily returns drop non-finite values", len(returns) == 5
          and np.isfinite(returns.to_numpy()).all())

    # Scale invariance at function level: x7 prices leave correlations intact.
    base_a = make_frame(list(np.linspace(100, 160, 60)))
    big_a = make_frame([c * 7.0 for c in np.linspace(100, 160, 60)])
    partner = make_frame(
        [c * (1.0 + 0.004) for c in np.linspace(90, 150, 60)]
    )
    ret_a_small = cross_market.daily_returns_from_frame(base_a)
    ret_a_big = cross_market.daily_returns_from_frame(big_a)
    ret_b = cross_market.daily_returns_from_frame(partner)
    pair_small, _ = cross_market.compute_pair_statistics(ret_a_small, ret_b)
    pair_big, _ = cross_market.compute_pair_statistics(ret_a_big, ret_b)
    check("unit: scale-invariant correlations",
          pair_small["pearson_correlation"] is not None
          and abs(pair_big["pearson_correlation"] - pair_small["pearson_correlation"]) < 1e-9,
          f"small={pair_small['pearson_correlation']} big={pair_big['pearson_correlation']}")

    # Covariance scaling property, exact at function level: scaling BOTH
    # series by 7 multiplies covariance by 49 (well-conditioned signal).
    signal = series_from(np.linspace(-0.02, 0.03, 80))
    noise = pd.Series(rng.normal(0.0, 0.002, 80), index=signal.index)
    related = signal * 0.6 + noise
    cov_base, _ = cross_market.compute_pair_statistics(signal, related)
    cov_scaled, _ = cross_market.compute_pair_statistics(signal * 7.0, related * 7.0)
    check("unit: covariance scales by factor squared",
          abs(cov_scaled["covariance"] / (cov_base["covariance"] * 49.0) - 1.0) < 1e-9,
          f"base={cov_base['covariance']} scaled={cov_scaled['covariance']}")

    # Focus builder returns equal-length series and capped scatter.
    focus = cross_market.build_pair_focus(b120, a120)
    check("focus: rolling arrays match overlap length",
          len(focus["20"]["dates"]) == len(b120)
          and len(focus["20"]["values"]) == len(focus["20"]["dates"]))
    check("focus: scatter carries every point below cap",
          focus["scatter"]["total_points"] == len(b120)
          and focus["scatter"]["returned_points"] == focus["scatter"]["total_points"]
          and focus["scatter"]["downsampled"] is False)


def main():
    unit_tests()

    from fastapi.testclient import TestClient
    import test_support as _ts
    from main import app

    def segment(n, drift, vol, seed):
        rng = np.random.RandomState(seed)
        shocks = rng.normal(0.0, 1.0, n)
        close = 100.0 * np.exp(np.cumsum(drift + vol * shocks))
        high = close * 1.002
        low = close * 0.998
        open_ = close * rng.uniform(0.998, 1.002, n)
        volume = np.full(n, 1_000_000.0)
        return pd.DataFrame(
            {
                "Date": pd.bdate_range("2022-01-03", periods=n),
                "Open": open_, "High": high, "Low": low,
                "Close": close, "Volume": volume,
            }
        )

    def upload(client, df, name):
        csv_bytes = df.to_csv(index=False).encode()
        response = client.post(
            "/upload", files={"file": (name, io.BytesIO(csv_bytes), "text/csv")}
        )
        assert response.status_code == 200, response.text
        return response.json()["dataset"]["id"]

    with TestClient(app) as client:

        _ts.login(client)
        id_a = upload(client, segment(240, 0.001, 0.008, 11), "xm_a.csv")
        id_b = upload(client, segment(240, 0.0005, 0.012, 22), "xm_b.csv")
        id_c = upload(client, segment(240, -0.0008, 0.02, 33), "xm_c.csv")

        response = client.get(f"/datasets/compare/correlation?ids={id_a},{id_b},{id_c}")
        body = response.json()
        check("endpoint: three-dataset correlation", response.status_code == 200,
              f"status={response.status_code} body={body.get('detail', '')!r}")

        matrices = body.get("matrices", {})
        names = ("pearson", "spearman", "downside", "upside", "overlap_count")
        check("endpoint: all five correlation/overlap matrices present",
              all(m in matrices for m in names) and "covariance" in matrices)
        size = 3
        check("endpoint: matrices symmetric",
              all(matrices[m][i][j] == matrices[m][j][i]
                  for m in names + ("covariance",)
                  for i in range(size) for j in range(size)))
        check("endpoint: diagonal correlations are 1",
              all(matrices[m][i][i] == 1.0 for m in ("pearson", "spearman") for i in range(size)))
        check("endpoint: overlap diagonal equals own return count",
              all(isinstance(matrices["overlap_count"][i][i], int)
                  and matrices["overlap_count"][i][i] >= 238 for i in range(size)),
              f"diag={[matrices['overlap_count'][i][i] for i in range(size)]}")
        check("endpoint: JSON-safe payload",
              contains_no_nan_inf(body) and json.dumps(body, allow_nan=False) is not None)

        pairs = body.get("pairs", [])
        check("endpoint: three unordered pairs", len(pairs) == 3)
        first = pairs[0]
        check("endpoint: rolling summaries per window",
              set(first["rolling"].keys()) == {"20", "60"}
              and all(first["rolling"][w]["available"] for w in ("20", "60"))
              and all(first["rolling"][w][k] is not None
                      for w in ("20", "60")
                      for k in ("latest", "mean", "min", "max")))
        check("endpoint: both directional regressions present",
              "regression_a_relative_to_b" in first and "regression_b_relative_to_a" in first)
        regs = [first["regression_a_relative_to_b"], first["regression_b_relative_to_a"]]
        check("endpoint: beta/R-squared valid",
              all(r["available"] and r["beta"] is not None
                  and r["r_squared"] is not None and 0.0 <= r["r_squared"] <= 1.0
                  for r in regs))
        check("endpoint: methodology labels regression as historical",
              "not" in body["methodology"]["regression_note"]
              and "causation" in body["disclaimer"])

        # Overlap metadata.
        overlap = body.get("overlap", {})
        check("endpoint: overlap range reported",
              overlap["start_date"] is not None and overlap["end_date"] is not None
              and overlap["minimum_pairwise_overlap"] >= 238)

        # Focus pair block.
        response = client.get(
            f"/datasets/compare/correlation?ids={id_a},{id_b},{id_c}&pair_focus={id_a},{id_b}"
        )
        focused = response.json()
        check("focus endpoint: block returned",
              response.status_code == 200 and focused.get("focus", {}).get("dataset_a") == id_a)
        focus = focused.get("focus", {})
        n_obs = next(p["overlap_days"] for p in focused["pairs"]
                     if {p["dataset_a"], p["dataset_b"]} == {id_a, id_b})
        check("focus: series lengths equal overlap days",
              len(focus["20"]["dates"]) == n_obs
              and len(focus["60"]["values"]) == n_obs)
        check("focus: scatter points align",
              focus["scatter"]["total_points"] == n_obs
              and all(set(p.keys()) == {"date", "return_a", "return_b"}
                      for p in focus["scatter"]["points"]))
        check("focus: regression duplicated consistently",
              abs(focus["regression_a_relative_to_b"]["beta"]
                  - next(p["regression_a_relative_to_b"]["beta"] for p in focused["pairs"]
                         if {p["dataset_a"], p["dataset_b"]} == {id_a, id_b})) < 1e-12)

        # Scale invariance through the full endpoint.
        scaled_df = segment(240, 0.001, 0.008, 11)
        scaled_df[["Open", "High", "Low", "Close"]] = (
            scaled_df[["Open", "High", "Low", "Close"]] * 7.0
        )
        scaled_id = upload(client, scaled_df, "xm_scaled.csv")
        base = client.get(f"/datasets/compare/correlation?ids={id_a},{id_b}").json()["pairs"][0]
        scaled = client.get(f"/datasets/compare/correlation?ids={scaled_id},{id_b}").json()["pairs"][0]
        check("scale invariance: pearson unchanged under price rescaling",
              abs(base["pearson_correlation"] - scaled["pearson_correlation"]) < 1e-6,
              f"{base['pearson_correlation']} vs {scaled['pearson_correlation']}")
        check("scale invariance: spearman/downside/upside unchanged",
              all(
                  (b is None and s is None)
                  or abs(b - s) < 1e-6
                  for b, s in (
                      (base["spearman_correlation"], scaled["spearman_correlation"]),
                      (base["downside_correlation"], scaled["downside_correlation"]),
                      (base["upside_correlation"], scaled["upside_correlation"]),
                  )
              ))

        # Mismatched ranges: partial overlap shrinks observations.
        short_id = upload(client, segment(80, 0.001, 0.01, 44), "xm_short.csv")
        partial = client.get(f"/datasets/compare/correlation?ids={id_a},{short_id}").json()
        ppair = partial["pairs"][0]
        check("mismatched ranges: overlap bounded by shorter dataset",
              ppair["overlap_days"] <= 79 and not ppair["insufficient_overlap"])
        check("mismatched ranges: overlap window reported per pair",
              ppair["start_date"] is not None and ppair["end_date"] is not None)

        # Fully disjoint ranges: still 200, null statistics, flagged.
        future_df = segment(240, 0.001, 0.01, 55)
        future_df["Date"] = pd.bdate_range("2030-01-02", periods=240)
        future_id = upload(client, future_df, "xm_future.csv")
        disjoint_resp = client.get(f"/datasets/compare/correlation?ids={id_a},{future_id}")
        disjoint = disjoint_resp.json()
        dpair = disjoint["pairs"][0]
        check("disjoint ranges: request succeeds with empty statistics",
              disjoint_resp.status_code == 200
              and dpair["overlap_days"] == 0
              and dpair["insufficient_overlap"]
              and dpair["pearson_correlation"] is None
              and disjoint["matrices"]["pearson"][0][1] is None
              and disjoint["overlap"]["start_date"] is None)

        # Validation.
        check("bounds: single dataset rejected (422)",
              client.get(f"/datasets/compare/correlation?ids={id_a}").status_code == 422)
        eleven = ",".join(str(i) for i in range(900001, 900012))
        check("bounds: eleven datasets rejected (422)",
              client.get(f"/datasets/compare/correlation?ids={eleven}").status_code == 422)
        ten = ",".join(str(i) for i in range(900001, 900011))
        resp_ten = client.get(f"/datasets/compare/correlation?ids={ten}")
        check("bounds: ten unknown ids pass validation then 404 on lookup",
              resp_ten.status_code == 404, f"status={resp_ten.status_code}")
        check("duplicates rejected (422)",
              client.get(f"/datasets/compare/correlation?ids={id_a},{id_a}").status_code == 422)
        check("unknown dataset rejected (404)",
              client.get(f"/datasets/compare/correlation?ids={id_a},999999").status_code == 404)
        check("non-numeric ids rejected (422)",
              client.get("/datasets/compare/correlation?ids=abc,def").status_code == 422)
        check("pair_focus outside selection rejected (422)",
              client.get(
                  f"/datasets/compare/correlation?ids={id_a},{id_b}&pair_focus={id_a},{id_c}"
              ).status_code == 422)
        check("pair_focus malformed rejected (422)",
              client.get(
                  f"/datasets/compare/correlation?ids={id_a},{id_b}&pair_focus={id_a}"
              ).status_code == 422)

        # Cleanup.
        uploaded = [id_a, id_b, id_c, scaled_id, short_id, future_id]
        for dataset_id in uploaded:
            client.delete(f"/datasets/{dataset_id}")
        with database.get_cursor(dictionary=True) as cursor:
            cursor.execute(
                "SELECT COUNT(*) AS n FROM datasets WHERE id IN (%s,%s,%s,%s,%s,%s)",
                tuple(uploaded),
            )
            remaining = cursor.fetchone()["n"]
        check("cleanup removed cross-market datasets", remaining == 0)

    print("-" * 60)
    if FAILURES:
        print(f"RESULT: {len(FAILURES)} FAILURE(S): {FAILURES}")
        sys.exit(1)
    print("RESULT: ALL TESTS PASSED")


if __name__ == "__main__":
    main()
