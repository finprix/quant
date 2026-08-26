"""Market-data ingestion orchestration.

Pipeline (Phase E contract):

    request -> validate symbol/date range
            -> provider.fetch (external I/O; mockable in tests)
            -> normalize_ohlcv (shared, strict)
            -> store: new dataset OR incremental append
            -> provenance row in dataset_sources
            -> invalidate affected analysis caches
            -> return dataset id

Import jobs execute as bounded, resumable steps: every
/market/import/step request performs at most one provider fetch window and
persists its resume cursor, so multi-year downloads survive serverless
request timeouts and instance loss. Locally, run_import_job() drives the
identical stepper in a background task.
"""

import os
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
_JOB_LOCKS = {}
_JOB_LOCKS_GUARD = threading.Lock()

# Serverless-safe chunking: every /market/import/step request performs at
# most one provider fetch covering this many calendar days, so no single
# request can outlive a platform timeout regardless of the requested range.
_CHUNK_DAYS = max(30, int(os.environ.get("IMPORT_CHUNK_DAYS", "380") or 380))


def _persist_job(job):
    """Mirror one job snapshot into MySQL (best effort).

    Serverless platforms may route any call to a different instance than
    the previous one, so job state is persisted to the ingestion_jobs
    table as well as the in-process registry. A storage failure must
    never break an ongoing import, hence the broad except.
    """
    try:
        database.upsert_ingestion_job(job)
    except Exception:
        pass


def _job_lock(job_id):
    with _JOB_LOCKS_GUARD:
        lock = _JOB_LOCKS.get(job_id)
        if lock is None:
            lock = threading.Lock()
            _JOB_LOCKS[job_id] = lock
        return lock


def create_import_job(payload):
    """Register an import job in QUEUED state (serverless-resumable).

    The full request payload and the resume cursor live inside result,
    which is persisted after every step — any instance can pick the job
    up exactly where the last one left off.
    """
    import uuid

    job_id = uuid.uuid4().hex[:12]
    start = payload["start_date"]
    end = payload["end_date"]

    def iso(value):
        return value.isoformat() if hasattr(value, "isoformat") else str(value)

    request = {
        "symbol": str(payload["symbol"]).upper(),
        "start_date": iso(start),
        "end_date": iso(end),
        "interval": payload.get("interval", "1d"),
        "provider": payload.get("provider") or "yahoo",
        "name": payload.get("name"),
        "exchange": payload.get("exchange"),
        "asset_type": payload.get("asset_type"),
        "currency": payload.get("currency"),
    }
    with _JOBS_LOCK:
        _JOBS[job_id] = {
            "job_id": job_id,
            "status": "QUEUED",
            "stage": "QUEUED",
            "symbol": request["symbol"],
            "provider": request["provider"],
            "observations": None,
            "result": {
                "phase": "queued",
                "request": request,
                "cursor": request["start_date"],
                "chunks_done": 0,
                "rows_added_total": 0,
                "replaced_total": 0,
                "received_total": 0,
                "valid_total": 0,
                "rejected_total": 0,
                "dataset_id": None,
                "last_stored_date": None,
            },
            "error": None,
        }
        _persist_job(_JOBS[job_id])
    return dict(_JOBS[job_id])


def run_import_job(job_id, payload=None):
    """Drive an import to completion inside one process (local mode).

    On serverless the client advances the same state machine one bounded
    step at a time via advance_import_step(); this loop simply calls that
    identical stepper until it reports a terminal state.
    """
    try:
        for _ in range(10000):
            snapshot = advance_import_step(job_id)
            if snapshot is None or snapshot.get("status") in ("COMPLETE", "FAILED"):
                return snapshot
        return advance_import_step(job_id)
    finally:
        with _JOBS_LOCK:
            job = _JOBS.get(job_id)
        if job is not None:
            _persist_job(job)


def advance_import_step(job_id):
    """Advance one bounded chunk of an import job; serverless-safe.

    The provider call happens inside the calling request, and all steering
    state (cursor, dataset id, running totals) is persisted before the
    response returns, so the job survives instance loss between steps.
    A failed step leaves the cursor untouched, so simply calling step
    again retries the exact same window once the provider recovers.
    Returns the job snapshot, or None for an unknown job id.
    """
    with _job_lock(job_id):
        job = _load_job(job_id)
        if job is None:
            return None
        result = job.get("result")
        if not isinstance(result, dict) or not result.get("request"):
            return dict(job)  # legacy job shape predating the stepper
        if result.get("phase") == "complete":
            return dict(job)
        try:
            _advance_chunk(job)
        except Exception as exc:
            job["result"]["phase"] = "failed"
            with _JOBS_LOCK:
                job["status"] = "FAILED"
                job["stage"] = "FAILED"
                job["error"] = str(exc)
            _persist_job(job)
        return dict(job)


def _load_job(job_id):
    """Return the live job dict, reconstructing from storage when needed."""
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
    if job is not None:
        return job
    try:
        persisted = database.get_ingestion_job(job_id)
    except Exception:
        return None
    if persisted is None:
        return None
    job = {
        "job_id": persisted["job_id"],
        "status": persisted["status"],
        "stage": persisted["stage"],
        "symbol": persisted.get("symbol"),
        "provider": persisted.get("provider"),
        "observations": persisted.get("observations"),
        "result": persisted.get("result"),
        "error": persisted.get("error"),
    }
    with _JOBS_LOCK:
        existing = _JOBS.setdefault(job_id, job)
    return existing


def _publish_stage(job, stage):
    with _JOBS_LOCK:
        job["stage"] = stage
        job["status"] = stage
    _persist_job(job)


def _refresh_dataset_rollup(dataset_id):
    """Recompute dataset metadata from every stored price row."""
    all_rows = database.get_prices(dataset_id)
    full_frame = dataframe_from_price_records(all_rows)
    rollup = _summary_from_frame(full_frame)
    database.update_dataset_metadata(
        dataset_id,
        end_date=rollup["end_date"],
        row_count=rollup["row_count"],
        latest_close=rollup["latest_close"],
    )
    return rollup


def _advance_chunk(job):
    """Perform at most one provider fetch window for this job."""
    result = job["result"]
    request = result["request"]
    cursor = date.fromisoformat(result["cursor"])
    end = date.fromisoformat(request["end_date"])

    provider = get_provider(request["provider"])
    dataset_id = result.get("dataset_id")

    # First step: attach to an existing import of the same instrument, or
    # short-circuit when stored history already covers the whole range.
    if dataset_id is None and result.get("chunks_done", 0) == 0:
        existing = find_existing_import(provider.name, request["symbol"])
        if existing is not None:
            last = database.get_last_price_date(existing["dataset_id"])
            if last is not None and last >= end:
                result["dataset_id"] = existing["dataset_id"]
                _finalize_complete(
                    job, provider, request,
                    message="History already current.",
                    rows_added=0,
                )
                return
            result["dataset_id"] = existing["dataset_id"]
            dataset_id = existing["dataset_id"]

    if cursor > end:
        _finalize_complete(job, provider, request)
        return

    chunk_end = min(cursor + timedelta(days=_CHUNK_DAYS - 1), end)
    _publish_stage(job, "FETCHING")
    frame = provider.fetch(
        request["symbol"],
        cursor,
        chunk_end,
        interval=request.get("interval", "1d"),
    )
    norm = _normalization_stats(frame)

    def bump_totals():
        result["received_total"] += norm["received_raw"]
        result["valid_total"] += norm["valid"]
        result["rejected_total"] += norm["rejected"]

    def advance_cursor():
        result["cursor"] = (chunk_end + timedelta(days=1)).isoformat()
        result["chunks_done"] = result.get("chunks_done", 0) + 1

    if len(frame) == 0:
        if dataset_id is None:
            raise InvalidSymbol(
                f"No observations for '{request['symbol']}' between "
                f"{request['start_date']} and {chunk_end.isoformat()}."
            )
        bump_totals()
        advance_cursor()
        _finalize_complete(job, provider, request)
        return

    _publish_stage(job, "VALIDATING")
    price_rows = to_price_rows(frame)
    if not price_rows:
        if dataset_id is None:
            raise DataSourceUnavailable(
                "Provider returned data but no rows survived validation."
            )
        bump_totals()
        advance_cursor()
        _finalize_complete(job, provider, request)
        return

    _publish_stage(job, "WRITING TO MYSQL")
    fetch_start = frame["Date"].min().date()
    if dataset_id is None:
        rollup = _summary_from_frame(frame)
        dataset_id = database.store_dataset(
            filename=f"{request['symbol']}_{request.get('interval', '1d')}.csv",
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
            symbol=request["symbol"],
            instrument_name=request.get("name"),
            exchange=request.get("exchange"),
            asset_type=request.get("asset_type"),
            currency=request.get("currency"),
            price_interval=request.get("interval", "1d"),
        )
        outcome = {"added": rollup["row_count"], "replaced": 0}
    else:
        outcome = database.replace_price_rows_from(
            dataset_id, price_rows, fetch_start
        )

    # Only now — after the window is durably stored — move the cursor, so
    # a crash mid-write makes the next step retry this exact window.
    rollup = _refresh_dataset_rollup(dataset_id)
    database.delete_analysis_caches(dataset_id)
    bump_totals()
    advance_cursor()

    result["dataset_id"] = dataset_id
    result["rows_added_total"] += outcome["added"]
    result["replaced_total"] += outcome["replaced"]
    result["last_stored_date"] = rollup["end_date"].isoformat()
    result["observations"] = rollup["row_count"]
    with _JOBS_LOCK:
        job["observations"] = rollup["row_count"]

    if date.fromisoformat(result["cursor"]) > end:
        _finalize_complete(job, provider, request)
    else:
        _publish_stage(job, "FETCHING")


def _finalize_complete(job, provider, request, message=None, rows_added=None):
    """Mark a job COMPLETE and assemble its final receipt."""
    result = job["result"]
    dataset_id = result.get("dataset_id")
    readiness = None
    total_added = (
        rows_added if rows_added is not None else result.get("rows_added_total", 0)
    )
    if dataset_id is not None:
        rollup = _refresh_dataset_rollup(dataset_id)
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
        result["last_stored_date"] = rollup["end_date"].isoformat()
        result["observations"] = rollup["row_count"]
        readiness = _analysis_readiness(rollup["row_count"])
        with _JOBS_LOCK:
            job["observations"] = rollup["row_count"]

    final_message = message or (
        f"Added {total_added} new observation(s)."
        if total_added
        else "No new observations."
    )
    receipt = {
        "provider": provider.name,
        "symbol": request["symbol"],
        "instrument_name": request.get("name"),
        "interval": request.get("interval", "1d"),
        "request_range": {
            "start": request["start_date"],
            "end": request["end_date"],
        },
        "received": result.get("received_total", 0),
        "valid": result.get("valid_total", 0),
        "rejected": result.get("rejected_total", 0),
        "fetched": result.get("valid_total", 0),
        "inserted": total_added,
        "replaced": result.get("replaced_total", 0),
        "unchanged": max(
            0,
            result.get("received_total", 0)
            - result.get("replaced_total", 0)
            - total_added,
        ),
        "last_stored_date": result.get("last_stored_date"),
        "caches_invalidated": list(_CACHE_LABELS),
        "mysql": {
            "dataset_record": dataset_id is not None,
            "source_metadata": dataset_id is not None,
            "price_observations": result.get("observations") or 0,
        },
        "analysis": readiness,
        "mode": "stepped",
        "chunks": result.get("chunks_done", 0),
    }
    final_result = {
        "phase": "complete",
        "status": "current" if total_added == 0 else "complete",
        "dataset_id": dataset_id,
        "rows_added": total_added,
        "message": final_message,
        "receipt": receipt,
    }
    with _JOBS_LOCK:
        job["status"] = "COMPLETE"
        job["stage"] = "COMPLETE"
        job["result"] = final_result
    _persist_job(job)


def get_import_job(job_id):
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
    if job is not None:
        # Return a snapshot without internal locks.
        return dict(job)
    # Serverless fallback: this instance may not be the one that ran the
    # previous step — recover the persisted state from MySQL instead.
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
        "volume": int(info.last_volume)
        if getattr(info, "last_volume", None) else None,
        "currency": str(getattr(info, "currency", "") or ""),
        "source": "yahoo",
        "as_of": _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime()),
    }
    _QUOTE_CACHE[key] = {"ts": now, "quote": quote}
    return {**quote, "cached": False}


def _normalize_news_entries(raw, limit):
    """Map provider news entries (old + new yfinance shapes) to plain dicts."""
    import time as _time

    items = []
    for entry in (raw or [])[:limit]:
        if not isinstance(entry, dict):
            continue
        content = entry.get("content") if isinstance(entry.get("content"), dict) else entry
        link = None
        if isinstance(content.get("clickThroughUrl"), dict):
            link = content["clickThroughUrl"].get("url")
        if not link and isinstance(content.get("canonicalUrl"), dict):
            link = content["canonicalUrl"].get("url")
        if not link and isinstance(content.get("link"), str):
            link = content["link"]
        published = None
        if content.get("pubDate"):
            published = str(content["pubDate"])
        elif content.get("providerPublishTime") is not None:
            ts = content["providerPublishTime"]
            published = (
                _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime(ts))
                if isinstance(ts, (int, float))
                else str(ts)
            )
        publisher = (
            (content.get("provider") or {}).get("displayName")
            if isinstance(content.get("provider"), dict)
            else content.get("publisher")
        )
        title = content.get("title")
        if title:
            items.append(
                {"title": title, "publisher": publisher, "link": link,
                 "published": published}
            )
    return items


def get_symbol_news(symbol, limit=8):
    """Public headlines for one symbol via the provider (pass-through).

    Primary source is the ticker news endpoint; when it returns nothing
    the structured search endpoint's news feed is used as a fallback so a
    single quiet endpoint never blanks an entire panel.
    """
    import yfinance as yf

    key = str(symbol).upper().strip()
    try:
        raw = yf.Ticker(key).news or []
    except Exception:
        raw = []
    items = _normalize_news_entries(raw, limit)
    if not items:
        try:
            search = yf.Search(query=key, max_results=0, news_count=limit)
            items = _normalize_news_entries(getattr(search, "news", None), limit)
        except Exception:
            items = []
    return items


def get_watchlist_quotes():
    """Watchlist rows merged with live quotes (per-symbol graceful errors)."""
    entries = database.list_watchlist()
    out = []
    for entry in entries:
        row = {**entry, "quote": None, "quote_error": None}
        try:
            row["quote"] = get_live_quote(entry["symbol"])
        except Exception as exc:
            row["quote_error"] = str(exc)[:160]
        out.append(row)
    return out


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

        evidence_bias = None
        evidence_generated_at = None
        try:
            stored_evidence = database.get_latest_intelligence_evidence(
                dataset["id"]
            )
            if stored_evidence:
                evidence_bias = stored_evidence["bias_score"]
                evidence_generated_at = stored_evidence["generated_at"]
        except database.DatabaseError:
            pass

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
                "evidence_bias": evidence_bias,
                "evidence_generated_at": evidence_generated_at,
                "source": source,
            }
        )
    return universe
