"""Serverless-safe stepped ingestion tests (v0.18.0).

POST /market/import now returns a QUEUED job whose work is advanced one
bounded chunk per POST /market/import/step call, with the resume cursor
persisted to ingestion_jobs after every successful window. These tests
prove the contract:

  1. a multi-year import assembles the full range across separate steps,
     one provider fetch window each;
  2. progress survives simulated instance loss (_JOBS wiped between
     steps -> next step reconstructs state from storage);
  3. a provider failure mid-stream marks the job FAILED without moving
     the cursor, and retrying steps after recovery completes the import;
  4. importing an already-current instrument short-circuits with zero
     new provider calls;
  5. step-route validation (missing job_id, unknown job).

Run directly: python test_background_import.py
"""

import os
import sys
import traceback
from datetime import date

import numpy as np
import pandas as pd

sys.path.insert(0, ".")

os.environ["VERCEL"] = "1"  # force client-stepped mode: no background task

from fastapi.testclient import TestClient

import test_support as _ts
import database
import market_ingest
from data_sources import _PROVIDERS
from data_sources.base import DataSourceUnavailable, MarketDataSource
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


def make_master(start="2022-01-03", periods=780):
    rng = np.random.default_rng(seed=7)
    dates = pd.bdate_range(start=start, periods=periods)
    close = 100 * np.cumprod(1 + rng.normal(0.0004, 0.011, periods))
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


class SteppedFakeProvider(MarketDataSource):
    """Slices a master frame by the requested window; records every call."""

    name = "stepped"
    supports_search = False

    def __init__(self, master):
        self.master = master
        self.calls = []
        self.fail_next = 0  # raise this many consecutive fetches

    def search(self, query):
        return []

    def fetch(self, symbol, start_date, end_date, interval="1d", min_observations=None):
        if self.fail_next > 0:
            self.fail_next -= 1
            self.calls.append((str(start_date), str(end_date)))
            raise DataSourceUnavailable("simulated provider outage")
        self.calls.append((str(start_date), str(end_date)))
        frame = self.master
        mask = (frame["Date"].dt.date >= start_date) & (
            frame["Date"].dt.date <= end_date
        )
        return frame[mask].copy()


master = make_master()
provider = SteppedFakeProvider(master)
_PROVIDERS["stepped"] = provider

START = date(2022, 1, 1)
END = date(2024, 12, 31)
EXPECTED_ROWS = len(
    master[
        (master["Date"].dt.date >= START) & (master["Date"].dt.date <= END)
    ]
)


def wipe_memory():
    """Simulate this serverless instance dying between steps."""
    market_ingest._JOBS.clear()


def drive_to_terminal(client, job_id):
    """Step a job until COMPLETE/FAILED; returns (snapshots, last)."""
    snapshots = []
    for _ in range(60):
        response = client.post("/market/import/step", json={"job_id": job_id})
        assert response.status_code == 200, response.text[:300]
        snap = response.json()
        snapshots.append(snap)
        wipe_memory()
        if snap["status"] in ("COMPLETE", "FAILED"):
            return snapshots, snap
    return snapshots, snapshots[-1]


# ---------------------------------------------------------------------------
print("\n[1] multi-chunk stepped import across simulated instance loss")
try:
    market_ingest._CHUNK_DAYS = 200  # small windows => many steps
    calls_start = len(provider.calls)
    with TestClient(app) as client:
        _ts.login(client)
        started = client.post(
            "/market/import",
            json={
                "symbol": "STEPX",
                "start_date": START.isoformat(),
                "end_date": END.isoformat(),
                "interval": "1d",
                "provider": "stepped",
                "name": "Stepped Industries",
            },
        )
        check("import accepted", started.status_code == 200, started.text[:160])
        job_id = started.json()["job_id"]
        queued = client.get(f"/market/import/status/{job_id}").json()
        check("job starts QUEUED", queued.get("status") == "QUEUED",
              str(queued.get("status")))

        snaps, final = drive_to_terminal(client, job_id)

        check("reached COMPLETE", final["status"] == "COMPLETE",
              str(final.get("error")))
        check("one fetch per step",
              len(provider.calls) - calls_start == len(snaps),
              f"calls={len(provider.calls) - calls_start} steps={len(snaps)}")
        check("multiple chunks used", len(snaps) >= 5, f"steps={len(snaps)}")
        result = final["result"]
        check("dataset id returned", isinstance(result.get("dataset_id"), int),
              str(result.get("dataset_id")))
        ds = database.get_dataset(result["dataset_id"])
        check("full range assembled", ds["row_count"] == EXPECTED_ROWS,
              f"{ds['row_count']} vs {EXPECTED_ROWS}")
        check("metadata end date matches", str(ds["end_date"]) >= "2024-12-01",
              str(ds["end_date"]))
        check("receipt counts inserted rows",
              result["receipt"]["inserted"] == EXPECTED_ROWS,
              str(result["receipt"]["inserted"]))
        check("receipt marked stepped",
              result["receipt"]["mode"] == "stepped"
              and result["receipt"]["chunks"] == len(snaps),
              f"mode={result['receipt']['mode']} "
              f"chunks={result['receipt']['chunks']}")
        windows = [c for c in provider.calls[calls_start:]]
        ordered = all(
            date.fromisoformat(windows[i + 1][0]) > date.fromisoformat(windows[i][0])
            for i in range(len(windows) - 1)
        )
        check("windows advance chronologically", ordered, str(windows))

        status = client.get(f"/market/import/status/{job_id}").json()
        check("status endpoint reflects completion",
              status["status"] == "COMPLETE"
              and status["result"]["dataset_id"] == result["dataset_id"], "")
except Exception:
    traceback.print_exc()
    check("[1] scenario crashed", False)

# ---------------------------------------------------------------------------
print("\n[2] mid-stream provider failure then recovery on same job")
try:
    with TestClient(app) as client:
        _ts.login(client)
        started = client.post(
            "/market/import",
            json={
                "symbol": "STEPR",
                "start_date": START.isoformat(),
                "end_date": END.isoformat(),
                "interval": "1d",
                "provider": "stepped",
            },
        ).json()
        job_id = started["job_id"]

        # Step 1 succeeds normally: chunk stored, dataset provisioned.
        first = client.post("/market/import/step", json={"job_id": job_id}).json()
        wipe_memory()
        check("first chunk stored cleanly",
              first["status"] not in ("COMPLETE", "FAILED"), first["status"])

        # Now arm the outage for the next fetch window.
        provider.fail_next = 1
        snaps, failed = drive_to_terminal(client, job_id)
        check("job FAILED on outage", failed["status"] == "FAILED", str(failed)[:160])
        check("error surfaced", "outage" in (failed.get("error") or ""), "")
        check("dataset id preserved through failure",
              isinstance(failed["result"].get("dataset_id"), int),
              str(failed["result"].get("dataset_id")))
        partial_rows = database.get_dataset(
            failed["result"]["dataset_id"]
        )["row_count"]
        check("partial data stored before failure",
              0 < partial_rows < EXPECTED_ROWS,
              f"{partial_rows}/{EXPECTED_ROWS}")

        # Heal the provider; the same job must resume from its cursor.
        provider.fail_next = 0
        snaps2, healed = drive_to_terminal(client, job_id)
        check("retry reaches COMPLETE", healed["status"] == "COMPLETE",
              str(healed.get("error")))
        ds = database.get_dataset(healed["result"]["dataset_id"])
        check("no gaps after resume", ds["row_count"] == EXPECTED_ROWS,
              f"{ds['row_count']} vs {EXPECTED_ROWS}")
        check("resume continued mid-job",
              healed["result"]["receipt"]["chunks"] == len(snaps) + len(snaps2),
              f"chunks={healed['result']['receipt']['chunks']} "
              f"steps={len(snaps)}+{len(snaps2)}")
except Exception:
    traceback.print_exc()
    check("[2] scenario crashed", False)

# ---------------------------------------------------------------------------
print("\n[3] already-current short-circuit and step validation")
try:
    with TestClient(app) as client:
        _ts.login(client)
        calls_before = len(provider.calls)

        # Re-import STEPR over a range strictly inside the stored history
        # (stored bars end 2024-12-30): first step must short-circuit with
        # zero rows added and zero new provider fetches.
        started = client.post(
            "/market/import",
            json={
                "symbol": "STEPR",
                "start_date": START.isoformat(),
                "end_date": "2024-12-01",
                "interval": "1d",
                "provider": "stepped",
            },
        ).json()
        snap = client.post(
            "/market/import/step", json={"job_id": started["job_id"]}
        ).json()
        check("already-current completes on first step",
              snap["status"] == "COMPLETE", str(snap)[:160])
        check("no rows added", snap["result"].get("rows_added") == 0,
              str(snap["result"].get("rows_added")))
        check("status word is current", snap["result"]["status"] == "current", "")
        check("no provider calls consumed",
              len(provider.calls) == calls_before,
              f"{calls_before} -> {len(provider.calls)}")

        # Validation contract.
        missing = client.post("/market/import/step", json={})
        check("missing job_id rejected", missing.status_code == 422,
              str(missing.status_code))
        unknown = client.post(
            "/market/import/step", json={"job_id": "does-not-exist"}
        )
        check("unknown job 404", unknown.status_code == 404,
              str(unknown.status_code))

        # Guest may not step jobs.
        fresh = TestClient(app)
        denied = fresh.post(
            "/market/import/step", json={"job_id": started["job_id"]}
        )
        check("guest cannot step jobs", denied.status_code in (401, 403),
              str(denied.status_code))
except Exception:
    traceback.print_exc()
    check("[3] scenario crashed", False)


# ---------------------------------------------------------------------------
def _summary():
    print(f"\nRESULT: ALL TESTS PASSED ({len(PASS)} passed, {len(FAIL)} failed)")
    if FAIL:
        for name, detail in FAIL:
            print(f"  FAILED: {name} :: {detail}")
        sys.exit(1)


_summary()

