"""QUANT VECTOR AI layer.

Architecture (see docs/architecture.md):

    user question
        -> AI QUERY LAYER (this module)
        -> QUANT VECTOR TOOL/API LAYER (structured context builders below)
        -> dataset / fingerprint / analogues / regimes / intelligence engines
        -> STRUCTURED CONTEXT (JSON)
        -> LLM (OpenAI-compatible chat completions)
        -> ANSWER (+ list of internal sources used)

The AI never invents financial analysis: every number it may quote is placed
into the context by the tool layer, which reads exclusively from the existing
Quant Vector engines and their MySQL caches.

Provider configuration comes from environment variables and is resolved at
request time, so adding a key never requires a code change or restart:

    AI_PROVIDER   openai | groq | gemini | ollama | custom   (optional)
    AI_API_KEY    API key (never committed)
    AI_MODEL      model name, e.g. gpt-4o-mini / llama-3.3-70b-versatile
    AI_BASE_URL   override the default OpenAI-compatible base URL

If nothing is configured the layer reports OFFLINE and the rest of Quant Vector
is completely unaffected.
"""

import os
from datetime import datetime, timezone

import httpx

import database
import fingerprint
import intelligence
import regimes

REQUEST_TIMEOUT_SECONDS = 75

DEFAULT_BASE_URLS = {
    "openai": "https://api.openai.com/v1",
    "groq": "https://api.groq.com/openai/v1",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
    "ollama": "http://localhost:11434/v1",
}

INTELLIGENCE_DEFAULTS = {"lookback": 60, "top_n": 8, "window_size": 60, "k": None}

SYSTEM_PROMPT = """You are VECTOR, the built-in intelligence of the QUANT VECTOR \
quantitative research terminal. You explain markets strictly using the JSON CONTEXT \
provided by the Quant Vector tool layer.

IDENTITY RULES (absolute):
- You are Vector, part of Quant Vector. You have no other name.
- NEVER mention, hint at, or confirm any underlying model, model family, vendor or \
provider (no model names, no company names, no hardware/infrastructure details). If \
asked what you run on or who made you, answer only: "I'm Vector, the analysis \
intelligence built into Quant Vector." Never speculate beyond that line.
- Never display, repeat or reference any API key, token or configuration value.

ANALYSIS RULES:
1. Use ONLY numbers present in the context. Never invent or estimate values.
2. Cite your sources inline like [fingerprint], [analogues], [regimes], [intelligence], \
[dataset].
3. Frame everything as historical/statistical description. Never give advice, never say \
buy/sell, never promise returns. Use phrases like "historical evidence", "statistical \
tendency", "observed analogue outcomes".
4. If the context marks something unavailable, say it is unavailable instead of guessing.

VISUAL OUTPUT RULES:
5. When the data supports it, include ONE OR TWO charts using this exact fenced block \
format (valid JSON on a single logical block):

```chart
{"type": "bar", "title": "Analogue forward returns", "x_label": "Analogue period", \
"y_label": "% return", "x": ["2023-01 .. 2023-04", "..."], "series": [{"name": \
"20d forward %", "data": [2.1, -0.4]}]}
```

   - allowed types: "bar", "line", "area"
   - every x/series value MUST come from the context verbatim (round floats to 2 \
decimals); never fabricate points
   - good candidates: analogue 20-day forward returns (bar), regime median returns \
(bar), monthly closes from price_series (line)
6. For tabular comparisons use GitHub-flavoured markdown pipe tables with a header row \
and alignment row, e.g.:

| Regime | Windows | Median 20d |
| --- | --- | --- |
| Bull | 12 | +3.1% |

7. Keep prose tight; prefer tables/charts over long paragraphs when comparing items.

STRUCTURE: answer using these exact section headers when relevant:

CURRENT INTERPRETATION
<2-4 sentences>

EVIDENCE
<trend / analogue / regime / risk readings from the intelligence scorecard>

HISTORICAL CONTEXT
<analogue counts, median forward outcomes, dispersion, regime frequencies>

RISKS & CAVEATS
<drawdowns, volatility state, contradictions>

IMPORTANT
Historical similarity does not imply identical future behaviour. Not financial advice.
"""


# ---------------------------------------------------------------------------
# Provider configuration
# ---------------------------------------------------------------------------

def get_provider_config():
    provider = (os.getenv("AI_PROVIDER") or "").strip().lower()
    api_key = (os.getenv("AI_API_KEY") or "").strip()
    model = (os.getenv("AI_MODEL") or "").strip()
    base_url = (os.getenv("AI_BASE_URL") or "").strip()

    if not provider:
        return {"configured": False, "provider": None, "reason": "AI_PROVIDER is not set"}

    effective_base = base_url or DEFAULT_BASE_URLS.get(provider)
    if not effective_base:
        return {
            "configured": False,
            "provider": provider,
            "reason": f"Unknown provider '{provider}' and no AI_BASE_URL given",
        }

    # Ollama's local server needs no key; hosted providers do.
    needs_key = provider != "ollama" and not api_key
    if needs_key:
        return {
            "configured": False,
            "provider": provider,
            "reason": "AI_API_KEY is not set",
        }
    if not model:
        return {
            "configured": False,
            "provider": provider,
            "reason": "AI_MODEL is not set",
        }

    return {
        "configured": True,
        "provider": provider,
        "model": model,
        "base_url": effective_base.rstrip("/"),
        "api_key": api_key,
        "has_key": bool(api_key),
    }


def ai_status():
    """Engine status for the frontend — vendor/model details are masked."""
    cfg = get_provider_config()
    return {
        "available": cfg.get("configured", False),
        "engine": "Vector",
        "reason": cfg.get("reason"),
    }


# ---------------------------------------------------------------------------
# Tool layer: structured context builders (all reuse existing engines/caches)
# ---------------------------------------------------------------------------

def _tool_dataset_summary(dataset_id):
    dataset = database.get_dataset(dataset_id)
    if not dataset:
        return None
    # Safe provenance only: provider/symbol/storage facts. Never credentials.
    provenance = {}
    try:
        source = database.get_dataset_source(dataset_id)
        if source:
            provenance = {
                "provider": source.get("provider"),
                "symbol": source.get("symbol"),
                "stored_in_mysql": True,
                "last_updated": str(source.get("last_updated")),
            }
        else:
            provenance = {"origin": "csv upload", "stored_in_mysql": True}
    except database.DatabaseError:
        pass
    return {
        "source": "dataset",
        "id": dataset["id"],
        "filename": dataset["filename"],
        "start_date": str(dataset["start_date"]),
        "end_date": str(dataset["end_date"]),
        "row_count": dataset["row_count"],
        "latest_close": float(dataset["latest_close"]),
        "provenance": provenance,
        "summary_metrics": {
            key: value
            for key, value in (dataset.get("metrics") or {}).items()
            if isinstance(value, (int, float))
        },
    }


def _tool_fingerprint(dataset_id):
    stored = database.get_stored_fingerprint(dataset_id)
    metrics = stored if isinstance(stored, dict) else None
    if not metrics:
        return {"source": "fingerprint", "available": False}
    numeric = {
        key: round(float(value), 6)
        for key, value in metrics.items()
        if isinstance(value, (int, float))
    }
    return {"source": "fingerprint", "available": True, "metrics": numeric}


def _frame(dataset_id):
    """Canonical OHLCV frame identical to main._fetch_dataset_frame's output."""
    rows = database.get_prices(dataset_id)
    if not rows:
        return None
    return fingerprint.dataframe_from_price_records(rows)


def _tool_regimes(dataset_id):
    try:
        model = database.get_stored_regime_model(dataset_id)
    except database.DatabaseError:
        model = None
    if not model:
        return {"source": "regimes", "available": False}
    summary = model.get("model_json") or {}
    current = (summary.get("current_regime") or {}).get("current_regime") or {}
    profiles = []
    for profile in summary.get("regimes") or []:
        fwd = profile.get("forward_outcomes") or {}
        profiles.append(
            {
                "regime_id": profile.get("regime_id"),
                "label": profile.get("label"),
                "window_count": profile.get("window_count"),
                "volatility": profile.get("volatility"),
                "max_drawdown": profile.get("max_drawdown"),
                "median_return_after_20_days": fwd.get("median_return_after_20_days"),
                "probability_positive_after_20_days": fwd.get(
                    "probability_positive_after_20_days"
                ),
            }
        )
    transitions = summary.get("transitions") or {}
    return {
        "source": "regimes",
        "available": True,
        "selected_k": (summary.get("model") or {}).get("selected_k")
        or model.get("selected_k"),
        "current_regime": {
            "regime_id": current.get("regime_id"),
            "label": current.get("label"),
            "confidence": current.get("confidence"),
        },
        "profiles": profiles[:6],
        "transition_labels": transitions.get("labels"),
        "transition_probabilities": transitions.get("probabilities"),
        "note": transitions.get("note"),
    }


def _tool_analogues(dataset_id):
    stored = database.get_stored_analogues(dataset_id)
    matches = stored if isinstance(stored, list) else (stored or {}).get("matches")
    if not matches:
        return {"source": "analogues", "available": False}
    out = []
    for match in matches[:8]:
        details = match.get("details") or {}
        fwd = details.get("subsequent_market_action") or {}
        out.append(
            {
                "rank": match.get("match_rank"),
                "period": f"{match.get('start_date')} .. {match.get('end_date')}",
                "similarity": match.get("similarity"),
                "volatility": (details.get("characteristics") or {}).get(
                    "annualized_volatility"
                ),
                "return_after_5_days": fwd.get("return_after_5_days"),
                "return_after_10_days": fwd.get("return_after_10_days"),
                "return_after_20_days": fwd.get("return_after_20_days"),
                "note": fwd.get("note"),
            }
        )
    return {"source": "analogues", "available": True, "matches": out}


def _tool_intelligence(dataset_id):
    params = dict(INTELLIGENCE_DEFAULTS)
    param_hash = database.intelligence_param_hash(params)
    try:
        cached = database.get_cached_intelligence(dataset_id, param_hash)
    except database.DatabaseError:
        cached = None
    payload = cached["intelligence"] if cached else None
    if payload is None:
        frame = _frame(dataset_id)
        if frame is None:
            return {"source": "intelligence", "available": False}
        clean_params = {k: v for k, v in params.items() if v is not None}
        try:
            payload = intelligence.build_market_intelligence(frame, **clean_params)
        except Exception:
            return {"source": "intelligence", "available": False}

    evidence = payload.get("evidence") or {}
    scorecard = payload.get("scorecard") or {}
    consensus = payload.get("analogue_consensus") or {}
    quality = (evidence.get("quality_factors") or {})
    return {
        "source": "intelligence",
        "available": True,
        "directional_bias": scorecard.get("directional_bias"),
        "bias_score": evidence.get("bias_score"),
        "trend_score": evidence.get("trend_score"),
        "analogue_score": evidence.get("analogue_score"),
        "regime_score": evidence.get("regime_score"),
        "risk_score": evidence.get("risk_score"),
        "risk_index": evidence.get("risk_index"),
        "risk_level": scorecard.get("risk_level"),
        "trend_state": scorecard.get("trend_state"),
        "momentum_state": scorecard.get("momentum_state"),
        "volatility_state": scorecard.get("volatility_state"),
        "confidence": scorecard.get("confidence"),
        "agreement_score": evidence.get("agreement_score"),
        "weights_used": evidence.get("weights_used"),
        "quality_factors": quality,
        "contradictions": [
            {"type": c.get("type"), "severity": c.get("severity"), "description": c.get("description")}
            for c in (payload.get("contradictions") or [])
        ],
        "analogue_consensus": {
            "valid_analogues": consensus.get("valid_analogues"),
            "median_5d_forward_return": consensus.get("median_5d_forward_return"),
            "median_10d_forward_return": consensus.get("median_10d_forward_return"),
            "median_20d_forward_return": consensus.get("median_20d_forward_return"),
            "positive_20d_frequency": consensus.get("positive_20d_frequency"),
            "std_dev_20d_forward_return": consensus.get("std_dev_20d_forward_return"),
        },
        "narrative_summary": (
            payload.get("summary").get("summary")
            if isinstance(payload.get("summary"), dict)
            else payload.get("summary")
        ),
    }


def _tool_market_universe():
    """Compact multi-instrument context (Phase P).

    Reuses the lightweight overview computation: stored prices only, no
    heavy discovery. Lets the assistant answer questions like "which of my
    imported instruments has the highest momentum?" without inventing data.
    """
    try:
        import market_ingest

        universe = market_ingest.list_market_universe()
    except Exception:
        return {"source": "market_universe", "available": False}

    if not universe:
        return {"source": "market_universe", "available": False}

    def compact(row):
        source = row.get("source") or {}
        return {
            "dataset_id": row["dataset_id"],
            "symbol": source.get("symbol") or row["filename"],
            "name": source.get("instrument_name"),
            "provider": source.get("provider"),
            "last_date": row["end_date"],
            "latest_close": row["latest_close"],
            "return_1d": row["return_1d"],
            "return_5d": row["return_5d"],
            "return_20d": row["return_20d"],
            "volatility_20d_annualized": row["volatility_20d_annualized"],
            "drawdown": row["drawdown"],
            "momentum_60d": row["momentum_60d"],
            "regime_label": row["regime_label"],
        }

    return {
        "source": "market_universe",
        "available": True,
        "instrument_count": len(universe),
        "instruments": [compact(row) for row in universe],
    }


def _tool_price_series(dataset_id, max_points=14):
    """Monthly closes — compact chartable series for VECTOR's visuals.

    Deliberately tiny (<= max_points) to keep prompt size bounded while
    giving the model real price action it may plot verbatim.
    """
    try:
        frame = _frame(dataset_id)
        if frame is None or frame.empty:
            return {"source": "price_series", "available": False}
        monthly = (
            frame.set_index("Date")["Close"]
            .resample("ME")
            .last()
            .dropna()
            .tail(max_points)
        )
        dates = [idx.strftime("%Y-%m") for idx in monthly.index]
        closes = [round(float(v), 2) for v in monthly.to_numpy()]
        if not dates:
            return {"source": "price_series", "available": False}
        return {
            "source": "price_series",
            "available": True,
            "frequency": "monthly close",
            "dates": dates,
            "closes": closes,
        }
    except Exception:
        return {"source": "price_series", "available": False}


def build_market_context(dataset_id):
    """Assemble the full structured tool context for one dataset."""
    context = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "dataset": _tool_dataset_summary(dataset_id),
        "fingerprint": _tool_fingerprint(dataset_id),
        "regimes": _tool_regimes(dataset_id),
        "analogues": _tool_analogues(dataset_id),
        "intelligence": _tool_intelligence(dataset_id),
        "price_series": _tool_price_series(dataset_id),
        "market_universe": _tool_market_universe(),
        "instructions": (
            "Every field above was produced by the corresponding Quant Vector engine. "
            "Cite sources by name. Treat missing/available=false fields as unavailable."
        ),
    }
    used_tools = [
        name
        for name in ("dataset", "fingerprint", "regimes", "analogues", "intelligence")
        if context.get(name)
    ]
    if (context.get("market_universe") or {}).get("available"):
        used_tools.append("market_universe")
    if (context.get("price_series") or {}).get("available"):
        used_tools.append("price_series")
    return context, used_tools


# ---------------------------------------------------------------------------
# LLM call (OpenAI-compatible chat completions)
# ---------------------------------------------------------------------------

class AIEngineError(Exception):
    pass


def _call_llm(cfg, question, context_json):
    url = f"{cfg['base_url']}/chat/completions"
    headers = {"Content-Type": "application/json"}
    if cfg.get("has_key"):
        headers["Authorization"] = f"Bearer {cfg['api_key']}"
    body = {
        "model": cfg["model"],
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    f"QUESTION:\n{question}\n\n"
                    f"CONTEXT (Quant Vector tool layer JSON):\n{context_json}"
                ),
            },
        ],
    }
    try:
        response = httpx.post(url, json=body, headers=headers, timeout=REQUEST_TIMEOUT_SECONDS)
    except httpx.HTTPError:
        # Sanitized on purpose: transport errors can embed the provider host
        # or model id. Full detail stays in the server log only.
        print("[ai_engine] provider request failed:", url.rsplit("/", 1)[0])
        raise AIEngineError("The analysis engine could not reach its reasoning service.") from None
    if response.status_code >= 400:
        detail = response.text[:300]
        print(f"[ai_engine] provider HTTP {response.status_code}: {detail}")
        raise AIEngineError(
            f"The analysis engine rejected the request (HTTP {response.status_code})."
        ) from None
    data = response.json()
    try:
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise AIEngineError("AI provider returned an unexpected response shape.") from exc


def answer_market_question(question, dataset_id):
    cfg = get_provider_config()
    context, used_tools = build_market_context(dataset_id)

    if not cfg.get("configured"):
        return {
            "available": False,
            "reason": cfg.get("reason", "No AI provider configured."),
            "context": context,
            "tools_used": used_tools,
        }

    import json as _json

    context_json = _json.dumps(context, default=str)
    answer = _call_llm(cfg, question, context_json)
    return {
        "available": True,
        "engine": "Vector",
        "answer": answer,
        "context": context,
        "tools_used": used_tools,
    }
