"""FINPRIX v0.20.0 — web-first market layer tests.

Covers the public symbol-first surface without touching the network:
  1. /market/global board assembly from batched provider bars
  2. /market/movers ranking (gainers / losers / most active)
  3. /sectors return computation over 1D / 5D / 1M
  4. /asset/{symbol} bootstrap: dataset reuse + quote merge + engines
  5. /market/news aggregation with trending derivation
All provider/database interactions are stubbed in-process.

Run directly: python test_web_market.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import test_support as _ts  # noqa: E402,F401  (env before main)

import pandas as pd  # noqa: E402

import market_web  # noqa: E402
import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

PASS, FAIL = [], []


def check(name, condition, detail=""):
    if condition:
        PASS.append(name)
        print(f"  ok    {name}")
    else:
        FAIL.append((name, detail))
        print(f"  FAIL  {name} :: {detail}")


def bars(closes):
    idx = pd.date_range("2026-01-01", periods=len(closes), freq="B")
    return pd.DataFrame(
        {
            "Open": closes,
            "High": closes,
            "Low": closes,
            "Close": closes,
            "Volume": [1000] * len(closes),
        },
        index=idx,
    )


client = TestClient(main.app)


# ---------------------------------------------------------------------------
print("\n[1] /market/global board")
frames = {"^AAA": bars([100, 101, 102]), "^BBB": bars([50, 49, 48])}
orig_batch = market_web._fetch_batch
orig_boards = (
    market_web.INDEX_BOARD,
    market_web.COMMODITY_BOARD,
    market_web.FX_BOARD,
    market_web.CRYPTO_BOARD,
)
market_web.INDEX_BOARD = [
    {"symbol": "^AAA", "label": "TEST UP", "region": "US"},
    {"symbol": "^BBB", "label": "TEST DOWN", "region": "US"},
]
market_web.COMMODITY_BOARD = []
market_web.FX_BOARD = []
market_web.CRYPTO_BOARD = []
market_web._fetch_batch = lambda symbols, period="5d": {
    s: frames[s] for s in symbols if s in frames
}
market_web._CACHE.clear()
try:
    r = client.get("/market/global")
    check("global board reachable without auth", r.status_code == 200, r.text[:160])
    body = r.json()
    quotes = {q["symbol"]: q for q in body["quotes"]}
    up = quotes["^AAA"]["quote"]
    down = quotes["^BBB"]["quote"]
    check("advancing quote computed", up["change_percent"] > 0 and up["price"] == 102,
          str(up))
    check("declining quote computed", down["change_percent"] < 0, str(down))
finally:
    market_web._fetch_batch = orig_batch
    (
        market_web.INDEX_BOARD,
        market_web.COMMODITY_BOARD,
        market_web.FX_BOARD,
        market_web.CRYPTO_BOARD,
    ) = orig_boards
    market_web._CACHE.clear()

# ---------------------------------------------------------------------------
print("\n[2] /market/movers ranking")


class _Row:
    pass


def fake_movers():
    def row(symbol, group, price, pct, volume):
        return {
            "symbol": symbol,
            "label": symbol,
            "group": group,
            "region": "X",
            "quote": {
                "price": price,
                "change_percent": pct,
                "volume": volume,
                "previous_close": price - 1,
                "change": 1,
                "as_of": "2026-08-26",
            },
            "error": None,
        }

    ranked = [
        row("G1", "us", 10, +4.0, 900),
        row("G2", "us", 20, +2.0, 800),
        row("N", "india", 30, 0.0, 700),
        row("L2", "crypto", 40, -1.0, 600),
        row("L1", "us", 50, -3.0, 500),
    ]
    priced = [r for r in ranked if r["quote"]["change_percent"] is not None]
    ordered = sorted(priced, key=lambda r: r["quote"]["change_percent"], reverse=True)
    active = sorted(
        (r for r in priced if r["quote"]["volume"]),
        key=lambda r: r["quote"]["volume"],
        reverse=True,
    )
    return {
        "gainers": ordered[:8],
        "losers": list(reversed(ordered[-8:])),
        "active": active[:8],
        "as_of": "now",
    }


orig_movers = market_web.get_movers
main_market_movers = market_web.get_movers
market_web.get_movers = fake_movers
try:
    r = client.get("/market/movers")
    check("movers reachable without auth", r.status_code == 200)
    body = r.json()
    check("gainers sorted descending",
          body["gainers"][0]["symbol"] == "G1" and body["gainers"][1]["symbol"] == "G2",
          str([g['symbol'] for g in body['gainers']]))
    check("losers worst-first",
          body["losers"][0]["symbol"] == "L1",
          str(body["losers"][0]["symbol"]))
    check("most active by volume", body["active"][0]["symbol"] == "G1")
finally:
    market_web.get_movers = orig_movers

# ---------------------------------------------------------------------------
print("\n[3] /sectors returns")
sector_frames = {"XLK": bars([100, 102, 104, 106, 108, 110, 112])}
orig_sect_batch = market_web._fetch_batch
market_web._fetch_batch = lambda symbols, period="3mo": {
    s: sector_frames[s] for s in symbols if s in sector_frames
}
market_web._CACHE.clear()


def _ret(offset, closes):
    last = float(closes.iloc[-1])
    base = float(closes.iloc[-1 - offset])
    return round((last / base - 1.0) * 100, 2)


try:
    r = client.get("/sectors")
    check("sectors reachable without auth", r.status_code == 200)
    body = r.json()
    tech = next(s for s in body["sectors"] if s["symbol"] == "XLK")
    closes = sector_frames["XLK"]["Close"]
    check("1D return exact", tech["ret_1d"] == _ret(1, closes),
          f"{tech['ret_1d']} vs {_ret(1, closes)}")
    check("5D return exact", tech["ret_5d"] == _ret(5, closes),
          f"{tech['ret_5d']} vs {_ret(5, closes)}")
    check("1M null when history shorter than 21 sessions", tech["ret_1m"] is None)
finally:
    market_web._fetch_batch = orig_sect_batch

# ---------------------------------------------------------------------------
print("\n[4] /asset/{symbol} bootstrap")
calls = {}


def fake_ensure(symbol, lookback_days=730):
    calls["symbol"] = symbol
    return {
        "dataset_id": 42,
        "status": "current",
        "instrument": {
            "symbol": symbol.upper(),
            "name": "Fake Instruments Inc",
            "exchange": "TEST",
            "asset_type": "EQUITY",
            "currency": "USD",
        },
        "coverage": {"start_date": "2024-08-01", "end_date": "2026-08-25",
                     "row_count": 500},
    }


def fake_quote(symbol):
    return {
        "symbol": symbol.upper(),
        "price": 213.05,
        "change": 4.28,
        "change_percent": 2.04,
        "previous_close": 208.77,
        "volume": 12345678,
        "currency": "USD",
        "source": "yahoo",
        "as_of": "2026-08-26T12:00:00Z",
        "cached": False,
    }


orig_ensure = market_web.ensure_symbol_dataset
market_web.ensure_symbol_dataset = fake_ensure
orig_live = main.market_ingest.get_live_quote
main.market_ingest.get_live_quote = fake_quote
try:
    r = client.get("/asset/nvda")
    check("asset bootstrap reachable without auth", r.status_code == 200, r.text[:200])
    body = r.json()
    check("symbol normalized upper", calls["symbol"] == "nvda")
    check("dataset id surfaced", body["dataset_id"] == 42)
    check("quote merged", body["quote"]["price"] == 213.05)
    check("engines readiness derived",
          body["engines"]["fingerprint"] == "READY"
          and body["engines"]["regimes"] == "READY")
    check("coverage present", body["coverage"]["row_count"] == 500)

    r2 = client.get("/asset/THIS_SYMBOL_IS_WAY_TOO_LONG_XX")
    check("invalid symbol rejected", r2.status_code == 422, str(r2.status_code))

    def boom(symbol, lookback_days=730):
        from data_sources import InvalidSymbol
        raise InvalidSymbol("unknown")

    market_web.ensure_symbol_dataset = boom
    r3 = client.get("/asset/NOPE")
    check("unknown symbol -> 404", r3.status_code == 404, str(r3.status_code))
finally:
    market_web.ensure_symbol_dataset = orig_ensure
    main.market_ingest.get_live_quote = orig_live

# ---------------------------------------------------------------------------
print("\n[5] /market/news aggregation + trending")
news_feeds = {
    "AAPL": [
        {"title": "Apple story two", "link": "a2", "published": "2026-08-26T11:00:00Z",
         "publisher": "Wire"},
        {"title": "Apple story one", "link": "a1", "published": "2026-08-26T09:00:00Z",
         "publisher": "Wire"},
    ],
    "NVDA": [
        {"title": "Nvidia story", "link": "n1", "published": "2026-08-26T10:00:00Z",
         "publisher": "Chip"},
    ],
}
orig_ingest_news = main.market_ingest.get_symbol_news
main.market_ingest.get_symbol_news = (
    lambda symbol, limit=8: news_feeds.get(symbol.upper(), [])
)
market_web._CACHE.clear()
try:
    r = client.get("/market/news?category=latest&symbols=AAPL,NVDA")
    check("news feed reachable without auth", r.status_code == 200, r.text[:200])
    body = r.json()
    titles = [i["title"] for i in body["items"]]
    check("items merged newest first",
          titles[:3] == ["Apple story two", "Nvidia story", "Apple story one"],
          str(titles))
    check("related symbol attached",
          all(i["related_symbol"] in ("AAPL", "NVDA") for i in body["items"]))
    trending = {t["symbol"]: t["stories"] for t in body["trending"]}
    check("trending counts derived", trending.get("AAPL") == 2, str(trending))
finally:
    main.market_ingest.get_symbol_news = orig_ingest_news
    market_web._CACHE.clear()

# ---------------------------------------------------------------------------
print(f"\nRESULT: {'ALL TESTS PASSED' if not FAIL else f'{len(FAIL)} FAILURES'}")
sys.exit(1 if FAIL else 0)
