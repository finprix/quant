"""Web-first market layer (v0.20.0 FINPRIX).

Public, symbol-first market intelligence built on top of the existing
provider abstraction. The database stays a cache/persistence layer —
nothing here requires a pre-existing dataset:

  * GLOBAL / SECTOR / FX / COMMODITY / CRYPTO boards — one batched
    provider call, cached briefly in-process, every row clickable.
  * ensure_symbol_dataset() — resolves any public symbol into a cached,
    analysis-ready dataset behind the scenes (reuse -> incremental
    update -> fresh import), so users never manage datasets manually.
  * news feed aggregation across categories using the existing
    pass-through headline provider (never fabricated).

All figures come from the provider; unavailable fields stay null.
"""

import time as _time

# ---------------------------------------------------------------------------
# Curated universe (representative, publicly traded instruments)
# ---------------------------------------------------------------------------

INDEX_BOARD = [
    {"symbol": "^GSPC", "label": "S&P 500", "region": "US"},
    {"symbol": "^IXIC", "label": "NASDAQ", "region": "US"},
    {"symbol": "^DJI", "label": "DOW JONES", "region": "US"},
    {"symbol": "^RUT", "label": "RUSSELL 2000", "region": "US"},
    {"symbol": "^VIX", "label": "VIX", "region": "US"},
    {"symbol": "^NSEI", "label": "NIFTY 50", "region": "INDIA"},
    {"symbol": "^BSESN", "label": "SENSEX", "region": "INDIA"},
    {"symbol": "^NSEBANK", "label": "BANK NIFTY", "region": "INDIA"},
    {"symbol": "^FTSE", "label": "FTSE 100", "region": "EUROPE"},
    {"symbol": "^GDAXI", "label": "DAX", "region": "EUROPE"},
    {"symbol": "^FCHI", "label": "CAC 40", "region": "EUROPE"},
    {"symbol": "^N225", "label": "NIKKEI 225", "region": "ASIA"},
    {"symbol": "^HSI", "label": "HANG SENG", "region": "ASIA"},
    {"symbol": "000001.SS", "label": "SHANGHAI COMP", "region": "ASIA"},
]

COMMODITY_BOARD = [
    {"symbol": "GC=F", "label": "GOLD", "region": "GLOBAL"},
    {"symbol": "SI=F", "label": "SILVER", "region": "GLOBAL"},
    {"symbol": "CL=F", "label": "WTI CRUDE", "region": "GLOBAL"},
    {"symbol": "BZ=F", "label": "BRENT", "region": "GLOBAL"},
    {"symbol": "NG=F", "label": "NATURAL GAS", "region": "GLOBAL"},
    {"symbol": "HG=F", "label": "COPPER", "region": "GLOBAL"},
]

FX_BOARD = [
    {"symbol": "DX-Y.NYB", "label": "DOLLAR INDEX", "region": "GLOBAL"},
    {"symbol": "EURUSD=X", "label": "EUR/USD", "region": "GLOBAL"},
    {"symbol": "GBPUSD=X", "label": "GBP/USD", "region": "GLOBAL"},
    {"symbol": "USDJPY=X", "label": "USD/JPY", "region": "GLOBAL"},
    {"symbol": "USDINR=X", "label": "USD/INR", "region": "GLOBAL"},
]

CRYPTO_BOARD = [
    {"symbol": "BTC-USD", "label": "BITCOIN", "region": "GLOBAL"},
    {"symbol": "ETH-USD", "label": "ETHEREUM", "region": "GLOBAL"},
    {"symbol": "SOL-USD", "label": "SOLANA", "region": "GLOBAL"},
]

SECTOR_BOARD = [
    {"symbol": "XLK", "label": "TECHNOLOGY"},
    {"symbol": "XLF", "label": "FINANCIALS"},
    {"symbol": "XLE", "label": "ENERGY"},
    {"symbol": "XLV", "label": "HEALTHCARE"},
    {"symbol": "XLI", "label": "INDUSTRIALS"},
    {"symbol": "XLY", "label": "CONS. DISCRETIONARY"},
    {"symbol": "XLP", "label": "CONS. STAPLES"},
    {"symbol": "XLU", "label": "UTILITIES"},
    {"symbol": "XLB", "label": "MATERIALS"},
    {"symbol": "XLRE", "label": "REAL ESTATE"},
    {"symbol": "XLC", "label": "COMM. SERVICES"},
]

EQUITY_MOVERS_US = [
    "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "BRK-B",
    "JPM", "V", "UNH", "XOM", "WMT", "MA", "HD", "KO", "PEP", "NFLX",
    "AMD", "INTC", "QCOM", "CRM", "ORCL", "ADBE", "CSCO", "DIS",
    "BAC", "WFC", "UBER", "ABNB",
]

EQUITY_MOVERS_IN = [
    "RELIANCE.NS", "TCS.NS", "HDFCBANK.NS", "INFY.NS", "ICICIBANK.NS",
    "ITC.NS", "LT.NS", "SBIN.NS", "BHARTIARTL.NS", "HINDUNILVR.NS",
]

NEWS_CATEGORY_SOURCES = {
    "latest": ["AAPL", "MSFT", "NVDA", "SPY", "BTC-USD"],
    "equities": ["AAPL", "MSFT", "NVDA", "AMZN", "TSLA"],
    "macro": ["SPY", "TLT", "GLD", "DX-Y.NYB"],
    "crypto": ["BTC-USD", "ETH-USD", "SOL-USD"],
    "commodities": ["GC=F", "CL=F", "SI=F"],
    "india": ["RELIANCE.NS", "TCS.NS", "HDFCBANK.NS"],
}

BOARD_TTL_SECONDS = 60
SECTOR_TTL_SECONDS = 1800
NEWS_TTL_SECONDS = 120

_CACHE = {}


def _cache_get(key, ttl):
    entry = _CACHE.get(key)
    if entry and _time.time() - entry["ts"] < ttl:
        return entry["value"]
    return None


def _cache_set(key, value):
    _CACHE[key] = {"ts": _time.time(), "value": value}
    return value


# ---------------------------------------------------------------------------
# Batched quotes (one provider round trip for an entire board)
# ---------------------------------------------------------------------------

def _fetch_batch(symbols, period="5d"):
    """Download recent daily bars for many symbols in one request.

    Returns {symbol: pandas.DataFrame}. Symbols with no data are absent.
    """
    import yfinance as yf

    clean = [str(s).strip() for s in symbols if str(s).strip()]
    if not clean:
        return {}
    frame = yf.download(
        tickers=clean,
        period=period,
        interval="1d",
        group_by="ticker",
        auto_adjust=False,
        progress=False,
        threads=True,
    )
    out = {}
    if frame is None or len(frame) == 0:
        return out
    if len(clean) == 1:
        out[clean[0]] = frame.dropna(how="all")
        return out
    for symbol in clean:
        try:
            sub = frame[symbol]
        except KeyError:
            continue
        if sub is not None and len(sub.dropna(how="all")) > 0:
            out[symbol] = sub.dropna(how="all")
    return out


def _quote_from_bars(symbol, bars, meta):
    """Derive a quote dict from recent daily bars (no invention)."""
    if bars is None or len(bars) == 0:
        return {**meta, "symbol": symbol, "quote": None, "error": "no data"}
    last = bars.iloc[-1]
    price = float(last["Close"]) if last.get("Close") is not None else None
    prev = float(bars.iloc[-2]["Close"]) if len(bars) >= 2 else None
    change = price - prev if (price is not None and prev) else None
    pct = (change / prev * 100) if (change is not None and prev) else None
    volume = int(last["Volume"]) if last.get("Volume") is not None else None
    as_of = str(bars.index[-1])[:10]
    return {
        **meta,
        "symbol": symbol,
        "quote": {
            "price": round(price, 4) if price is not None else None,
            "previous_close": round(prev, 4) if prev is not None else None,
            "change": round(change, 4) if change is not None else None,
            "change_percent": round(pct, 2) if pct is not None else None,
            "volume": volume,
            "as_of": as_of,
        },
        "error": None,
    }


def get_board():
    """Full global board: indices, commodities, FX, crypto (cached 60 s)."""
    cached = _cache_get("board", BOARD_TTL_SECONDS)
    if cached is not None:
        return cached

    metas = (
        [{"**meta": True, "group": "index", **m} for m in INDEX_BOARD]
        + [{"group": "commodity", **m} for m in COMMODITY_BOARD]
        + [{"group": "fx", **m} for m in FX_BOARD]
        + [{"group": "crypto", **m} for m in CRYPTO_BOARD]
    )
    symbols = [m["symbol"] for m in metas]
    try:
        bars_by_symbol = _fetch_batch(symbols)
    except Exception as exc:
        raise RuntimeError(f"Market data temporarily unavailable: {exc}") from exc

    rows = [
        _quote_from_bars(m["symbol"], bars_by_symbol.get(m["symbol"]), m)
        for m in metas
    ]
    payload = {
        "quotes": rows,
        "as_of": _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime()),
    }
    return _cache_set("board", payload)


def get_movers():
    """Top gainers / losers / most active across curated equity + crypto lists."""
    cached = _cache_get("movers", BOARD_TTL_SECONDS)
    if cached is not None:
        return cached

    universe = (
        [{"symbol": s, "label": s.split(".")[0].replace("-", "."), "group": "us", "region": "US"}
         for s in EQUITY_MOVERS_US]
        + [{"symbol": s, "label": s.replace(".NS", ""), "group": "india", "region": "INDIA"}
           for s in EQUITY_MOVERS_IN]
        + [{"symbol": s, "label": s.replace("-USD", ""), "group": "crypto", "region": "GLOBAL"}
           for s in ("BTC-USD", "ETH-USD", "SOL-USD")]
    )
    try:
        bars_by_symbol = _fetch_batch([u["symbol"] for u in universe])
    except Exception as exc:
        raise RuntimeError(f"Market data temporarily unavailable: {exc}") from exc

    rows = []
    for meta in universe:
        row = _quote_from_bars(meta["symbol"], bars_by_symbol.get(meta["symbol"]), meta)
        # Names are enriched lazily by the asset page; movers show tickers.
        rows.append(row)

    priced = [
        r for r in rows
        if r["quote"] and r["quote"].get("change_percent") is not None
    ]
    ranked = sorted(priced, key=lambda r: r["quote"]["change_percent"], reverse=True)
    active = sorted(
        (r for r in priced if r["quote"].get("volume")),
        key=lambda r: r["quote"]["volume"],
        reverse=True,
    )
    payload = {
        "gainers": ranked[:8],
        "losers": list(reversed(ranked[-8:])) if len(ranked) > 8 else [],
        "active": active[:8],
        "as_of": _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime()),
    }
    return _cache_set("movers", payload)


def get_sector_performance():
    """Sector ETF returns over 1D / 5D / 1M (cached 30 min)."""
    cached = _cache_get("sectors", SECTOR_TTL_SECONDS)
    if cached is not None:
        return cached

    try:
        bars_by_symbol = _fetch_batch(
            [s["symbol"] for s in SECTOR_BOARD], period="3mo"
        )
    except Exception as exc:
        raise RuntimeError(f"Market data temporarily unavailable: {exc}") from exc

    rows = []
    for meta in SECTOR_BOARD:
        bars = bars_by_symbol.get(meta["symbol"])
        entry = {**meta, "ret_1d": None, "ret_5d": None, "ret_1m": None}
        if bars is not None and len(bars) >= 2:
            closes = bars["Close"].astype(float)
            last = float(closes.iloc[-1])

            def _ret(offset):
                if len(closes) <= offset:
                    return None
                base = float(closes.iloc[-1 - offset])
                return round((last / base - 1.0) * 100, 2) if base else None

            entry["ret_1d"] = _ret(1)
            entry["ret_5d"] = _ret(5)
            entry["ret_1m"] = _ret(21)
        rows.append(entry)

    payload = {"sectors": rows}
    return _cache_set("sectors", payload)


def _parse_published(item):
    value = item.get("published")
    if not value:
        return ""
    return str(value)


def get_news_feed(category="latest", extra_symbols=None, limit=24):
    """Aggregate real provider headlines across representative sources.

    Titles/links/publishers pass through verbatim; each item carries the
    symbol whose feed produced it. Nothing is generated or summarised.
    """
    symbols = list(NEWS_CATEGORY_SOURCES.get(str(category).lower(),
                                            NEWS_CATEGORY_SOURCES["latest"]))
    for extra in extra_symbols or []:
        up = str(extra).upper().strip()
        if up and up not in symbols:
            symbols.append(up)

    cache_key = ("news", category.upper(), tuple(sorted(s.upper() for s in symbols)))
    cached = _cache_get(cache_key, NEWS_TTL_SECONDS)
    if cached is not None:
        return cached

    import market_ingest

    items, failures = [], 0
    for symbol in symbols:
        try:
            feed = market_ingest.get_symbol_news(symbol, limit=10)
        except Exception:
            failures += 1
            continue
        for entry in feed:
            items.append({**entry, "related_symbol": symbol})
    items.sort(key=_parse_published, reverse=True)

    counts = {}
    for item in items:
        sym = item["related_symbol"]
        counts[sym] = counts.get(sym, 0) + 1
    trending = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[:8]

    payload = {
        "category": str(category).lower(),
        "items": items[:limit],
        "trending": [
            {"symbol": sym, "stories": n} for sym, n in trending
        ],
        "sources_failed": failures,
        "as_of": _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime()),
    }
    return _cache_set(cache_key, payload)


# ---------------------------------------------------------------------------
# Symbol-first bootstrap: public symbol -> cached analysis-ready dataset
# ---------------------------------------------------------------------------

_DEFAULT_LOOKBACK_DAYS = 730
_STALE_DAYS = 4


def resolve_instrument(symbol):
    """Provider search metadata for one symbol (best effort)."""
    from data_sources import get_provider

    provider = get_provider("yahoo")
    query = str(symbol).strip()
    try:
        results = provider.search(query)
    except Exception:
        return None
    upper = query.upper()
    for row in results:
        if str(row.get("symbol", "")).upper() == upper:
            return row
    return results[0] if results else None


def ensure_symbol_dataset(symbol, lookback_days=_DEFAULT_LOOKBACK_DAYS):
    """Guarantee a reasonably fresh cached dataset for a public symbol.

    Reuses the previously imported dataset for the same symbol when it
    exists (incremental update when stale), otherwise imports a fresh
    multi-year history. Returns the dataset id plus instrument metadata.
    Raises InvalidSymbol / DataSourceUnavailable / RuntimeError on failure.
    """
    import market_ingest
    import database
    from datetime import date, timedelta

    key = str(symbol).upper().strip()
    today = date.today()
    start = today - timedelta(days=int(lookback_days))

    meta = resolve_instrument(key) or {}
    existing = market_ingest.find_existing_import("yahoo", key)

    if existing is not None:
        dataset_id = existing["dataset_id"]
        last_date = database.get_last_price_date(dataset_id)
        status = "current"
        if last_date is None or (today - last_date).days >= _STALE_DAYS:
            result = market_ingest.update_imported_dataset(
                dataset_id, fetch_start=start, fetch_end=today
            )
            status = result.get("status", "updated")
    else:
        result = market_ingest.import_instrument(
            "yahoo",
            key,
            start.isoformat(),
            today.isoformat(),
            interval="1d",
            metadata={
                "name": meta.get("name"),
                "exchange": meta.get("exchange"),
                "asset_type": meta.get("asset_type"),
                "currency": meta.get("currency"),
            },
        )
        dataset_id = result["dataset_id"]
        status = result.get("status", "complete")

    dataset = database.get_dataset(dataset_id)
    source = database.get_dataset_source(dataset_id)
    return {
        "dataset_id": dataset_id,
        "status": status,
        "instrument": {
            "symbol": key,
            "name": (source or {}).get("instrument_name") or meta.get("name"),
            "exchange": (source or {}).get("exchange") or meta.get("exchange"),
            "asset_type": (source or {}).get("asset_type") or meta.get("asset_type"),
            "currency": (source or {}).get("currency") or meta.get("currency"),
        },
        "coverage": {
            "start_date": dataset.get("start_date") if dataset else None,
            "end_date": dataset.get("end_date") if dataset else None,
            "row_count": dataset.get("row_count") if dataset else None,
        },
    }
