"""Market-data source registry.

Adding a provider later means: subclass MarketDataSource, implement
search/fetch, register it here. Nothing else in Quant Vector changes.
"""

from data_sources.base import (
    CANONICAL_COLUMNS,
    DataSourceUnavailable,
    InvalidRequest,
    InvalidSymbol,
    MIN_OBSERVATIONS,
    MarketDataError,
    MarketDataSource,
    SUPPORTED_INTERVALS,
    normalize_ohlcv,
    to_price_rows,
)
from data_sources.csv_source import CsvSource, csv_source
from data_sources.yahoo import YahooSource, yahoo_source

_PROVIDERS = {
    yahoo_source.name: yahoo_source,
    csv_source.name: csv_source,
}

DEFAULT_PROVIDER = "yahoo"


def get_provider(name=None):
    key = (name or DEFAULT_PROVIDER).strip().lower()
    provider = _PROVIDERS.get(key)
    if provider is None:
        raise InvalidRequest(
            f"Unknown data provider '{name}'. Available: {', '.join(sorted(_PROVIDERS))}."
        )
    return provider


def provider_names():
    return sorted(_PROVIDERS)


__all__ = [
    "CANONICAL_COLUMNS",
    "MIN_OBSERVATIONS",
    "SUPPORTED_INTERVALS",
    "MarketDataError",
    "MarketDataSource",
    "DataSourceUnavailable",
    "InvalidRequest",
    "InvalidSymbol",
    "normalize_ohlcv",
    "to_price_rows",
    "YahooSource",
    "yahoo_source",
    "CsvSource",
    "csv_source",
    "get_provider",
    "provider_names",
]
