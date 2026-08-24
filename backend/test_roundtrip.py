"""v0.11.0 round-trip integration test.

Proves the canonical pipeline contract:

    provider fixture -> ingestion -> MySQL COMMIT -> provider state destroyed
    -> dataset reloaded FROM DATABASE -> quant engines operate on MySQL rows

The quant mathematics are untouched; this test only demonstrates that no
analysis depends on the original in-memory provider DataFrame.
"""

import gc

import pandas as pd
import numpy as np
from fastapi.testclient import TestClient

import database
import fingerprint
from analytics import calculate_summary
from data_sources import base as ds_base
from data_sources.base import (
    MarketDataSource,
    normalize_ohlcv,
)
from data_sources import _PROVIDERS
import test_support as _ts
from main import app


PASS = []
FAIL = []


def check(name, condition, detail=""):
    if condition:
        PASS.append(name)
        print(f"  ok    {name}")
    else:
        FAIL.append((name, detail))
        print(f"  FAIL  {name} :: {detail}")


def make_frame(start="2022-01-03", periods=150):
    rng = np.random.default_rng(seed=7)
    dates = pd.bdate_range(start=start, periods=periods)
    close = 250 * np.cumprod(1 + rng.normal(0.0008, 0.012, periods))
    high = close * (1 + np.abs(rng.normal(0, 0.006, periods)))
    low = close * (1 - np.abs(rng.normal(0, 0.006, periods)))
    open_ = low + (high - low) * rng.random(periods)
    volume = rng.integers(800_000, 4_000_000, periods)
    return pd.DataFrame({
        "Date": dates, "Open": open_, "High": high,
        "Low": low, "Close": close, "Volume": volume,
    })


class RoundTripProvider(MarketDataSource):
    name = "roundtrip"
    supports_search = False

    def __init__(self):
        self.frame = None

    def fetch(self, symbol, start_date, end_date, interval="1d",
              min_observations=None):
        frame = self.frame
        mask = (frame["Date"].dt.date >= start_date) & (
            frame["Date"].dt.date <= end_date
        )
        return normalize_ohlcv(
            frame[mask].copy(), symbol=symbol, provider=self.name,
            min_observations=min_observations or 30,
        )


provider = RoundTripProvider()
provider.frame = make_frame()
_PROVIDERS["roundtrip"] = provider

CREATED_DATASET = None


def test_roundtrip():
    global CREATED_DATASET
    print("\n[1] ingestion through the real HTTP surface")
    with TestClient(app) as client:
        _ts.login(client)
        payload = {
            "symbol": "RT",
            "start_date": "2022-01-03",
            "end_date": "2022-12-30",
            "interval": "1d",
            "provider": "roundtrip",
            "name": "Round Trip Fixture Corp",
        }
        r = client.post("/market/import", json=payload)
        check("import accepted", r.status_code == 200, r.text[:300])
        job_id = r.json()["job_id"]

        status = None
        for _ in range(60):
            status = client.get(f"/market/import/status/{job_id}").json()
            if status["status"] in ("COMPLETE", "FAILED"):
                break
        check("job completed", status["status"] == "COMPLETE", str(status)[:300])

        result = status["result"]
        dataset_id = result["dataset_id"]
        CREATED_DATASET = dataset_id
        receipt = result["receipt"]
        check("receipt counts consistent",
              receipt["received"] == receipt["valid"] == receipt["inserted"],
              str(receipt))
        check("mysql write-through recorded",
              receipt["mysql"]["price_observations"] == receipt["valid"]
              and receipt["mysql"]["dataset_record"]
              and receipt["mysql"]["source_metadata"], str(receipt))
        check("analysis readiness reported", set(receipt["analysis"]) == {
            "fingerprint", "analogues", "regimes", "intelligence"})

    # The stored rollup was computed at ingestion time from the live frame;
    # capture it as ground truth for the post-destruction comparison.
    stored = database.get_dataset(dataset_id)

    print("\n[2] destroy all in-memory provider state")
    raw_rows = len(provider.frame)
    provider.frame = None
    _PROVIDERS["roundtrip"] = provider
    gc.collect()
    check("provider frame gone", provider.frame is None and raw_rows > 0)

    print("\n[3] reload FROM MySQL and run the engines offline")
    rows = database.get_prices(dataset_id)
    check("rows read back from MySQL", len(rows) == stored["row_count"],
          f"{len(rows)} vs {stored['row_count']}")
    frame = fingerprint.dataframe_from_price_records(rows)
    summary = calculate_summary(frame)
    check("summary recomputed from DB matches stored rollup",
          abs(summary["latest_close"] - float(stored["latest_close"])) < 1e-6,
          f"{summary['latest_close']} vs {stored['latest_close']}")

    fp = fingerprint.calculate_fingerprint(frame)
    check("fingerprint computed purely from MySQL rows",
          fp is not None and len(fp) > 10)

    with TestClient(app) as client:

        _ts.login(client)
        r = client.get(f"/datasets/{dataset_id}/fingerprint?lookback=60")
        body = r.json()
        check("fingerprint endpoint serves after provider destruction",
              r.status_code == 200 and body.get("samples_used", 0) > 0,
              r.text[:200])
        # Force a cache miss so this response must come from MySQL data.
        database.delete_analysis_caches(dataset_id)
        r2 = client.get(f"/datasets/{dataset_id}/fingerprint?lookback=45")
        check("fresh computation still reads MySQL only",
              r2.status_code == 200 and r2.json().get("samples_used", 0) > 0,
              r2.text[:200])
        r3 = client.get(f"/datasets/{dataset_id}/prices")
        check("raw observations served from MySQL",
              r3.status_code == 200 and r3.json()["count"] == stored["row_count"])

    print("\n[4] provenance visible to the inspector")
    storage = database.get_dataset_source(dataset_id)
    check("provenance row exists", storage is not None
          and storage["provider"] == "roundtrip"
          and storage["symbol"] == "RT")


if __name__ == "__main__":
    try:
        test_roundtrip()
    finally:
        if CREATED_DATASET is not None:
            try:
                database.delete_dataset(CREATED_DATASET)
                print(f"\ncleanup: deleted fixture dataset #{CREATED_DATASET}")
            except database.DatabaseError:
                pass
    print(f"\nRESULT: {'ALL TESTS PASSED' if not FAIL else str(len(FAIL)) + ' FAILURES'}")
    for name, detail in FAIL:
        print(f"  - {name}: {detail}")
    raise SystemExit(0 if not FAIL else 1)
