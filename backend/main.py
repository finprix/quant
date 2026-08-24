"""QUANT VECTOR backend entry point.

FastAPI application that accepts historical OHLCV CSV uploads, validates
them, persists everything to MySQL and runs the quantitative analytics
engine defined in analytics.py.
"""

import io
import os
from collections import OrderedDict
from contextlib import asynccontextmanager
from datetime import date as dt_date

import pandas as pd
from fastapi import (
    BackgroundTasks,
    Body,
    Depends,
    FastAPI,
    File,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
)
from fastapi.middleware.cors import CORSMiddleware

import ai_engine
import auth
import cross_market
import database
import db_inspector
import fingerprint
import intelligence
import market_ingest
import regimes

# Local development configuration (.env next to this file). Real environment
# variables always take precedence.
auth.load_dotenv()

from analytics import (
    calculate_summary,
    calculate_timeseries,
    clean_ohlcv,
    missing_columns,
)
from data_sources import (
    DataSourceUnavailable,
    InvalidRequest,
    InvalidSymbol,
    MarketDataError,
    SUPPORTED_INTERVALS,
    get_provider,
)


@asynccontextmanager
async def lifespan(_):
    """Ensure schema objects exist so the API works right after boot."""
    try:
        database.initialize_schema()
        print("MySQL schema verified.")
    except database.DatabaseError as exc:
        # Keep serving /health; database routes report 503 until MySQL is up.
        print(f"WARNING: MySQL not reachable at startup: {exc}")
    yield


app = FastAPI(title="QUANT VECTOR API", version="0.13.0", lifespan=lifespan)

_ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.environ.get(
        "MARKETDNA_ALLOWED_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------
# Access control â€” guest (read-only) vs developer (full administration)
# --------------------------------------------------------------------------

def require_developer(request: Request) -> str:
    """Reusable guard for every state-changing endpoint.

    401 â€” no valid developer session (guests and anonymous visitors).
    403 â€” reserved for role escalation; Quant Vector has a single elevated
          role, so it is currently unused but kept part of the contract.
    """
    if not auth.auth_configured():
        raise HTTPException(
            status_code=503,
            detail=(
                "Developer authentication is not configured on this server "
                "(MARKETDNA_DEV_PIN_HASH missing)."
            ),
        )
    token = request.cookies.get(auth.SESSION_COOKIE)
    subject = auth.read_session_token(token) if token else None
    if not subject:
        raise HTTPException(
            status_code=401,
            detail="DEVELOPER ACCESS REQUIRED — dataset modification is restricted to developer sessions.",
        )
    return subject


@app.post("/auth/login")
def auth_login(payload: dict, request: Request, response: Response):
    """Validate the developer PIN and establish an HTTP-only session."""
    pin = str(payload.get("pin") or "").strip()
    if not pin:
        raise HTTPException(status_code=422, detail="'pin' is required.")
    if len(pin) > 128:
        raise HTTPException(status_code=422, detail="'pin' is too long.")
    client_ip = request.client.host if request.client else "unknown"
    key = f"{client_ip}|pin"
    limiter = auth.login_rate_limiter
    if limiter.blocked(key):
        raise HTTPException(
            status_code=429,
            detail="Too many failed login attempts. Try again shortly.",
            headers={"Retry-After": str(limiter.retry_after(key))},
        )
    ok = auth.auth_configured() and auth.verify_password(
        pin, auth.configured_pin_hash()
    )
    if not ok:
        limiter.record_failure(key)
        # Uniform failure message - never reveal anything about the PIN.
        raise HTTPException(status_code=401, detail="Invalid credentials.")
    limiter.reset(key)
    response.set_cookie(
        value=auth.create_session_token("developer"), **auth.cookie_kwargs()
    )
    return {"authenticated": True, "role": "developer"}


@app.post("/auth/logout")
def auth_logout(response: Response):
    """Remove the developer session completely."""
    kwargs = auth.cookie_kwargs()
    kwargs.pop("max_age", None)
    response.delete_cookie(**kwargs)
    return {"authenticated": False, "role": None}


@app.get("/auth/session")
def auth_session(request: Request):
    """Restore session state after a page refresh."""
    token = request.cookies.get(auth.SESSION_COOKIE)
    subject = auth.read_session_token(token) if token else None
    if not subject:
        return {"authenticated": False, "role": None}
    return {"authenticated": True, "role": "developer"}


@app.get("/health")
def health():
    """Liveness probe."""
    return {"status": "ok"}


@app.post("/upload", dependencies=[Depends(require_developer)])
async def upload(file: UploadFile = File(...)):
    """Accept an OHLCV CSV file, validate it, store it in MySQL and return statistics."""
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    try:
        df = pd.read_csv(io.BytesIO(content))
    except Exception:
        raise HTTPException(status_code=400, detail="File could not be parsed as CSV.")

    absent = missing_columns(df)
    if absent:
        raise HTTPException(
            status_code=400,
            detail=f"Missing required columns: {', '.join(absent)}",
        )

    df = clean_ohlcv(df)
    if df.empty:
        raise HTTPException(status_code=400, detail="No valid data rows found in file.")

    summary = calculate_summary(df)
    timeseries = calculate_timeseries(df)

    dataset_info = {
        "filename": file.filename,
        "rows": int(len(df)),
        "start_date": df["Date"].iloc[0].date().isoformat(),
        "end_date": df["Date"].iloc[-1].date().isoformat(),
        "latest_close": summary["latest_close"],
    }

    price_rows = [
        (
            row.Date.date(),
            float(row.Open),
            float(row.High),
            float(row.Low),
            float(row.Close),
            int(row.Volume),
        )
        for row in df.itertuples(index=False)
    ]

    try:
        dataset_id = database.store_dataset(
            filename=file.filename,
            start_date=df["Date"].iloc[0].date(),
            end_date=df["Date"].iloc[-1].date(),
            row_count=int(len(df)),
            latest_close=summary["latest_close"],
            price_rows=price_rows,
            metrics=summary,
        )
    except database.DatabaseError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    dataset_info["id"] = dataset_id

    return {
        "dataset": dataset_info,
        "summary": summary,
        "timeseries": timeseries,
    }


@app.get("/datasets")
def list_all_datasets():
    """Return every stored dataset."""
    try:
        return {"datasets": database.list_datasets()}
    except database.DatabaseError as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@app.get("/datasets/{dataset_id}")
def get_dataset(dataset_id: int):
    """Return one dataset's metadata and stored summary statistics."""
    try:
        dataset = database.get_dataset(dataset_id)
    except database.DatabaseError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    if dataset is None:
        raise HTTPException(status_code=404, detail=f"Dataset {dataset_id} not found.")
    return dataset


@app.get("/datasets/{dataset_id}/prices")
def get_dataset_prices(dataset_id: int):
    """Return stored historical OHLCV rows for a dataset."""
    try:
        if not database.dataset_exists(dataset_id):
            raise HTTPException(status_code=404, detail=f"Dataset {dataset_id} not found.")
        prices = database.get_prices(dataset_id)
    except database.DatabaseError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    return {"dataset_id": dataset_id, "count": len(prices), "prices": prices}


@app.delete("/datasets/{dataset_id}", dependencies=[Depends(require_developer)])
def remove_dataset(dataset_id: int):
    """Delete a dataset and all related records."""
    try:
        deleted = database.delete_dataset(dataset_id)
    except database.DatabaseError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    if not deleted:
        raise HTTPException(status_code=404, detail=f"Dataset {dataset_id} not found.")
    return {"deleted": True, "id": dataset_id}


def _fetch_dataset_frame(dataset_id: int):
    """Load a stored dataset from MySQL as a canonical OHLCV DataFrame."""
    try:
        if not database.dataset_exists(dataset_id):
            raise HTTPException(
                status_code=404, detail=f"Dataset {dataset_id} not found."
            )
        prices = database.get_prices(dataset_id)
    except database.DatabaseError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    if not prices:
        raise HTTPException(
            status_code=404,
            detail=f"Dataset {dataset_id} has no stored price rows.",
        )
    return fingerprint.dataframe_from_price_records(prices)


def _parse_dataset_ids(ids: str, min_ids: int, max_ids: int):
    """Validate a comma-separated dataset id list for comparison routes."""
    parsed = [part.strip() for part in ids.split(",") if part.strip()]
    if len(parsed) < min_ids or len(parsed) > max_ids:
        raise HTTPException(
            status_code=422,
            detail=f"Provide between {min_ids} and {max_ids} dataset ids.",
        )
    if len(set(parsed)) != len(parsed):
        raise HTTPException(
            status_code=422,
            detail="Duplicate dataset ids are not allowed in a comparison.",
        )
    try:
        return [int(part) for part in parsed]
    except ValueError:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid dataset id list: {ids!r}",
        )


# ---------------------------------------------------------------------------
# Process-local result caches.
#
# Datasets are immutable after upload (there is no update route) and receive
# a fresh id on every upload; deletion cascades all child rows. Therefore
# (dataset_id, row_count, last_date) fully determines every derived result,
# so these caches can never serve stale content. They are bounded to keep
# memory flat and are intentionally process-local (no cross-restart claims).
# ---------------------------------------------------------------------------

_FINGERPRINT_CACHE = OrderedDict()
_FINGERPRINT_CACHE_MAX = 16

_COMPARISON_REFERENCE_CACHE = OrderedDict()
_COMPARISON_REFERENCE_MAX = 8


def _fingerprint_cached(dataset_id: int, frame):
    """Full-fidelity fingerprint with an in-process reuse layer.

    The DB fingerprint table stores numeric metrics only, so reusing it
    would drop categorical fields such as ma20_ma50_relationship. The
    in-process cache keeps complete results instead.
    """
    key = (
        int(dataset_id),
        int(len(frame)),
        pd.Timestamp(frame["Date"].iloc[-1]).strftime("%Y-%m-%d"),
    )
    cached = _FINGERPRINT_CACHE.get(key)
    if cached is not None:
        _FINGERPRINT_CACHE.move_to_end(key)
        return cached, True
    result = fingerprint.calculate_fingerprint(frame)
    _FINGERPRINT_CACHE[key] = result
    _FINGERPRINT_CACHE.move_to_end(key)
    while len(_FINGERPRINT_CACHE) > _FINGERPRINT_CACHE_MAX:
        _FINGERPRINT_CACHE.popitem(last=False)
    return result, False


def _comparison_reference_cached(frames):
    """Memoize the pooled sliding-window reference population per id-set."""
    key = tuple(
        sorted(
            (int(dataset_id), int(len(frame)),
             pd.Timestamp(frame["Date"].iloc[-1]).strftime("%Y-%m-%d"))
            for dataset_id, frame in frames.items()
        )
    )
    cached = _COMPARISON_REFERENCE_CACHE.get(key)
    if cached is not None:
        _COMPARISON_REFERENCE_CACHE.move_to_end(key)
        return cached
    reference = fingerprint._comparison_reference(frames)
    _COMPARISON_REFERENCE_CACHE[key] = reference
    _COMPARISON_REFERENCE_CACHE.move_to_end(key)
    while len(_COMPARISON_REFERENCE_CACHE) > _COMPARISON_REFERENCE_MAX:
        _COMPARISON_REFERENCE_CACHE.popitem(last=False)
    return reference


@app.get("/datasets/{dataset_id}/fingerprint")
def dataset_fingerprint(dataset_id: int):
    """Return the statistical fingerprint of a stored dataset."""
    frame = _fetch_dataset_frame(dataset_id)
    result, cache_hit = _fingerprint_cached(dataset_id, frame)

    payload = {
        "dataset_id": dataset_id,
        "samples_used": int(len(frame)),
        "fingerprint": result,
        "cached": bool(cache_hit),
    }
    try:
        database.store_fingerprint(dataset_id, result)
        payload["persisted"] = True
    except database.DatabaseError as exc:
        payload["persisted"] = False
        payload["warning"] = str(exc)
    return payload


@app.get("/datasets/{dataset_id}/analogues")
def dataset_analogues(
    dataset_id: int,
    lookback: int = Query(default=60, ge=20, le=250),
    top_n: int = Query(default=5, ge=1, le=25),
):
    """Find historical windows most statistically similar to recent behaviour."""
    frame = _fetch_dataset_frame(dataset_id)
    result = fingerprint.find_historical_analogues(
        frame, lookback=lookback, top_n=top_n
    )

    payload = {
        "dataset_id": dataset_id,
        "disclaimer": (
            "Analogue outcomes are historical observations of similar "
            "statistical conditions. They are not predictions."
        ),
        **result,
    }
    if result["analogues"]:
        try:
            database.store_analogues(dataset_id, result["analogues"])
            payload["persisted"] = True
        except database.DatabaseError as exc:
            payload["persisted"] = False
            payload["warning"] = str(exc)
    return payload


@app.get("/datasets/compare/fingerprints")
def compare_dataset_fingerprints(ids: str = Query(...)):
    """Pairwise scale-free fingerprint comparison for 2-4 datasets.

    Reuses the Phase 3 VECTOR_FEATURES pipeline: each dataset's full-history
    fingerprint vector is built exactly as the analogue engine does, then
    compared pairwise via Euclidean distance, cross-set standardized
    (z-scored) distance, and a median-scaled similarity score.
    """
    dataset_ids = _parse_dataset_ids(ids, min_ids=2, max_ids=4)

    vectors = {}
    frames = {}
    metadata = {}
    for dataset_id in dataset_ids:
        frame = _fetch_dataset_frame(dataset_id)
        frames[dataset_id] = frame
        vectors[dataset_id] = fingerprint.build_fingerprint_vector(frame)
        dataset = database.get_dataset(dataset_id)
        metadata[dataset_id] = {
            key: dataset.get(key) if dataset else None
            for key in ("filename", "start_date", "end_date", "row_count", "latest_close")
        }

    result = fingerprint.pairwise_fingerprint_comparison(
        vectors,
        _comparison_reference_cached(frames),
    )

    return {
        "dataset_ids": dataset_ids,
        "features": list(fingerprint.VECTOR_FEATURES),
        "metadata": metadata,
        **result,
    }


@app.get("/datasets/compare/correlation")
def compare_dataset_correlation(
    ids: str = Query(...),
    pair_focus: str | None = Query(default=None),
):
    """Daily-return cross-market analysis for 2-10 datasets.

    Returns symmetric Pearson / Spearman / covariance / downside / upside
    correlation matrices over overlapping trading dates, overlap counts,
    pair-level rolling-correlation summaries and both directional OLS
    regressions per pair. `pair_focus=a,b` additionally returns rolling
    correlation series and an aligned daily-return scatter for one pair.
    """
    dataset_ids = _parse_dataset_ids(ids, min_ids=2, max_ids=10)

    focus_ids = None
    if pair_focus is not None:
        focus_ids = _parse_dataset_ids(pair_focus, min_ids=2, max_ids=2)
        if not set(focus_ids).issubset(set(dataset_ids)):
            raise HTTPException(
                status_code=422,
                detail="pair_focus ids must be part of the compared id list.",
            )

    frames = {}
    metadata = {}
    for dataset_id in dataset_ids:
        frame = _fetch_dataset_frame(dataset_id)
        frames[dataset_id] = frame
        dataset = database.get_dataset(dataset_id)
        metadata[dataset_id] = {
            key: dataset.get(key) if dataset else None
            for key in ("filename", "start_date", "end_date", "row_count", "latest_close")
        }

    result = cross_market.build_cross_market_analysis(frames)

    if focus_ids is not None:
        result["focus"] = {
            "dataset_a": int(focus_ids[0]),
            "dataset_b": int(focus_ids[1]),
            **cross_market.build_pair_focus(
                cross_market.daily_returns_from_frame(frames[focus_ids[0]]),
                cross_market.daily_returns_from_frame(frames[focus_ids[1]]),
            ),
        }

    return {
        "dataset_ids": [int(i) for i in dataset_ids],
        "metadata": metadata,
        **result,
    }


def _run_regime_discovery(dataset_id: int, window_size: int, k):
    """Shared discovery + persistence logic for the regime endpoints.

    Reuses the persisted regime model when it was produced by a semantically
    identical request on the same immutable dataset: auto-k requests reuse
    only auto-selected models, explicit-k requests only explicit models
    whose selected_k matches (both paths are deterministic). Deletion
    cascades stored models, so nothing stale can survive.
    """
    try:
        stored = database.get_stored_regime_model(dataset_id)
    except database.DatabaseError:
        stored = None

    if (
        stored
        and int(stored.get("window_size") or 0) == window_size
        and bool((stored.get("model") or {}).get("auto_selected")) == (k is None)
    ):
        stored_k = (stored.get("model") or {}).get("selected_k")
        if k is None or (stored_k is not None and int(stored_k) == int(k)):
            return {
                "dataset_id": dataset_id,
                "meta": {"cached": True, "model_id": stored.get("model_id")},
                **stored,
            }

    frame = _fetch_dataset_frame(dataset_id)
    try:
        result = regimes.discover_regimes(frame, window_size=window_size, k=k)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    if not result.get("available"):
        return {"dataset_id": dataset_id, **result}

    try:
        model_id = database.store_regime_model(
            dataset_id,
            regimes.summarize_for_persistence(result),
            result["timeline"],
        )
        result["persisted"] = True
        result["model_id"] = int(model_id)
    except database.DatabaseError as exc:
        result["persisted"] = False
        result["warning"] = str(exc)
    return {"dataset_id": dataset_id, **result}


@app.get("/datasets/{dataset_id}/regimes")
def dataset_regimes(
    dataset_id: int,
    window_size: int = Query(default=60, ge=20, le=250),
    k: int | None = Query(default=None, ge=2, le=8),
):
    """Discover market regimes: profiles, timeline, transitions, outcomes."""
    return _run_regime_discovery(dataset_id, window_size, k)


@app.get("/datasets/{dataset_id}/regimes/current")
def dataset_current_regime(
    dataset_id: int,
    window_size: int = Query(default=60, ge=20, le=250),
):
    """Lightweight current-regime response for dashboard polling."""
    payload = _run_regime_discovery(dataset_id, window_size, k=None)
    if not payload.get("available"):
        return payload
    return {
        "dataset_id": dataset_id,
        "window_size": payload["window_size"],
        "persisted": payload.get("persisted", False),
        "current_regime": payload["current_regime"],
        "disclaimer": payload["disclaimer"],
    }


def _intelligence_payload(dataset_id: int, params: dict):
    """Cache-aware orchestration for the intelligence endpoints.

    The cache is checked BEFORE any price rows are loaded: a valid snapshot
    (same parameter hash, dataset's latest market date unchanged) serves the
    request without reading price_data at all.
    """
    param_hash = database.intelligence_param_hash(params)

    cached = None
    try:
        cached = database.get_cached_intelligence(dataset_id, param_hash)
    except database.DatabaseError as exc:
        cache_warning = str(exc)
    else:
        cache_warning = None

    if cached is not None:
        payload = cached["intelligence"]
        payload["meta"] = {
            "cached": True,
            "snapshot_id": cached["id"],
            "generated_at": cached["generated_at"],
            "parameters": params,
        }
        return payload

    frame = _fetch_dataset_frame(dataset_id)
    result = intelligence.build_market_intelligence(frame, **params)

    dataset = database.get_dataset(dataset_id)
    result["dataset"] = {
        key: dataset.get(key)
        for key in ("filename", "start_date", "end_date", "row_count", "latest_close")
    } if dataset else {}

    latest_market_date = frame["Date"].iloc[-1].date()
    try:
        snapshot_id = database.store_intelligence_snapshot(
            dataset_id,
            latest_market_date,
            param_hash,
            params,
            result,
        )
        result["meta"] = {
            "cached": False,
            "snapshot_id": int(snapshot_id),
            "parameters": params,
        }
        result["persisted"] = True
    except database.DatabaseError as exc:
        result["meta"] = {"cached": False, "snapshot_id": None, "parameters": params}
        result["persisted"] = False
        result["warning"] = "; ".join(filter(None, [cache_warning, str(exc)]))

    return result


@app.get("/datasets/{dataset_id}/intelligence")
def dataset_intelligence(
    dataset_id: int,
    lookback: int = Query(default=60, ge=20, le=250),
    top_n: int = Query(default=5, ge=1, le=25),
    window_size: int = Query(default=60, ge=20, le=250),
    k: int | None = Query(default=None, ge=2, le=8),
):
    """Unified market intelligence: state, regimes, analogues, evidence."""
    params = {
        "lookback": lookback,
        "top_n": top_n,
        "window_size": window_size,
        "k": k,
    }
    return _intelligence_payload(dataset_id, params)


@app.get("/datasets/{dataset_id}/intelligence/summary")
def dataset_intelligence_summary(
    dataset_id: int,
    lookback: int = Query(default=60, ge=20, le=250),
    top_n: int = Query(default=5, ge=1, le=25),
    window_size: int = Query(default=60, ge=20, le=250),
    k: int | None = Query(default=None, ge=2, le=8),
):
    """Lightweight intelligence projection for dashboard widgets."""
    params = {
        "lookback": lookback,
        "top_n": top_n,
        "window_size": window_size,
        "k": k,
    }
    full = _intelligence_payload(dataset_id, params)
    scorecard = full.get("scorecard", {})
    regime = scorecard.get("regime", {})
    return {
        "dataset_id": dataset_id,
        "current_regime": {"id": regime.get("id"), "label": regime.get("label")},
        "directional_bias": scorecard.get("directional_bias"),
        "risk_level": scorecard.get("risk_level"),
        "confidence": scorecard.get("confidence"),
        "trend_state": scorecard.get("trend_state"),
        "volatility_state": scorecard.get("volatility_state"),
        "analogue_agreement": scorecard.get("analogue_agreement"),
        "summary": full.get("summary"),
        "disclaimers": full.get("disclaimers"),
        "meta": full.get("meta"),
    }


# ---------------------------------------------------------------------------
# Saved comparison presets (Phase 8)
# ---------------------------------------------------------------------------

_PRESET_MIN_IDS = 2
_PRESET_MAX_IDS = 10


def _validate_preset_payload(payload, *, partial=False):
    """Validate preset create/update bodies; returns normalized fields."""
    if not isinstance(payload, dict):
        raise HTTPException(status_code=422, detail="Request body must be a JSON object.")

    name = payload.get("name")
    dataset_ids = payload.get("dataset_ids")

    if not partial and (name is None or dataset_ids is None):
        raise HTTPException(
            status_code=422,
            detail="Both 'name' and 'dataset_ids' are required.",
        )
    if partial and name is None and dataset_ids is None:
        raise HTTPException(
            status_code=422,
            detail="Provide 'name' and/or 'dataset_ids'.",
        )

    if name is not None:
        if not isinstance(name, str) or not name.strip():
            raise HTTPException(status_code=422, detail="Preset name must be a non-empty string.")
        if len(name.strip()) > 120:
            raise HTTPException(
                status_code=422,
                detail="Preset name must be at most 120 characters.",
            )
        name = name.strip()

    if dataset_ids is not None:
        if (
            not isinstance(dataset_ids, list)
            or not all(isinstance(i, int) and not isinstance(i, bool) for i in dataset_ids)
        ):
            raise HTTPException(
                status_code=422,
                detail="'dataset_ids' must be a list of integer dataset ids.",
            )
        if not (_PRESET_MIN_IDS <= len(dataset_ids) <= _PRESET_MAX_IDS):
            raise HTTPException(
                status_code=422,
                detail=(
                    f"A preset must contain between {_PRESET_MIN_IDS} "
                    f"and {_PRESET_MAX_IDS} dataset ids."
                ),
            )
        if len(set(dataset_ids)) != len(dataset_ids):
            raise HTTPException(
                status_code=422,
                detail="Duplicate dataset ids are not allowed in a preset.",
            )

    return name, dataset_ids


@app.post("/comparison-presets", dependencies=[Depends(require_developer)])
def create_preset(payload: dict = Body(...)):
    """Save a named dataset selection as a reusable comparison preset."""
    name, dataset_ids = _validate_preset_payload(payload, partial=False)
    try:
        preset = database.create_comparison_preset(name, dataset_ids)
    except database.DatabaseError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    return preset


@app.get("/comparison-presets")
def list_presets():
    """Return all saved comparison presets, newest first."""
    try:
        return {"presets": database.list_comparison_presets()}
    except database.DatabaseError as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@app.get("/comparison-presets/{preset_id}")
def get_preset(preset_id: int):
    """Return one saved comparison preset."""
    try:
        preset = database.get_comparison_preset(preset_id)
    except database.DatabaseError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    if preset is None:
        raise HTTPException(status_code=404, detail=f"Preset {preset_id} not found.")
    return preset


@app.put("/comparison-presets/{preset_id}", dependencies=[Depends(require_developer)])
def update_preset(preset_id: int, payload: dict = Body(...)):
    """Rename a preset and/or replace its dataset selection."""
    name, dataset_ids = _validate_preset_payload(payload, partial=True)
    try:
        preset = database.update_comparison_preset(preset_id, name=name, dataset_ids=dataset_ids)
    except database.DatabaseError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    if preset is None:
        raise HTTPException(status_code=404, detail=f"Preset {preset_id} not found.")
    return preset


@app.delete("/comparison-presets/{preset_id}", dependencies=[Depends(require_developer)])
def delete_preset(preset_id: int):
    """Delete a saved comparison preset."""
    try:
        deleted = database.delete_comparison_preset(preset_id)
    except database.DatabaseError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Preset {preset_id} not found.")
    return {"deleted": True, "id": preset_id}


# ---------------------------------------------------------------------------
# Market-data ingestion (external providers -> MySQL -> QUANT VECTOR)
# ---------------------------------------------------------------------------


def _market_error(exc: Exception):
    """Map data-source errors to meaningful HTTP responses (Phase Q)."""
    if isinstance(exc, InvalidRequest):
        return HTTPException(status_code=400, detail=str(exc))
    if isinstance(exc, InvalidSymbol):
        return HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, DataSourceUnavailable):
        return HTTPException(
            status_code=502,
            detail=f"{exc} The provider may be rate-limiting or offline; "
            "try again shortly.",
        )
    if isinstance(exc, MarketDataError):
        return HTTPException(status_code=502, detail=str(exc))
    return HTTPException(status_code=500, detail=f"Import failed: {exc}")


def _parse_iso_date(value, label):
    try:
        parsed = dt_date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=422, detail=f"'{label}' must be an ISO date (YYYY-MM-DD)."
        )
    return parsed


@app.get("/market/search")
def market_search(
    q: str = Query(..., min_length=1, max_length=60),
    provider: str | None = Query(None),
):
    """Search external instruments by name or symbol."""
    try:
        source = get_provider(provider)
        results = source.search(q)
    except HTTPException:
        raise
    except Exception as exc:
        raise _market_error(exc)
    return {"query": q, "provider": source.name, "results": results}


@app.post("/market/import", dependencies=[Depends(require_developer)])
async def market_import(payload: dict = Body(...), background: BackgroundTasks = BackgroundTasks()):
    """Start a background import of one instrument into MySQL.

    Body: {symbol, start_date, end_date, interval?, provider?,
           name?, exchange?, asset_type?, currency?}
    Returns immediately with {job_id}; poll /market/import/status/{job_id}.
    """
    symbol = str(payload.get("symbol") or "").strip().upper()
    if not symbol or len(symbol) > 24:
        raise HTTPException(status_code=422, detail="'symbol' is required (max 24 chars).")

    start_date = _parse_iso_date(payload.get("start_date"), "start_date")
    end_date = _parse_iso_date(payload.get("end_date"), "end_date")
    if start_date >= end_date:
        raise HTTPException(
            status_code=422, detail="'start_date' must be before 'end_date'."
        )

    interval = str(payload.get("interval") or "1d").lower()
    if interval not in SUPPORTED_INTERVALS:
        raise HTTPException(
            status_code=422,
            detail=f"Unsupported interval '{interval}'. "
            f"Supported: {', '.join(sorted(SUPPORTED_INTERVALS))}.",
        )

    provider_name = str(payload.get("provider") or "yahoo").lower()
    get_provider(provider_name)  # validates the name early

    job = market_ingest.create_import_job(
        {
            "symbol": symbol,
            "start_date": start_date,
            "end_date": end_date,
            "interval": interval,
            "provider": provider_name,
            "name": payload.get("name"),
            "exchange": payload.get("exchange"),
            "asset_type": payload.get("asset_type"),
            "currency": payload.get("currency"),
        }
    )
    background.add_task(
        market_ingest.run_import_job,
        job["job_id"],
        {
            "symbol": symbol,
            "start_date": start_date,
            "end_date": end_date,
            "interval": interval,
            "provider": provider_name,
            "name": payload.get("name"),
            "exchange": payload.get("exchange"),
            "asset_type": payload.get("asset_type"),
            "currency": payload.get("currency"),
        },
    )
    return {"job_id": job["job_id"], "status_url": f"/market/import/status/{job['job_id']}"}


@app.get("/market/import/status/{job_id}")
def market_import_status(job_id: str):
    job = market_ingest.get_import_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Unknown import job '{job_id}'.")
    return job


@app.post("/market/update/{dataset_id}", dependencies=[Depends(require_developer)])
def market_update(dataset_id: int):
    """Incrementally refresh an imported dataset from its provider."""
    if not database.dataset_exists(dataset_id):
        raise HTTPException(status_code=404, detail=f"Dataset {dataset_id} not found.")
    source = database.get_dataset_source(dataset_id)
    if source is None:
        raise HTTPException(
            status_code=400,
            detail=f"Dataset #{dataset_id} was uploaded as CSV and has no "
            "provider to update from.",
        )
    try:
        result = market_ingest.update_imported_dataset(dataset_id)
    except LookupError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise _market_error(exc)
    return result


@app.get("/market/overview")
def market_overview():
    """Lightweight multi-instrument summary computed from stored prices."""
    try:
        universe = market_ingest.list_market_universe()
    except database.DatabaseError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    imported = [row for row in universe if row["source"]]
    return {
        "instruments": universe,
        "imported_count": len(imported),
        "total_count": len(universe),
    }


# ---------------------------------------------------------------------------
# Database inspector (v0.11.0) â€” READ-ONLY views of the real MySQL tables.
# No arbitrary SQL: whitelisted tables, schema-resolved identifiers,
# parameterized values, bounded pagination. This is an inspector, not a
# SQL console; there is intentionally no POST /database/sql endpoint.
# ---------------------------------------------------------------------------


def _db_inspector_error(exc):
    if isinstance(exc, db_inspector.UnknownTable):
        return HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, ValueError):
        return HTTPException(status_code=422, detail=str(exc))
    if isinstance(exc, database.DatabaseError):
        return HTTPException(status_code=503, detail=str(exc))
    return HTTPException(status_code=500, detail=f"Inspector failure: {exc}")


@app.get("/database/status")
def database_status():
    """Cheap connectivity + identity probe (never exposes credentials)."""
    return db_inspector.get_status()


@app.get("/database/stats")
def database_stats():
    """DBMS-level statistics for the overview strip."""
    try:
        stats = db_inspector.get_database_stats()
    except database.DatabaseError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    status = db_inspector.get_status()
    return {**stats, "connected": status["connected"], "database": status["database"]}


@app.get("/database/tables")
def database_tables():
    """All Quant Vector tables with exact row counts and raw/cache category."""
    try:
        tables = db_inspector.list_tables()
    except database.DatabaseError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    return {"tables": tables}


@app.get("/database/tables/{table_name}/schema")
def database_table_schema(table_name: str):
    """Columns, primary key, foreign keys, unique keys and indexes."""
    try:
        return db_inspector.get_table_schema(table_name)
    except database.DatabaseError as exc:
        raise _db_inspector_error(exc)
    except Exception as exc:
        raise _db_inspector_error(exc)


@app.get("/database/tables/{table_name}")
def database_table_rows(
    table_name: str,
    limit: int = Query(default=100, ge=1, le=db_inspector.MAX_PAGE_LIMIT),
    offset: int = Query(default=0, ge=0),
    dataset_id: int | None = Query(default=None, ge=1),
    date_from: str | None = None,
    date_to: str | None = None,
    provider: str | None = None,
    symbol: str | None = None,
    filename: str | None = None,
    metric_name: str | None = None,
    order_by: str | None = None,
    order_dir: str = Query(default="asc", pattern="^(?i)(asc|desc)$"),
):
    """A bounded page of REAL stored rows from a whitelisted table."""
    filters = {}
    if dataset_id is not None:
        filters["dataset_id"] = dataset_id
    for name in ("date_from", "date_to"):
        value = locals()[name]
        if value:
            try:
                dt_date.fromisoformat(value)
            except ValueError as exc:
                raise HTTPException(
                    status_code=422, detail=f"{name} must be YYYY-MM-DD."
                ) from exc
            filters[name] = value
    for name in ("provider", "symbol", "filename", "metric_name"):
        value = locals()[name]
        if value:
            filters[name] = value

    try:
        return db_inspector.get_table_rows(
            table_name,
            limit=limit,
            offset=offset,
            filters=filters,
            order_by=order_by,
            order_dir=order_dir,
        )
    except Exception as exc:
        raise _db_inspector_error(exc)


@app.get("/database/datasets/{dataset_id}/storage")
def database_dataset_storage(dataset_id: int):
    """Per-dataset storage breakdown across raw tables and derived caches."""
    try:
        return db_inspector.get_dataset_storage(dataset_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise _db_inspector_error(exc)


@app.post("/database/integrity", dependencies=[Depends(require_developer)])
def database_integrity():
    """Read-only integrity verification (never repairs or deletes data)."""
    try:
        return db_inspector.run_integrity_check()
    except database.DatabaseError as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@app.post("/database/query", dependencies=[Depends(require_developer)])
def database_raw_query(payload: dict = Body(...)):
    """Developer SQL console: one validated read-only statement per call.

    Body: {"sql": "SELECT ..."}
    Returns Workbench-style output: {columns, rows, row_count, truncated,
    elapsed_ms}. Mutating statements are rejected (422) and the session is
    READ ONLY server-side regardless.
    """
    sql = payload.get("sql") if isinstance(payload, dict) else None
    if not isinstance(sql, str):
        raise HTTPException(status_code=422, detail="'sql' must be a string.")
    try:
        return db_inspector.run_raw_query(sql)
    except db_inspector.QueryRejected as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except db_inspector.QueryExecutionError as exc:
        prefix = f"MySQL error {exc.errno}: " if exc.errno else "MySQL error: "
        raise HTTPException(status_code=422, detail=prefix + str(exc))
    except database.DatabaseError as exc:
        raise HTTPException(status_code=503, detail=str(exc))


# ---------------------------------------------------------------------------
# AI layer (provider-agnostic reasoning over Quant Vector tool context)
# ---------------------------------------------------------------------------


@app.get("/ai/status")
def ai_status():
    """Report whether an AI provider is configured (no key material returned)."""
    return ai_engine.ai_status()


@app.post("/ai/query")
def ai_query(payload: dict = Body(...)):
    """Answer a natural-language question using Quant Vector's own engines.

    Body: {"question": str, "dataset_id": int}
    When no provider is configured the response is HTTP 200 with
    {"available": false, "reason": ..., "context": ...} so the UI can show its
    offline state while still rendering the grounding context from the
    Quant Vector engines.
    """
    question = payload.get("question")
    dataset_id = payload.get("dataset_id")
    if not isinstance(question, str) or not question.strip():
        raise HTTPException(status_code=422, detail="'question' must be a non-empty string.")
    if len(question) > 2000:
        raise HTTPException(status_code=422, detail="Question too long (max 2000 chars).")
    if not isinstance(dataset_id, int):
        raise HTTPException(status_code=422, detail="'dataset_id' must be an integer.")

    try:
        return ai_engine.answer_market_question(question.strip(), dataset_id)
    except ai_engine.AIEngineError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except database.DatabaseError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
