"""Market-data ingestion orchestration.

Pipeline (Phase E contract):

    request -> validate symbol/date range
            -> provider.fetch (external I/O; mockable in tests)
            -> normalize_ohlcv (shared, strict)
            -> store: new dataset OR incremental append
            -> provenance row in dataset_sources
            -> invalidate affected analysis caches
            -> return dataset id

Import jobs run through FastAPI BackgroundTasks so large downloads never
block the HTTP response; progress is a stage-based state machine stored in
an in-process registry (Quant Vector is a single-process research tool).
"""

import threading
from datetime import date, timedelta

import database
from analytics import calculate_summary
from data_sources import get_provider, to_price_rows
from data_sources.base import DataSourceUnavailable, InvalidRequest, InvalidSymbol
from fingerprint import dataframe_from_price_records


def _summary_from_frame(frame):
    """Rollup metadata computed exactly like the CSV upload path."""
    summary = calculate_summary(frame)
    return {
        "start_date": frame["Date"].iloc[0].date(),
        "end_date": frame["Date"].iloc[-1].date(),
        "row_count": int(len(frame)),
        "latest_close": float(summary["latest_close"]),
        "summary": summary,
    }


def find_existing_import(provider, symbol):
    """Return the dataset_source row if this instrument was imported before."""
    for source in database.list_dataset_sources().values():
        if (
            source["provider"].lower() == str(provider).lower()
            and source["symbol"].upper() == str(symbol).upper()
        ):
            return source
    return None


def import_instrument(
    provider_name,
    symbol,
    start_date,
    end_date,
    interval="1d",
    metadata=None,
    reuse_existing=True,
):
    """Full fetch + persist for one instrument. Returns a result dict.

    When the same provider/symbol was imported before and `reuse_existing`
    is set, the existing dataset is extended incrementally instead of being
    duplicated.
    """
    provider = get_provider(provider_name)
    metadata = metadata or {}

    existing = find_existing_import(provider.name, symbol) if reuse_existing else None
    if existing is not None:
        dataset_id = existing["dataset_id"]
        last_date = database.get_last_price_date(dataset_id)
        fetch_start = start_date
        if last_date is not None:
            next_day = _next_day(last_date)
            if next_day > end_date:
                return {
                    "status": "current",
                    "dataset_id": dataset_id,
                    "message": "Stored history is already current through "
                    f"{last_date.isoformat()}; nothing to download.",
                    "rows_added": 0,
                }
            # Include the boundary session so stale provisional bars heal.
            fetch_start = min(start_date, last_date)
        return update_imported_dataset(
            dataset_id,
            fetch_start=fetch_start,
            fetch_end=end_date,
        )

    frame = provider.fetch(symbol, start_date, end_date, interval=interval)
    rollup = _summary_from_frame(frame)

    filename = f"{symbol.upper()}_{interval}.csv"
    try:
        dataset_id = database.store_dataset(
            filename=filename,
            start_date=rollup["start_date"],
            end_date=rollup["end_date"],
            row_count=rollup["row_count"],
            latest_close=rollup["latest_close"],
            price_rows=to_price_rows(frame),
            metrics=rollup["summary"],
        )
    except database.DatabaseError as exc:
        raise RuntimeError(f"MySQL storage failed: {exc}") from exc

    database.upsert_dataset_source(
        dataset_id=dataset_id,
        provider=provider.name,
        symbol=str(symbol).upper(),
        instrument_name=metadata.get("name"),
        exchange=metadata.get("exchange"),
        asset_type=metadata.get("asset_type"),
        currency=metadata.get("currency"),
        price_interval=interval,
    )

    return {
        "status": "complete",
        "dataset_id": dataset_id,
        "rows_added": rollup["row_count"],
        "start_date": rollup["start_date"].isoformat(),
        "end_date": rollup["end_date"].isoformat(),
        "latest_close": rollup["latest_close"],
    }


def _normalization_stats(frame):
    """Normalization receipt carried on the frame by data_sources.base."""
    stats = getattr(frame, "attrs", {}).get("normalization")
    if not stats:
        return {
            "received_raw": int(len(frame)),
            "valid": int(len(frame)),
            "rejected": 0,
            "unparseable_ohlc_removed": 0,
            "duplicate_dates_removed": 0,
            "invalid_candles_removed": 0,
        }
    return dict(stats)


def _analysis_readiness(row_count):
    """Documented engine minimums -> readiness labels for import receipts.

    Mirrors the real guards: fingerprint/analogues default lookback is 60
    (analogues additionally need forward returns), regimes require
    n_windows >= 12 with window_size 60 AND len(df) >= 2*window_size (=120),
    intelligence degrades gracefully at any size.
    """
    return {
        "fingerprint": "READY" if row_count >= 60 else "INSUFFICIENT DATA",
        "analogues": "READY" if row_count >= 65 else "INSUFFICIENT DATA",
        "regimes": "READY" if row_count >= 120 else "INSUFFICIENT DATA",
        "intelligence": "READY",
    }


_CACHE_LABELS = ("fingerprints", "analogue_matches", "regime_models", "intelligence_snapshots")


def update_imported_dataset(dataset_id, fetch_start=None, fetch_end=None):
    """Incrementally extend an imported dataset (Phase H).

    Refetches from the last stored date (boundary row replaced, healing any
    provisional intraday bar), appends with SQL-level duplicate protection,
    refreshes rollup metadata and invalidates derived-analysis caches.
    Returns an update receipt with real counts.
    """
    source = database.get_dataset_source(dataset_id)
    if source is None:
        raise LookupError(f"Dataset #{dataset_id} has no market-data provenance.")

    provider = get_provider(source["provider"])
    today = date.today()
    last_date = database.get_last_price_date(dataset_id)
    # Include the last stored session in the refetch window so a previously
    # stored partial (intraday) bar is corrected rather than frozen.
    start = fetch_start or last_date or today
    end = fetch_end or today

    if start > end:
        return {
            "status": "current",
            "dataset_id": dataset_id,
            "message": f"Already current through {end.isoformat()}.",
            "rows_added": 0,
        }

    frame = provider.fetch(
        source["symbol"], start, end, interval=source["price_interval"],
        min_observations=None,  # incremental deltas may be tiny (weekends/holidays)
    )
    norm = _normalization_stats(frame)
    rows = to_price_rows(frame)
    if not rows:
        return {
            "status": "current",
            "dataset_id": dataset_id,
            "message": f"No new observations since {end.isoformat()}.",
            "rows_added": 0,
        }

    # Provider truth wins: replace the overlap window (at most the boundary
    # session) before inserting the fresh slice.
    outcome = database.replace_price_rows_from(dataset_id, rows, start)
    added = outcome["added"]
    replaced = outcome["replaced"]

    # Refresh rollups from the FULL stored history so metadata stays exact.
    all_rows = database.get_prices(dataset_id)
    full_frame = dataframe_from_price_records(all_rows)
    rollup = _summary_from_frame(full_frame)
    database.update_dataset_metadata(
        dataset_id,
        end_date=rollup["end_date"],
        row_count=rollup["row_count"],
        latest_close=rollup["latest_close"],
    )

    # Data changed -> every cached analysis is now stale.
    database.delete_analysis_caches(dataset_id)
    # Touch provenance so 'last_updated' reflects this refresh.
    database.upsert_dataset_source(
        dataset_id=dataset_id,
        provider=source["provider"],
        symbol=source["symbol"],
        instrument_name=source.get("instrument_name"),
        exchange=source.get("exchange"),
        asset_type=source.get("asset_type"),
        currency=source.get("currency"),
        price_interval=source.get("price_interval", "1d"),
    )

    return {
        "status": "updated" if added else "current",
        "dataset_id": dataset_id,
        "rows_added": added,
        "last_date": rollup["end_date"].isoformat(),
        "latest_close": rollup["latest_close"],
        "message": (
            f"Added {added} new observation(s)." if added else
            "Provider returned no rows beyond stored history; dataset unchanged."
        ),
        "receipt": {
            "provider": provider.name,
            "symbol": source["symbol"],
            "request_range": {"start": start.isoformat(), "end": end.isoformat()},
            "fetched": len(rows),
            "inserted": added,
            "replaced": replaced,
            "unchanged": max(0, len(rows) - replaced - added),
            "received_raw": norm["received_raw"],
            "valid": norm["valid"],
            "rejected": norm["rejected"],
            "last_stored_date": rollup["end_date"].isoformat(),
            "caches_invalidated": list(_CACHE_LABELS),
        },
    }


def _next_day(value):
    if value is None:
        return None
    return value + timedelta(days=1)


# ---------------------------------------------------------------------------
# Background job registry (stage-based progress for Phase J)
# ---------------------------------------------------------------------------

_STAGES = ("FETCHING", "VALIDATING", "WRITING TO MYSQL", "PREPARING DATASET")
_JOBS = {}
_JOBS_LOCK = threading.Lock()


def _persist_job(job):
    """Mirror one job snapshot into MySQL (best effort).

    Serverless platforms may route the status poll to a different instance
    than the one running the import thread, so job state is persisted to
    the ingestion_jobs table as well as the in-process registry. A storage
    failure must never break an ongoing import, hence the broad except.
    """
    try:
        database.upsert_ingestion_job(job)
    except Exception:
        pass


def create_import_job(payload):
    import uuid

    job_id = uuid.uuid4().hex[:12]
    with _JOBS_LOCK:
        _JOBS[job_id] = {
            "job_id": job_id,
            "status": "FETCHING",
            "stage": "FETCHING",
            "symbol": payload.get("symbol"),
            "provider": payload.get("provider") or "yahoo",
            "observations": None,
            "result": None,
            "error": None,
        }
        _persist_job(_JOBS[job_id])
    return _JOBS[job_id]


def run_import_job(job_id, payload):
    """BackgroundTask body wrapper: always mirrors the final job state."""
    try:
        return _run_import_job(job_id, payload)
    finally:
        with _JOBS_LOCK:
            job = _JOBS.get(job_id)
        if job is not None:
            _persist_job(job)


def _run_import_job(job_id, payload):
    """BackgroundTask body: drives one import through its stages."""
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
    if job is None:
        return

    def advance(stage, **extra):
        with _JOBS_LOCK:
            job["stage"] = stage
            job["status"] = stage
            job.update(extra)
        _persist_job(job)

    try:
        advance("FETCHING")
        provider = get_provider(payload.get("provider"))
        frame = provider.fetch(
            payload["symbol"],
            payload["start_date"],
            payload["end_date"],
            interval=payload.get("interval", "1d"),
        )
        norm = _normalization_stats(frame)
        observations = len(frame)
        advance(
            "VALIDATING",
            observations=observations,
            details={
                "received": norm["received_raw"],
                "valid": norm["valid"],
                "rejected": norm["rejected"],
                "unparseable_ohlc_removed": norm["unparseable_ohlc_removed"],
                "duplicate_dates_removed": norm["duplicate_dates_removed"],
                "invalid_candles_removed": norm["invalid_candles_removed"],
            },
        )

        advance("WRITING TO MYSQL")
        existing = find_existing_import(provider.name, payload["symbol"])
        if existing is not None:
            dataset_id = existing["dataset_id"]
            last_date = database.get_last_price_date(dataset_id)
            fetch_start = payload["start_date"]
            if last_date is not None:
                nxt = _next_day(last_date)
                if nxt > payload["end_date"]:
                    with _JOBS_LOCK:
                        job.update(
                            status="COMPLETE",
                            stage="COMPLETE",
                            result={
                                "status": "current",
                                "dataset_id": dataset_id,
                                "rows_added": 0,
                                "message": "History already current.",
                            },
                        )
                    return
                # Include the boundary session so stale provisional bars heal.
                fetch_start = min(payload["start_date"], last_date)
            added_rows = to_price_rows(frame)
            if not added_rows:
                with _JOBS_LOCK:
                    job.update(
                        status="COMPLETE",
                        stage="COMPLETE",
                        result={
                            "status": "current",
                            "dataset_id": dataset_id,
                            "rows_added": 0,
                            "message": "No new observations.",
                        },
                    )
                return
            outcome = database.replace_price_rows_from(
                dataset_id, added_rows, fetch_start
            )
            added = outcome["added"]
            replaced = outcome["replaced"]
            all_rows = database.get_prices(dataset_id)
            full_frame = dataframe_from_price_records(all_rows)
            rollup = _summary_from_frame(full_frame)
            database.update_dataset_metadata(
                dataset_id,
                end_date=rollup["end_date"],
                row_count=rollup["row_count"],
                latest_close=rollup["latest_close"],
            )
            database.delete_analysis_caches(dataset_id)
            src = database.get_dataset_source(dataset_id)
            database.upsert_dataset_source(
                dataset_id=dataset_id,
                provider=src["provider"],
                symbol=src["symbol"],
                instrument_name=src.get("instrument_name"),
                exchange=src.get("exchange"),
                asset_type=src.get("asset_type"),
                currency=src.get("currency"),
                price_interval=src.get("price_interval", "1d"),
            )
            with _JOBS_LOCK:
                job.update(
                    status="COMPLETE",
                    stage="COMPLETE",
                    result={
                        "status": "updated" if added else "current",
                        "dataset_id": dataset_id,
                        "rows_added": added,
                        "last_date": rollup["end_date"].isoformat(),
                        "message": f"Added {added} new observation(s)."
                        if added
                        else "No new observations.",
                        "receipt": {
                            "provider": provider.name,
                            "symbol": src["symbol"],
                            "instrument_name": src.get("instrument_name"),
                            "interval": src.get("price_interval", "1d"),
                            "request_range": {
                                "start": str(payload["start_date"]),
                                "end": str(payload["end_date"]),
                            },
                            "received": norm["received_raw"],
                            "valid": norm["valid"],
                            "rejected": norm["rejected"],
                            "fetched": len(added_rows),
                            "inserted": added,
                            "replaced": replaced,
                            "unchanged": max(
                                0, len(added_rows) - replaced - added
                            ),
                            "last_stored_date": rollup["end_date"].isoformat(),
                            "caches_invalidated": list(_CACHE_LABELS),
                        },
                    },
                )
            return

        advance("PREPARING DATASET")
        rollup = _summary_from_frame(frame)
        price_rows = to_price_rows(frame)
        dataset_id = database.store_dataset(
            filename=f"{payload['symbol'].upper()}_{payload.get('interval', '1d')}.csv",
            start_date=rollup["start_date"],
            end_date=rollup["end_date"],
            row_count=rollup["row_count"],
            latest_close=rollup["latest_close"],
            price_rows=price_rows,
            metrics=rollup["summary"],
        )
        database.upsert_dataset_source(
            dataset_id=dataset_id,
            provider=provider.name,
            symbol=str(payload["symbol"]).upper(),
            instrument_name=payload.get("name"),
            exchange=payload.get("exchange"),
            asset_type=payload.get("asset_type"),
            currency=payload.get("currency"),
            price_interval=payload.get("interval", "1d"),
        )
        readiness = _analysis_readiness(rollup["row_count"])
        with _JOBS_LOCK:
            job.update(
                status="COMPLETE",
                stage="COMPLETE",
                result={
                    "status": "complete",
                    "dataset_id": dataset_id,
                    "rows_added": rollup["row_count"],
                    "start_date": rollup["start_date"].isoformat(),
                    "end_date": rollup["end_date"].isoformat(),
                    "latest_close": rollup["latest_close"],
                    "receipt": {
                        "provider": provider.name,
                        "symbol": str(payload["symbol"]).upper(),
                        "instrument_name": payload.get("name"),
                        "interval": payload.get("interval", "1d"),
                        "received": norm["received_raw"],
                        "valid": norm["valid"],
                        "rejected": norm["rejected"],
                        "inserted": rollup["row_count"],
                        "replaced": 0,
                        "duplicates": 0,
                        "mysql": {
                            "dataset_record": True,
                            "source_metadata": True,
                            "price_observations": len(price_rows),
                        },
                        "analysis": readiness,
                    },
                },
            )
    except Exception as exc:
        with _JOBS_LOCK:
            job.update(status="FAILED", stage="FAILED", error=str(exc))


def get_import_job(job_id):
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
    if job is not None:
        # Return a snapshot without internal locks.
        return dict(job)
    # Serverless fallback: this instance may not be the one that ran the
    # import thread — recover the persisted state from MySQL instead.
    try:
        return database.get_ingestion_job(job_id)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Live quotes (near-real-time, cached)
# ---------------------------------------------------------------------------

_QUOTE_CACHE = {}
_QUOTE_TTL_SECONDS = 60


def get_live_quote(symbol):
    """Lightweight latest quote for one symbol (no DB writes).

    Cached in-process for _QUOTE_TTL_SECONDS so dashboard auto-refresh
    never hammers the provider. Raises InvalidSymbol/DataSourceUnavailable
    on failure — routes translate that into graceful errors.
    """
    import time as _time

    key = str(symbol).upper().strip()
    now = _time.time()
    cached = _QUOTE_CACHE.get(key)
    if cached and now - cached["ts"] < _QUOTE_TTL_SECONDS:
        return {**cached["quote"], "cached": True}

    import yfinance as yf

    ticker = yf.Ticker(key)
    info = ticker.fast_info
    price = float(info.last_price) if info.last_price is not None else None
    prev = float(info.previous_close) if info.previous_close is not None else None
    if price is None:
        raise DataSourceUnavailable(f"No live quote available for '{key}'.")
    change = price - prev if prev is not None else None
    quote = {
        "symbol": key,
        "price": round(price, 4),
        "previous_close": round(prev, 4) if prev is not None else None,
        "change": round(change, 4) if change is not None else None,
        "change_percent": round(change / prev * 100, 2)
        if change is not None and prev else None,
        "currency": str(getattr(info, "currency", "") or ""),
        "source": "yahoo",
        "as_of": _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime()),
    }
    _QUOTE_CACHE[key] = {"ts": now, "quote": quote}
    return {**quote, "cached": False}


def list_market_universe():
    """Lightweight multi-asset summary for overview/AI contexts (Phase M).

    Computes 1D/5D/20D returns, 20D annualized volatility, drawdown from
    running maximum and 60D momentum directly from stored prices. Regime
    labels come from the persisted regime model when available — no heavy
    discovery runs here.
    """
    import pandas as pd

    sources = database.list_dataset_sources()
    universe = []
    for dataset in database.list_datasets():
        source = sources.get(dataset["id"])
        rows = database.get_prices(dataset["id"])
        if not rows or len(rows) < 6:
            continue
        closes = pd.Series([float(r["close"]) for r in rows], dtype="float64")
        dates = [str(r["date"])[:10] for r in rows]
        latest = float(closes.iloc[-1])

        def ret(days):
            if len(closes) <= days:
                return None
            base = float(closes.iloc[-1 - days])
            return (latest - base) / base if base else None

        window = closes.tail(21)
        vol_20d = None
        if len(window) >= 10:
            daily = window.pct_change().dropna()
            if len(daily) >= 5:
                vol_20d = float(daily.std(ddof=0) * (252 ** 0.5))

        peak = float(closes.cummax().iloc[-1])
        drawdown = (latest - peak) / peak if peak else None

        momentum_60d = ret(60)

        regime_label = None
        try:
            model = database.get_stored_regime_model(dataset["id"])
            if model and model.get("model_json"):
                current = (model["model_json"].get("current_regime") or {}).get(
                    "current_regime"
                ) or {}
                regime_label = current.get("label")
        except database.DatabaseError:
            regime_label = None

        universe.append(
            {
                "dataset_id": dataset["id"],
                "filename": dataset["filename"],
                "start_date": dates[0],
                "end_date": dates[-1],
                "row_count": dataset["row_count"],
                "latest_close": latest,
                "return_1d": ret(1),
                "return_5d": ret(5),
                "return_20d": ret(20),
                "volatility_20d_annualized": vol_20d,
                "drawdown": drawdown,
                "momentum_60d": momentum_60d,
                "regime_label": regime_label,
                "source": source,
            }
        )
    return universe
