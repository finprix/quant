"""Quantitative analytics engine for QUANT VECTOR.

Every public function accepts a cleaned OHLCV pandas DataFrame with the
columns Date, Open, High, Low, Close, Volume (sorted chronologically) and
returns plain Python types so results serialize safely as JSON.
"""

import math

import numpy as np
import pandas as pd

TRADING_DAYS_PER_YEAR = 252

REQUIRED_COLUMNS = ["Date", "Open", "High", "Low", "Close", "Volume"]


def _safe_float(value):
    """Convert a scalar to float, turning NaN/inf into None (null in JSON)."""
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(number) or math.isinf(number):
        return None
    return number


def missing_columns(df):
    """List required columns that are not present in the DataFrame."""
    return [column for column in REQUIRED_COLUMNS if column not in df.columns]


def clean_ohlcv(df):
    """Coerce column types, drop invalid rows and sort chronologically."""
    frame = df.loc[:, REQUIRED_COLUMNS].copy()

    frame["Date"] = pd.to_datetime(frame["Date"], errors="coerce")
    for column in REQUIRED_COLUMNS[1:]:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")

    # Rows with unparsable dates or non-numeric values are invalid.
    frame = frame.dropna()

    # Prices must be strictly positive so log returns stay defined.
    frame = frame[(frame[["Open", "High", "Low", "Close"]] > 0).all(axis=1)]
    frame = frame[frame["Volume"] >= 0]

    return frame.sort_values("Date").reset_index(drop=True)


def compute_returns(close):
    """Daily simple returns and logarithmic returns of a close price series."""
    close = close.astype(float)
    daily_return = close.pct_change()
    log_return = np.log(close / close.shift(1))
    return daily_return, log_return


def compute_drawdown(close):
    """Drawdown of each point relative to the running historical maximum."""
    close = close.astype(float)
    running_max = close.cummax()
    return close / running_max - 1.0


def calculate_summary(df):
    """Whole-dataset statistics returned as a flat dictionary."""
    close = df["Close"].astype(float)
    volume = df["Volume"].astype(float)

    daily_return, _ = compute_returns(close)
    returns = daily_return.dropna()
    drawdown = compute_drawdown(close)

    std_daily_return = returns.std(ddof=1)

    return {
        "total_return": _safe_float(close.iloc[-1] / close.iloc[0] - 1.0),
        "mean_daily_return": _safe_float(returns.mean()),
        "median_daily_return": _safe_float(returns.median()),
        "std_daily_return": _safe_float(std_daily_return),
        # Annualized volatility = daily sigma * sqrt(252).
        "annualized_volatility": _safe_float(std_daily_return * math.sqrt(TRADING_DAYS_PER_YEAR)),
        "min_daily_return": _safe_float(returns.min()),
        "max_daily_return": _safe_float(returns.max()),
        "skewness": _safe_float(returns.skew()),
        "kurtosis": _safe_float(returns.kurt()),
        "mean_close": _safe_float(close.mean()),
        "median_close": _safe_float(close.median()),
        "highest_close": _safe_float(close.max()),
        "lowest_close": _safe_float(close.min()),
        "average_volume": _safe_float(volume.mean()),
        "max_drawdown": _safe_float(drawdown.min()),
        "latest_close": _safe_float(close.iloc[-1]),
    }


def calculate_timeseries(df):
    """Per-date analytics used by the dashboard charts."""
    frame = df.copy()
    close = frame["Close"].astype(float)

    frame["daily_return"], frame["log_return"] = compute_returns(close)

    frame["ma_20"] = close.rolling(window=20, min_periods=20).mean()
    frame["ma_50"] = close.rolling(window=50, min_periods=50).mean()

    # 20-day rolling volatility, annualized with sqrt(252).
    frame["volatility_20d"] = (
        frame["daily_return"]
        .rolling(window=20, min_periods=20)
        .std(ddof=1)
        * math.sqrt(TRADING_DAYS_PER_YEAR)
    )

    frame["cumulative_return"] = close / close.iloc[0] - 1.0
    frame["drawdown"] = compute_drawdown(close)

    series = []
    for record in frame.to_dict(orient="records"):
        series.append(
            {
                "date": record["Date"].isoformat(),
                "close": _safe_float(record["Close"]),
                "daily_return": _safe_float(record["daily_return"]),
                "log_return": _safe_float(record["log_return"]),
                "ma_20": _safe_float(record["ma_20"]),
                "ma_50": _safe_float(record["ma_50"]),
                "volatility_20d": _safe_float(record["volatility_20d"]),
                "cumulative_return": _safe_float(record["cumulative_return"]),
                "drawdown": _safe_float(record["drawdown"]),
            }
        )
    return series
