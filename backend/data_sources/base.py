"""Market-data source abstraction.

A provider converts an external feed into Quant Vector's canonical OHLCV
frame. Nothing in this package talks to MySQL and nothing in the quant
engine depends on a specific provider.

Contract:

    class MarketDataSource:
        name = "provider-name"

        def search(self, query) -> list[dict]
        def fetch(self, symbol, start_date, end_date, interval="1d") -> pandas.DataFrame

`search` returns dicts with as much of this shape as the provider actually
supplies (never invented):

    {symbol, name, exchange, asset_type, currency}

`fetch` returns a DataFrame with the canonical columns
[Date, Open, High, Low, Close, Volume]; normalization/validation happens in
base.normalize_ohlcv so every provider shares identical semantics.
"""

import pandas as pd

from analytics import clean_ohlcv

CANONICAL_COLUMNS = ["Date", "Open", "High", "Low", "Close", "Volume"]
SUPPORTED_INTERVALS = {"1d"}
MIN_OBSERVATIONS = 30


class MarketDataError(Exception):
    """User-facing failure of a market-data operation."""


class DataSourceUnavailable(MarketDataError):
    """Provider unreachable / rate limited / empty response."""


class InvalidSymbol(MarketDataError):
    """Provider does not know this symbol."""


class InvalidRequest(MarketDataError):
    """Bad date range / interval / parameters."""


class MarketDataSource:
    """Base class; subclasses override search/fetch."""

    name = "abstract"
    supports_search = False

    def search(self, query):
        raise NotImplementedError

    def fetch(self, symbol, start_date, end_date, interval="1d"):
        raise NotImplementedError

    # -- shared helpers ----------------------------------------------------

    def _require_interval(self, interval):
        if interval not in SUPPORTED_INTERVALS:
            raise InvalidRequest(
                f"Unsupported interval '{interval}'. Supported: "
                f"{', '.join(sorted(SUPPORTED_INTERVALS))}."
            )

    @staticmethod
    def _require_range(start_date, end_date):
        if start_date is None or end_date is None or start_date >= end_date:
            raise InvalidRequest(
                "Invalid date range: start must be before end."
            )

    def _empty(self, symbol):
        raise DataSourceUnavailable(
            f"Provider '{self.name}' returned no observations for "
            f"'{symbol}' in the requested range."
        )


def normalize_ohlcv(frame, symbol="<unknown>", provider="<unknown>",
                    min_observations=MIN_OBSERVATIONS):
    """Coerce any provider frame into validated canonical OHLCV.

    Steps (Phase F contract):
      1. locate/standardize column names (case-insensitive),
      2. drop tz info on dates (Quant Vector works with calendar dates),
      3. numeric coercion + invalid-row removal via analytics.clean_ohlcv,
      4. chronological sort + exact duplicate-date removal,
      5. sanity checks: no null OHLC after cleaning, monotonic dates,
         enough observations to be analytically useful.
    Missing OHLC values are never fabricated — such rows are dropped and the
    remainder is validated.
    """
    if frame is None or len(frame) == 0:
        raise DataSourceUnavailable(
            f"Provider '{provider}' returned no data for '{symbol}'."
        )

    received_raw = int(len(frame))
    dropped_ohlc = 0
    duplicates_removed = 0
    candles_removed = 0

    working = frame.copy()

    # Multi-index columns (yfinance multi-ticker downloads) -> flatten.
    if isinstance(working.columns, pd.MultiIndex):
        working.columns = [
            part[0] if isinstance(part, tuple) else part for part in working.columns
        ]

    # Providers like yfinance keep timestamps as the frame index.
    if not any(str(c).strip().lower() in ("date", "timestamp", "datetime", "time")
               for c in working.columns):
        idx = working.index
        if isinstance(idx, pd.DatetimeIndex) or str(
            getattr(idx, "name", "") or ""
        ).lower() in ("date", "timestamp", "datetime"):
            working = working.reset_index()
            first = working.columns[0]
            working = working.rename(columns={first: "Date"})

    rename_map = {}
    for column in working.columns:
        key = str(column).strip().lower()
        if key in ("date", "timestamp", "datetime", "time"):
            rename_map[column] = "Date"
        elif key == "open":
            rename_map[column] = "Open"
        elif key == "high":
            rename_map[column] = "High"
        elif key == "low":
            rename_map[column] = "Low"
        elif key in ("close", "adj close", "adjclose", "adjusted_close"):
            rename_map[column] = "Close"
        elif key in ("volume", "vol"):
            rename_map[column] = "Volume"
    working = working.rename(columns=rename_map)

    # Providers may expose both raw and adjusted closes; keep the FIRST
    # occurrence of each canonical column (raw Close beats Adj Close).
    working = working.loc[:, ~pd.Index(working.columns).duplicated()]

    missing = [c for c in CANONICAL_COLUMNS if c not in working.columns]
    if missing:
        raise MarketDataError(
            f"Provider '{provider}' response lacks required columns: "
            f"{', '.join(missing)}."
        )

    working = working.loc[:, CANONICAL_COLUMNS].copy()
    working["Date"] = pd.to_datetime(working["Date"], errors="coerce")
    working["Date"] = working["Date"].dt.tz_localize(None)

    working = clean_ohlcv(working)

    # Drop rows whose OHLC could not be parsed (never fabricate values).
    ohlc_cols = ["Open", "High", "Low", "Close"]
    before_drop = len(working)
    working = working.dropna(subset=ohlc_cols)
    dropped_ohlc = before_drop - len(working)

    working["Volume"] = (
        pd.to_numeric(working["Volume"], errors="coerce").fillna(0).astype("int64")
    )

    before_dedupe = len(working)
    working = working.drop_duplicates(subset="Date", keep="last")
    duplicates_removed = before_dedupe - len(working)
    working = working.sort_values("Date").reset_index(drop=True)

    if working.empty:
        raise DataSourceUnavailable(
            f"Provider '{provider}' returned only malformed rows for '{symbol}'."
        )
    if not working["Date"].is_monotonic_increasing:
        raise MarketDataError("Normalized dates are not chronological.")

    bad_candles = int(
        (
            (working["High"] < working[["Open", "Close"]].max(axis=1))
            | (working["Low"] > working[["Open", "Close"]].min(axis=1))
        ).sum()
    )
    if bad_candles:
        working = working[
            ~(
                (working["High"] < working[["Open", "Close"]].max(axis=1))
                | (working["Low"] > working[["Open", "Close"]].min(axis=1))
            )
        ]
    candles_removed = bad_candles

    if min_observations is not None and len(working) < min_observations:
        raise MarketDataError(
            f"Only {len(working)} valid observations for '{symbol}' "
            f"(minimum {min_observations}); range too short or history unavailable."
        )

    # Receipt metadata (read via frame.attrs by the ingestion orchestrator).
    working.attrs["normalization"] = {
        "received_raw": received_raw,
        "valid": int(len(working)),
        "rejected": received_raw - int(len(working)),
        "unparseable_ohlc_removed": int(dropped_ohlc),
        "duplicate_dates_removed": int(duplicates_removed),
        "invalid_candles_removed": int(candles_removed),
    }
    return working


def to_price_rows(frame):
    """Canonical frame -> tuples matching database._PRICE_INSERT."""
    return [
        (
            row.Date.date(),
            float(row.Open),
            float(row.High),
            float(row.Low),
            float(row.Close),
            int(row.Volume),
        )
        for row in frame.itertuples(index=False)
    ]
