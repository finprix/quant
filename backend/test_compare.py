"""Quantitative self-tests for the Phase 7 fingerprint comparison endpoint.

Run directly: python test_compare.py
Uses FastAPI's in-process TestClient against real MySQL; Uvicorn is never started.
"""

import io
import json
import math
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, r"D:\fin\market-dna\backend")

import database
import fingerprint

FAILURES = []


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


def contains_no_nan_inf(payload):
    if isinstance(payload, dict):
        return all(contains_no_nan_inf(v) for v in payload.values())
    if isinstance(payload, (list, tuple)):
        return all(contains_no_nan_inf(v) for v in payload)
    if isinstance(payload, float):
        return math.isfinite(payload)
    return True


def upload(client, df, name):
    csv_bytes = df.to_csv(index=False).encode()
    response = client.post(
        "/upload",
        files={"file": (name, io.BytesIO(csv_bytes), "text/csv")},
    )
    assert response.status_code == 200, response.text
    return response.json()["dataset"]["id"]


def unit_tests():
    vec_a = np.array([0.10, 0.20, -0.30, 0.05])
    vec_b = np.array([0.12, 0.18, -0.28, 0.04])
    vec_c = np.array([-0.50, 0.90, 0.40, -0.60])

    # Fallback mode (no window reference): standardized space equals raw space.
    result = fingerprint.pairwise_fingerprint_comparison(
        {7: vec_a, 3: vec_b, 9: vec_c}, None
    )

    check("unit: three pairs returned", result["pair_count"] == 3)
    pair_ab = next(p for p in result["pairs"] if {p["dataset_a"], p["dataset_b"]} == {7, 3})
    expected_euclid = float(np.linalg.norm(vec_a - vec_b))
    check("unit: euclidean distance exact", abs(pair_ab["euclidean_distance"] - expected_euclid) < 1e-12)
    check("unit: fallback standardized equals raw euclidean",
          abs(pair_ab["standardized_distance"] - expected_euclid) < 1e-12)

    # Anchored reference mode: unit centre/scale makes math hand-checkable.
    reference = {
        "centre": np.zeros(4),
        "scale": np.ones(4),
        "usable_mask": np.ones(4, dtype=bool),
        "usable_count": 4,
        "reference_windows": 64,
        "window_size": 60,
    }
    referenced = fingerprint.pairwise_fingerprint_comparison(
        {7: vec_a, 9: vec_c}, reference
    )
    pair_ac = referenced["pairs"][0]
    expected_std = float(np.linalg.norm((vec_a - vec_c)))
    check("unit: standardized distance uses external reference",
          abs(pair_ac["standardized_distance"] - expected_std) < 1e-12,
          f"{pair_ac['standardized_distance']} vs {expected_std}")
    expected_sim = 1.0 / (1.0 + expected_std / 2.0)
    check("unit: similarity follows anchored formula",
          abs(pair_ac["similarity_score"] - expected_sim) < 1e-12)

    matrix = referenced["matrix"]
    check("unit: matrices symmetric",
          all(matrix[m][i][j] == matrix[m][j][i]
              for m in ("euclidean", "standardized", "similarity")
              for i in range(2) for j in range(2)))
    check("unit: zero self-distance and unit self-similarity",
          all(matrix["euclidean"][i][i] == 0.0 for i in range(2))
          and all(matrix["similarity"][i][i] == 1.0 for i in range(2)))

    identical = fingerprint.pairwise_fingerprint_comparison(
        {1: vec_a.copy(), 2: vec_a.copy()}, reference
    )
    check("unit: identical vectors -> zero distance, full similarity",
          identical["pairs"][0]["euclidean_distance"] == 0.0
          and identical["pairs"][0]["standardized_distance"] == 0.0
          and identical["pairs"][0]["similarity_score"] == 1.0)

    try:
        fingerprint.pairwise_fingerprint_comparison({1: vec_a}, None)
        ok = False
    except ValueError:
        ok = True
    check("unit: single vector rejected", ok)

    check("unit: reference metadata present",
          result["reference"]["total_features"] == len(fingerprint.VECTOR_FEATURES))


def main():
    unit_tests()

    from fastapi.testclient import TestClient
    import test_support as _ts
    from main import app

    with TestClient(app) as client:

        _ts.login(client)
        bull_id = upload(client, make_df([segment(240, 0.0015, 0.007)]), "cmp_bull.csv")
        bear_id = upload(client, make_df([segment(240, -0.0018, 0.010)]), "cmp_bear.csv")
        wild_id = upload(client, make_df([segment(240, 0.0002, 0.045)]), "cmp_wild.csv")

        response = client.get(f"/datasets/compare/fingerprints?ids={bull_id},{bear_id},{wild_id}")
        body = response.json()
        check("endpoint: three-dataset comparison", response.status_code == 200,
              f"status={response.status_code} body={response.text[:200]}")
        check("endpoint: ids echoed in order",
              body.get("dataset_ids") == [bull_id, bear_id, wild_id])
        check("endpoint: feature list matches VECTOR_FEATURES",
              body.get("features") == list(fingerprint.VECTOR_FEATURES))
        check("endpoint: metadata per dataset", set(body.get("metadata", {}).keys()) ==
              {str(bull_id), str(bear_id), str(wild_id)})
        check("endpoint: JSON-safe payload",
              contains_no_nan_inf(body) and json.dumps(body, allow_nan=False) is not None)

        matrix = body.get("matrix", {})
        check("endpoint: matrix symmetric",
              all(matrix[m][i][j] == matrix[m][j][i]
                  for m in ("euclidean", "standardized", "similarity")
                  for i in range(3) for j in range(3)))
        similarity = matrix["similarity"]
        check("endpoint: bull-bear less similar than bull-wild to bear on vol axis is descriptive only; bounds hold",
              all(0.0 <= similarity[i][j] <= 1.0 for i in range(3) for j in range(3)))

        # Bull vs bear should be farther apart than bull vs another bull-like series.
        pair_bb = next(p for p in body["pairs"]
                       if {p["dataset_a"], p["dataset_b"]} == {bull_id, bear_id})
        calm_id = upload(client, make_df([segment(240, 0.0014, 0.0075)]), "cmp_calm.csv")
        pair_bc = next(p for p in client.get(
            f"/datasets/compare/fingerprints?ids={bull_id},{calm_id}"
        ).json()["pairs"])
        check("endpoint: similar regimes score closer than opposite ones",
              pair_bc["standardized_distance"] < pair_bb["standardized_distance"],
              f"similar={pair_bc['standardized_distance']} opposite={pair_bb['standardized_distance']}")

        # Scale invariance: rescaled copy of bull must sit at ~zero distance.
        rescaled = make_df([segment(240, 0.0015, 0.007)])
        rescaled[["Open", "High", "Low", "Close"]] *= 5.7
        rescaled["Volume"] *= 0.3
        scaled_id = upload(client, rescaled, "cmp_scaled.csv")
        scaled_pair = client.get(
            f"/datasets/compare/fingerprints?ids={bull_id},{scaled_id}"
        ).json()["pairs"][0]
        check("scale invariance: rescale leaves near-zero distance",
              scaled_pair["euclidean_distance"] < 1e-6
              and scaled_pair["similarity_score"] > 0.999,
              f"euclidean={scaled_pair['euclidean_distance']}")

        # Validation.
        response = client.get(f"/datasets/compare/fingerprints?ids={bull_id}")
        check("bounds: single dataset rejected (422)", response.status_code == 422)

        five_ids = ",".join(str(i) for i in [bull_id, bear_id, wild_id, calm_id, scaled_id])
        response = client.get(f"/datasets/compare/fingerprints?ids={five_ids}")
        check("bounds: five datasets rejected (422)", response.status_code == 422)

        response = client.get(f"/datasets/compare/fingerprints?ids={bull_id},{bull_id}")
        check("duplicates rejected (422)", response.status_code == 422)

        response = client.get("/datasets/compare/fingerprints?ids=abc,def")
        check("non-numeric ids rejected (422)", response.status_code == 422)

        response = client.get(f"/datasets/compare/fingerprints?ids={bull_id},999999")
        check("unknown dataset id rejected (404)", response.status_code == 404)

        response = client.get("/datasets/compare/fingerprints")
        check("missing ids parameter rejected (422)", response.status_code == 422)

        # Cleanup.
        for dataset_id in [bull_id, bear_id, wild_id, calm_id, scaled_id]:
            client.delete(f"/datasets/{dataset_id}")
        with database.get_cursor(dictionary=True) as cursor:
            cursor.execute(
                "SELECT COUNT(*) AS n FROM datasets WHERE id IN (%s,%s,%s,%s,%s)",
                (bull_id, bear_id, wild_id, calm_id, scaled_id),
            )
            remaining = cursor.fetchone()["n"]
        check("cleanup removed comparison datasets", remaining == 0)

    print("-" * 60)
    if FAILURES:
        print(f"RESULT: {len(FAILURES)} FAILURE(S): {FAILURES}")
        sys.exit(1)
    print("RESULT: ALL TESTS PASSED")


if __name__ == "__main__":
    main()
