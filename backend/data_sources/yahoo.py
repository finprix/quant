"""Yahoo Finance provider (structured access via the `yfinance` library).

No HTML scraping: yfinance uses Yahoo's chart/search JSON endpoints and
handles rate-limit headers, retries and crumb negotiation internally.

Provider metadata is passed through verbatim; fields Yahoo does not return
stay None rather than being invented.
"""

from datetime import date, datetime

import pandas as pd

from data_sources.base import (
    InvalidRequest,
    InvalidSymbol,
    MarketDataSource,
    MarketDataError,
    DataSourceUnavailable,
    MIN_OBSERVATIONS,
    normalize_ohlcv,
)

ASSET_TYPE_MAP = {
    "EQUITY": "EQUITY",
    "ETF": "ETF",
    "INDEX": "INDEX",
    "CRYPTOCURRENCY": "CRYPTO",
    "CURRENCY": "FX",
    "FUTURE": "FUTURE",
    "MUTUALFUND": "FUND",
    "OPTION": "OPTION",
}


def _import_yfinance():
    try:
        import yfinance
    except ImportError as exc:  # pragma: no cover - environment issue
        raise MarketDataError(
            "The 'yfinance' package is not installed. "
            "Install it with: pip install yfinance"
        ) from exc
    return yfinance


class YahooSource(MarketDataSource):
    name = "yahoo"
    supports_search = True

    def search(self, query):
        """Structured instrument search via Yahoo's quote-search endpoint."""
        text = (query or "").strip()
        if not text:
            return []
        if len(text) > 60:
            raise InvalidRequest("Search query too long.")

        yfinance = _import_yfinance()
        try:
            found = yfinance.Search(query=text, max_results=12, news_count=0)
            quotes = found.quotes or []
        except Exception as exc:
            raise DataSourceUnavailable(f"Yahoo Finance search failed: {exc}") from exc

        results = []
        seen = set()
        for quote in quotes:
            symbol = str(quote.get("symbol") or "").strip()
            if not symbol or symbol in seen:
                continue
            seen.add(symbol)
            raw_type = str(quote.get("quoteType") or "").upper()
            results.append(
                {
                    "symbol": symbol,
                    "name": quote.get("shortname") or quote.get("longname") or None,
                    "exchange": quote.get("exchDisp") or quote.get("exchange") or None,
                    "asset_type": ASSET_TYPE_MAP.get(raw_type, raw_type or None),
                    "currency": quote.get("currency") or None,
                }
            )
        return results

    def fetch(self, symbol, start_date, end_date, interval="1d",
              min_observations=MIN_OBSERVATIONS):
        self._require_interval(interval)
        start = self._as_date(start_date, "start_date")
        end = self._as_date(end_date, "end_date")
        self._require_range(start, end)

        clean_symbol = str(symbol or "").strip()
        if not clean_symbol or len(clean_symbol) > 24:
            raise InvalidSymbol(f"Invalid symbol '{symbol}'.")

        yfinance = _import_yfinance()
        try:
            ticker = yfinance.Ticker(clean_symbol)
            frame = ticker.history(
                start=start.isoformat(),
                end=(end + pd.Timedelta(days=1)).isoformat(),
                interval=interval,
                auto_adjust=False,
                actions=False,
                repair=True,
            )
        except Exception as exc:
            raise DataSourceUnavailable(
                f"Yahoo Finance request for '{clean_symbol}' failed: {exc}"
            ) from exc

        if frame is None or len(frame) == 0:
            # Distinguish unknown symbols from empty ranges where possible.
            try:
                info_empty = ticker.history_metadata in (None, {}, []) if hasattr(
                    ticker, "history_metadata"
                ) else False
            except Exception:
                info_empty = False
            if info_empty:
                raise InvalidSymbol(
                    f"Yahoo Finance does not recognize symbol '{clean_symbol}'."
                )
            self._empty(clean_symbol)

        return normalize_ohlcv(
            frame, symbol=clean_symbol, provider=self.name,
            min_observations=min_observations,
        )

    @staticmethod
    def _as_date(value, label):
        if isinstance(value, datetime):
            return value.date()
        if isinstance(value, date):
            return value
        try:
            return date.fromisoformat(str(value)[:10])
        except ValueError as exc:
            raise InvalidRequest(f"'{label}' must be an ISO date (YYYY-MM-DD).") from exc


# Module-level singleton used by the API layer.
yahoo_source = YahooSource()
