"""One-off generator for sample_data/demo_market.csv (deterministic).

Run directly from backend/: python _make_demo_csv.py
Creates a clearly-labelled SYNTHETIC OHLCV series long enough for every
analytics feature (fingerprint, analogues, regimes, intelligence,
comparison, correlation) to function meaningfully.
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, r"D:\fin\market-dna\backend")

OUT = Path(r"D:\fin\market-dna\sample_data\demo_market.csv")


def main():
    n = 750
    rng = np.random.RandomState(42)

    # Three clearly different market phases:
    #   calm uptrend -> violent drawdown -> steady recovery
    seg1, seg3 = 300, 250
    seg2 = n - seg1 - seg3
    drifts = np.concatenate(
        [np.full(seg1, 0.0006), np.full(seg2, -0.0022), np.full(seg3, 0.0011)]
    )
    vols = np.concatenate(
        [np.full(seg1, 0.007), np.full(seg2, 0.024), np.full(seg3, 0.010)]
    )

    shocks = rng.standard_t(df=6, size=n) / np.sqrt(6 / 4)  # fat tails, unit-ish var
    close = 100.0 * np.exp(np.cumsum(drifts + vols * shocks))

    spread = np.abs(rng.normal(0.004, 0.002, n))
    high = close * (1.0 + spread)
    low = close * (1.0 - spread)
    open_ = np.clip(close * (1.0 + rng.normal(0.0, 0.0025, n)), low, high)
    volume = rng.lognormal(13.8 + 0.25 * (vols * 40), 0.30, n).astype(np.int64)
    volume = np.clip(volume, 100_000, None)

    dates = pd.bdate_range("2024-01-01", periods=n)
    frame = pd.DataFrame(
        {
            "Date": dates.strftime("%Y-%m-%d"),
            "Open": np.round(open_, 4),
            "High": np.round(high, 4),
            "Low": np.round(low, 4),
            "Close": np.round(close, 4),
            "Volume": volume,
        }
    )
    OUT.parent.mkdir(parents=True, exist_ok=True)
    frame.to_csv(OUT, index=False)
    print(f"wrote {OUT} ({len(frame)} rows)")


if __name__ == "__main__":
    main()
