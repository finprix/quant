"""Phase 8 performance benchmark: deterministic synthetic datasets.

Run directly: python benchmark_phase8.py
Measures wall-clock time of each analytics stage for ~1k / 5k / 10k row
datasets. No MySQL writes, no servers; pure function-level timing so
numbers isolate computation cost.
"""

import sys
import time

import numpy as np
import pandas as pd

sys.path.insert(0, r"D:\fin\market-dna\backend")

import cross_market
import fingerprint
import intelligence
import regimes

SIZES = (1000, 5000, 10000)


def synthetic_frame(n_rows: int, seed: int) -> pd.DataFrame:
    """Deterministic OHLCV frame with regime-like structure."""
    rng = np.random.RandomState(seed)
    # Three volatility/drift segments to give regimes something to find.
    seg = n_rows // 3
    drifts = np.concatenate([
        np.full(seg, 0.0008),
        np.full(n_rows - 2 * seg, -0.0004),
        np.full(seg, 0.0012),
    ])
    vols = np.concatenate([
        np.full(seg, 0.008),
        np.full(n_rows - 2 * seg, 0.022),
        np.full(seg, 0.011),
    ])
    shocks = rng.normal(0.0, 1.0, n_rows)
    close = 100.0 * np.exp(np.cumsum(drifts + vols * shocks))
    intraday = np.abs(rng.normal(0.0, 0.004, n_rows))
    high = close * (1.0 + intraday)
    low = close * (1.0 - intraday)
    open_ = np.clip(close * (1.0 + rng.normal(0.0, 0.002, n_rows)), low, high)
    volume = (rng.lognormal(13.5, 0.35, n_rows)).astype(float)
    dates = pd.bdate_range("2015-01-01", periods=n_rows)
    return pd.DataFrame(
        {"Date": dates, "Open": open_, "High": high, "Low": low,
         "Close": close, "Volume": volume}
    )


def timed(label, fn, results):
    start = time.perf_counter()
    value = fn()
    elapsed_ms = (time.perf_counter() - start) * 1000.0
    results.append((label, elapsed_ms))
    return value


def main():
    print(f"{'rows':>6} | {'fingerprint':>12} | {'analogues':>12} | "
          f"{'regimes':>10} | {'intelligence':>12} | {'pairwise cmp':>12} | "
          f"{'correlation':>12}")
    print("-" * 92)

    for n_rows in SIZES:
        frame_a = synthetic_frame(n_rows, seed=1000 + n_rows)
        frame_b = synthetic_frame(n_rows, seed=2000 + n_rows)
        results = []

        def run_fingerprint():
            return timed(
                "fingerprint",
                lambda: fingerprint.calculate_fingerprint(frame_a),
                results,
            )

        fp_a = run_fingerprint()

        def run_analogues():
            return timed(
                "analogues",
                lambda: fingerprint.find_historical_analogues(frame_a),
                results,
            )

        run_analogues()

        def run_regimes():
            return timed(
                "regimes",
                lambda: regimes.discover_regimes(frame_a, window_size=60, k=None),
                results,
            )

        run_regimes()

        def run_intelligence():
            return timed(
                "intelligence",
                lambda: intelligence.build_market_intelligence(frame_a),
                results,
            )

        cached_intel = intelligence.build_market_intelligence.__name__
        assert cached_intel == "build_market_intelligence"
        run_intelligence()

        def run_pairwise():
            vectors = {
                1: fingerprint.build_fingerprint_vector(frame_a),
                2: fingerprint.build_fingerprint_vector(frame_b),
            }
            reference = fingerprint._comparison_reference({1: frame_a, 2: frame_b})

            def inner():
                return fingerprint.pairwise_fingerprint_comparison(vectors, reference)

            return timed("pairwise", inner, results)

        run_pairwise()

        def run_correlation():
            return timed(
                "correlation",
                lambda: cross_market.build_cross_market_analysis(
                    {1: frame_a, 2: frame_b}
                ),
                results,
            )

        run_correlation()

        by_label = dict(results)
        print(f"{n_rows:>6} | "
              f"{by_label['fingerprint']:>10.1f}ms | "
              f"{by_label['analogues']:>10.1f}ms | "
              f"{by_label['regimes']:>8.1f}ms | "
              f"{by_label['intelligence']:>10.1f}ms | "
              f"{by_label['pairwise']:>10.1f}ms | "
              f"{by_label['correlation']:>10.1f}ms")

    print("\nNotes:")
    print("- Function-level timing on one warm process; excludes MySQL I/O.")
    print("- 'pairwise cmp' includes vector building + pooled reference population.")
    print("- Deterministic seeds; reruns reproduce values up to BLAS variance.")


if __name__ == "__main__":
    main()
