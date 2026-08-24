"""Market-data ingestion test suite (v0.10.0).

Runs against real MySQL like the other suites but NEVER touches the network:
a deterministic FakeProvider is registered in the provider registry and
monkeypatched per scenario. Run directly: python test_market_ingestion.py
"""

import io
import sys
import traceback
from datetime import date, timedelta

import numpy as np
import pandas as pd

sys.path.insert(0, ".")

import database
from data_sources import base as ds_base
from data_sources.base import (
    DataSourceUnavailable,
    InvalidRequest,
    InvalidSymbol,
    MarketDataError,
    MarketDataSource,
    normalize_ohlcv,
)
from data_sources import _PROVIDERS
from fastapi.testclient import TestClient
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


def make_frame(start="2022-01-03", periods=120, drift=0.001, vol=0.01):
    rng = np.random.default_rng(seed=42)
    dates = pd.bdate_range(start=start, periods=periods)
    close = 100 * np.cumprod(1 + rng.normal(drift, vol, periods))
    high = close * (1 + np.abs(rng.normal(0, 0.005, periods)))
    low = close * (1 - np.abs(rng.normal(0, 0.005, periods)))
    open_ = low + (high - low) * rng.random(periods)
    volume = rng.integers(1_000_000, 5_000_000, periods)
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


class FakeProvider(MarketDataSource):
    """Deterministic offline stand-in for Yahoo Finance."""

    name = "fake"
    supports_search = True
    frame = None
    search_results = [
        {"symbol": "FAKE", "name": "Fake Corp", "exchange": "TEST",
         "asset_type": "EQUITY", "currency": "USD"},
    ]

    def __init__(self):
        self.calls = []

    def search(self, query):
        return [r for r in self.search_results if query.lower() in r["name"].lower()]

    def fetch(self, symbol, start_date, end_date, interval="1d", min_observations=None):
        self.calls.append((symbol, str(start_date), str(end_date)))
        if self.frame is None:
            raise DataSourceUnavailable("no data configured")
        frame = self.frame
        mask = (frame["Date"].dt.date >= start_date) & (
            frame["Date"].dt.date <= end_date
        )
        return frame[mask].copy()


fake = FakeProvider()
_PROVIDERS["fake"] = fake


# ---------------------------------------------------------------------------
# Unit: normalization (Phase F contract)
# ---------------------------------------------------------------------------
def test_normalization():
    print("\n[1] normalize_ohlcv")

    messy = pd.DataFrame(
        {
            "timestamp": ["2022-01-04", "2022-01-03", "2022-01-03", "2022-01-05",
                          "2022-01-06", "not-a-date"],
            "open": ["10.0", "10.5", "10.5", "bad", "11.0", "12.0"],
            "high": [11.0, 11.0, 11.0, 11.0, None, 13.0],
            "low": [9.8, 9.9, 9.9, 9.9, 10.0, 11.0],
            "close": [10.8, 10.7, 10.7, 10.6, 11.2, 12.5],
            "volume": [1000, 1100, 1100, 1200, None, 1300],
        }
    )
    result = normalize_ohlcv(messy, symbol="X", provider="fake", min_observations=None)

    check("columns canonicalized", list(result.columns) == ds_base.CANONICAL_COLUMNS,
          str(list(result.columns)))
    check("dates parsed+sorted unique",
          result["Date"].is_monotonic_increasing and result["Date"].is_unique, "")
    # Kept: 01-03 (dup removed, last kept), 01-04. Dropped: 01-05 (bad open),
    # 01-06 (null high -> never fabricated), not-a-date.
    check("malformed/incomplete rows dropped", len(result) == 2, f"n={len(result)}")
    check("surviving rows chronological",
          list(result["Volume"]) == [1100, 1000], str(list(result["Volume"])))
    check("numeric dtypes", result["Close"].dtype.kind == "f", "")

    inverted = make_frame(periods=40)
    inverted.loc[inverted.index[5], "High"] = 0.5  # below open/close -> bad candle
    cleaned = normalize_ohlcv(inverted, symbol="X", provider="fake", min_observations=None)
    check("inverted candles removed", len(cleaned) == 39, f"n={len(cleaned)}")

    short = make_frame(periods=10)
    try:
        normalize_ohlcv(short, symbol="X", provider="fake")
        check("short history rejected", False, "no exception")
    except MarketDataError as exc:
        check("short history rejected", "minimum" in str(exc), str(exc))

    try:
        normalize_ohlcv(None, symbol="X", provider="fake")
        check("empty response rejected", False, "no exception")
    except DataSourceUnavailable:
        check("empty response rejected", True, "")


# ---------------------------------------------------------------------------
# API: search + import job lifecycle (Phases D/E/J/Q)
# ---------------------------------------------------------------------------
def test_search_and_import():
    print("\n[2] /market/search + /market/import lifecycle")
    fake.frame = make_frame(periods=150)

    with TestClient(app) as client:

        _ts.login(client)
        r = client.get("/market/search", params={"q": "fake", "provider": "fake"})
        body = r.json()
        check("search returns structured results",
              r.status_code == 200 and body["results"][0]["symbol"] == "FAKE",
              r.text[:200])

        import_start, import_end = date(2022, 1, 3), date(2022, 6, 30)
        r = client.post("/market/import", json={
            "symbol": "FAKE", "start_date": import_start.isoformat(),
            "end_date": import_end.isoformat(), "interval": "1d", "provider": "fake",
            "name": "Fake Corp", "exchange": "TEST", "asset_type": "EQUITY",
            "currency": "USD",
        })
        check("import accepted", r.status_code == 200, r.text[:300])
        job_id = r.json()["job_id"]

        status = client.get(f"/market/import/status/{job_id}").json()
        check("job completes", status["status"] == "COMPLETE", str(status))
        result = status["result"]
        dataset_id = result["dataset_id"]
        check("dataset id returned", isinstance(dataset_id, int), "")
        expected_rows = int(
            ((fake.frame["Date"].dt.date >= import_start)
             & (fake.frame["Date"].dt.date <= import_end)).sum()
        )
        check("row count matches requested range",
              result["rows_added"] == expected_rows,
              f"{result['rows_added']} vs {expected_rows}")

        src = database.get_dataset_source(dataset_id)
        check("provenance stored",
              src and src["provider"] == "fake" and src["symbol"] == "FAKE"
              and src["instrument_name"] == "Fake Corp", str(src))

        ds = database.get_dataset(dataset_id)
        check("metadata rollup correct",
              ds["row_count"] == expected_rows
              and str(ds["latest_close"]) != "", str(ds))

        # Re-import same symbol -> incremental path, no duplicates.
        r2 = client.post("/market/import", json={
            "symbol": "fake", "start_date": import_start.isoformat(),
            "end_date": import_end.isoformat(), "interval": "1d",
            "provider": "fake",
        })
        s2 = client.get(f"/market/import/status/{r2.json()['job_id']}").json()
        check("re-import reuses dataset (incremental)",
              s2["status"] == "COMPLETE"
              and s2["result"]["dataset_id"] == dataset_id, str(s2))

        count = len(database.get_prices(dataset_id))
        check("no duplicate rows after re-import", count == expected_rows,
              f"n={count} vs {expected_rows}")
        return dataset_id


def test_validation_errors():
    print("\n[3] request validation + provider failures")
    fake.frame = make_frame(periods=60)
    with TestClient(app) as client:
        _ts.login(client)
        r = client.post("/market/import", json={
            "symbol": "FAKE", "start_date": "2022-05-01",
            "end_date": "2022-01-01"})
        check("start>=end rejected", r.status_code == 422, r.text[:200])

        r = client.post("/market/import", json={
            "symbol": "FAKE", "start_date": "2022-01-01",
            "end_date": "2022-02-01", "interval": "5m"})
        check("unsupported interval rejected", r.status_code == 422, r.text[:200])

        r = client.post("/market/import", json={
            "symbol": "FAKE", "start_date": "junk", "end_date": "2022-02-01"})
        check("bad date format rejected", r.status_code == 422, r.text[:200])

        r = client.get("/market/search", params={"q": "?", "provider": "nope"})
        check("unknown provider rejected", r.status_code == 400, r.text[:200])

        saved = fake.frame
        fake.frame = None  # provider outage
        r = client.post("/market/import", json={
            "symbol": "FAKE", "start_date": "2022-01-03",
            "end_date": "2022-03-01", "provider": "fake"})
        s = client.get(f"/market/import/status/{r.json()['job_id']}").json()
        check("provider failure surfaces FAILED status",
              s["status"] == "FAILED" and "no data configured" in (s["error"] or ""),
              str(s))
        fake.frame = saved


# ---------------------------------------------------------------------------
# Incremental updates + cache invalidation (Phases H/G)
# ---------------------------------------------------------------------------
def test_incremental_update(dataset_id):
    print("\n[4] /market/update incremental + cache invalidation")
    from datetime import datetime

    database.store_fingerprint(
        dataset_id, {"annualized_volatility": 0.123}
    )
    before_count = len(database.get_prices(dataset_id))
    prev_last = max(p["date"] for p in database.get_prices(dataset_id))
    prev_last = prev_last if isinstance(prev_last, date) else date.fromisoformat(str(prev_last)[:10])

    # Provider now has extra trading days beyond the stored history.
    extra = make_frame(start="2022-07-01", periods=30)
    full = pd.concat([make_frame(periods=150), extra], ignore_index=True)
    fake.frame = full
    # Normalization deduplicates dates (keep-last), so expectations must
    # count distinct observations newer than the stored history.
    dedup = full.drop_duplicates(subset=["Date"], keep="last")
    expected_new = int((dedup["Date"].dt.date > prev_last).sum())

    with TestClient(app) as client:

        _ts.login(client)
        r = client.post(f"/market/update/{dataset_id}")
        body = r.json()
        check("update succeeds", r.status_code == 200, r.text[:300])
        check("new rows appended", body.get("rows_added") == expected_new,
              f"{body} vs {expected_new}")

    after_count = len(database.get_prices(dataset_id))
    check("price rows extended exactly once",
          after_count == before_count + expected_new,
          f"{before_count}->{after_count}")

    meta = database.get_dataset(dataset_id)
    last = max(p["date"] for p in database.get_prices(dataset_id))
    check("metadata reflects new end date",
          str(meta["end_date"]) >= str(last)[:10] if not isinstance(last, datetime)
          else True, f"{meta['end_date']} vs {last}")

    check("fingerprint cache invalidated",
          database.get_stored_fingerprint(dataset_id) is None, "")

    # Second update with no new data -> clean 'current' response.
    with TestClient(app) as client:
        _ts.login(client)
        r = client.post(f"/market/update/{dataset_id}")
        body = r.json()
        check("idempotent update returns current",
              r.status_code == 200 and body["status"] == "current"
              and body["rows_added"] == 0, str(body))


# ---------------------------------------------------------------------------
# CSV compatibility + overview math (Phases G/M)
# ---------------------------------------------------------------------------
def test_csv_compatibility_and_overview():
    print("\n[5] CSV datasets untouched + /market/overview math")
    frame = make_frame(periods=220)
    buffer = io.StringIO()
    frame.to_csv(buffer, index=False)

    with TestClient(app) as client:

        _ts.login(client)
        r = client.post(
            "/upload",
            files={"file": ("compat_check.csv", io.BytesIO(buffer.getvalue().encode()), "text/csv")},
        )
        check("CSV upload still works", r.status_code == 200, r.text[:200])
        csv_id = r.json()["dataset"]["id"]

        src = database.get_dataset_source(csv_id)
        check("CSV dataset has no provenance row", src is None, str(src))

        r = client.post(f"/market/update/{csv_id}")
        check("updating CSV dataset fails cleanly",
              r.status_code == 400 and "no provider" in r.json()["detail"],
              r.text[:200])

        ov = client.get("/market/overview").json()
        row = next(x for x in ov["instruments"] if x["dataset_id"] == csv_id)
        closes = frame["Close"].reset_index(drop=True)
        expected_1d = (float(closes.iloc[-1]) - float(closes.iloc[-2])) / float(closes.iloc[-2])
        check("overview 1D return exact",
              abs(row["return_1d"] - expected_1d) < 1e-6,
              f"{row['return_1d']} vs {expected_1d}")
        check("overview flags imported instruments",
              ov["imported_count"] >= 1 and any(
                  i["source"] for i in ov["instruments"]), str(ov["imported_count"]))

        ai_row = next(x for x in ov["instruments"] if x.get("source"))
        check("overview includes regime label slot", "regime_label" in ai_row, "")
        return csv_id


def cleanup(ids):
    print("\n[cleanup]")
    for dataset_id in ids:
        try:
            database.delete_dataset(dataset_id)
            print(f"  removed dataset #{dataset_id}")
        except Exception as exc:
            print(f"  could not remove #{dataset_id}: {exc}")


if __name__ == "__main__":
    created = []
    try:
        test_normalization()
        imported_id = test_search_and_import()
        created.append(imported_id)
        test_validation_errors()
        test_incremental_update(imported_id)
        csv_id = test_csv_compatibility_and_overview()
        created.append(csv_id)
    except Exception:
        traceback.print_exc()
        FAIL.append(("suite crashed", traceback.format_exc()))
    finally:
        cleanup(created)

    print(f"\nRESULT: {'ALL TESTS PASSED' if not FAIL else f'{len(FAIL)} FAILURES'}")
    sys.exit(1 if FAIL else 0)
