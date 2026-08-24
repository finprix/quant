"""Local CSV market-data source.

Wraps Quant Vector's own CSV parsing so a user can also import from a file path
on the server (or tests can feed synthetic frames) through the exact same
normalization pipeline as remote providers.
"""

import pandas as pd

from data_sources.base import (
    InvalidRequest,
    MarketDataSource,
    MIN_OBSERVATIONS,
    normalize_ohlcv,
)


class CsvSource(MarketDataSource):
    name = "csv"
    supports_search = False

    def search(self, query):
        return []

    def fetch(self, symbol, start_date=None, end_date=None, interval="1d", frame=None,
              min_observations=MIN_OBSERVATIONS):
        """`symbol` is treated as a label; `frame` must carry OHLCV columns."""
        self._require_interval(interval)
        if frame is None or not isinstance(frame, pd.DataFrame) or frame.empty:
            raise InvalidRequest("CSV source requires a non-empty OHLCV DataFrame.")
        return normalize_ohlcv(
            frame.copy(), symbol=symbol or "csv", provider=self.name,
            min_observations=min_observations,
        )


csv_source = CsvSource()
