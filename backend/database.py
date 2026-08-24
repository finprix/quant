"""Quant Vector persistence layer — Turso/libSQL (SQLite dialect).

Two interchangeable drivers sit behind one tiny wrapper:

  * TURSO_DATABASE_URL is set  -> hosted Turso/libSQL via libsql-client
    (pure Python; libsql:// or wss:// enables real transactions).
  * otherwise                  -> embedded local database through stdlib
    sqlite3 at LIBSQL_LOCAL_PATH (default data/quantvector.db), so local
    development needs no server at all.

Both drivers speak the same SQL dialect. A translation shim converts the
few remaining MySQL-isms (%s placeholders, INSERT IGNORE, backticks,
NOW()) so calling modules stay readable. All queries are parameterized.

Public function signatures match the previous MySQL implementation, which
keeps the quant engines, API routes and tests unchanged.
"""

import hashlib
import json
import os
import re
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
SCHEMA_PATH = BASE_DIR / "schema.sql"
DEFAULT_LOCAL_DB = BASE_DIR / "data" / "quantvector.db"


class DatabaseError(RuntimeError):
    """Raised for any connectivity or query failure."""


def _load_env_file(path=BASE_DIR / ".env"):
    """Populate os.environ from a .env file without overriding real env vars."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def get_config():
    """Return the active database configuration (no secrets redacted here:
    callers only log host/url shapes, never tokens)."""
    _load_env_file()
    url = (os.environ.get("TURSO_DATABASE_URL") or "").strip()
    token = (os.environ.get("TURSO_AUTH_TOKEN") or "").strip()
    if url:
        return {
            "mode": "turso",
            "url": url,
            "auth_token": token,
            "driver": "libsql-client",
        }
    local_path = (
        os.environ.get("LIBSQL_LOCAL_PATH", "").strip()
        or str(DEFAULT_LOCAL_DB)
    )
    return {
        "mode": "local",
        "url": f"file:{Path(local_path)}",
        "auth_token": None,
        "driver": "sqlite3",
        "path": Path(local_path),
    }


# ---------------------------------------------------------------------------
# SQL translation: tolerate MySQL-flavoured literals in calling code
# ---------------------------------------------------------------------------

_TRANSLATE_RULES = (
    (re.compile(r"\bINSERT\s+IGNORE\s+INTO\b", re.IGNORECASE),
     "INSERT OR IGNORE INTO"),
    (re.compile(r"\bNOW\(\)", re.IGNORECASE), "CURRENT_TIMESTAMP"),
)


def _translate_sql(sql):
    text = sql.replace("%s", "?").replace("`", '"')
    for pattern, replacement in _TRANSLATE_RULES:
        text = pattern.sub(replacement, text)
    return text


def _coerce_param(value):
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, datetime):
        return value.isoformat(sep=" ")
    if isinstance(value, date):
        return value.isoformat()
    return value


def _coerce_params(params):
    if not params:
        return []
    return [_coerce_param(v) for v in params]


# ---------------------------------------------------------------------------
# Drivers
# ---------------------------------------------------------------------------

class _RemoteTransaction:
    """Thin adapter exposing commit()/rollback() over a libSQL transaction."""

    def __init__(self, client):
        self.client = client
        self.txn = None
        try:
            self.txn = client.transaction()
            self.supported = True
        except Exception:
            self.supported = False


class ConnectionWrapper:
    """Uniform connection facade over sqlite3 or libsql-client."""

    def __init__(self, config, readonly=False):
        self.config = config
        self.mode = config["mode"]
        self.readonly = readonly
        self._client = None
        self._txn = None
        self._txn_failed = False
        if self.mode == "turso":
            import libsql_client

            self._client = libsql_client.create_client_sync(
                config["url"], auth_token=config["auth_token"] or None,
            )
            if readonly:
                try:
                    self._client.execute("PRAGMA query_only = ON")
                except Exception:
                    pass  # best effort on transports that reject PRAGMA
        else:
            path = Path(config["path"])
            path.parent.mkdir(parents=True, exist_ok=True)
            # isolation_level=None -> autocommit off at the driver level;
            # transactions are managed explicitly via begin/commit/rollback,
            # mirroring the previous MySQL semantics.
            if readonly:
                uri = f"file:{path.as_posix()}?mode=ro"
                self._conn = sqlite3.connect(
                    uri, timeout=15, isolation_level=None, uri=True,
                )
            else:
                self._conn = sqlite3.connect(
                    str(path), timeout=15, isolation_level=None,
                )
            self._conn.row_factory = sqlite3.Row
            if not readonly:
                self._conn.execute("PRAGMA foreign_keys = ON")
                try:
                    self._conn.execute("PRAGMA journal_mode = WAL")
                except sqlite3.DatabaseError:
                    pass

    # -- internal execution -------------------------------------------------

    def _run_local(self, sql, params):
        cur = self._conn.execute(sql, params)
        columns = [d[0] for d in cur.description] if cur.description else []
        rows = [tuple(r) for r in cur.fetchall()] if columns else []
        return {
            "columns": columns,
            "rows": rows,
            "rowcount": cur.rowcount,
            "lastrowid": cur.lastrowid,
        }

    def _run_remote(self, sql, params):
        executor = self._txn if self._txn is not None else self._client
        rs = executor.execute(sql, params)
        columns = list(rs.columns) if getattr(rs, "columns", None) else []
        rows = [tuple(row) for row in rs.rows] if columns else []
        # libSQL result sets do not carry an affected-row count; write
        # statements that need one use RETURNING (see cursor.returned_rows).
        return {"columns": columns, "rows": rows, "rowcount": len(rows),
                "lastrowid": None}

    def execute(self, sql, params=()):
        translated = _translate_sql(sql)
        params = _coerce_params(params)
        try:
            if self.mode == "turso":
                return self._run_remote(translated, params)
            return self._run_local(translated, params)
        except DatabaseError:
            raise
        except Exception as exc:
            self._txn_failed = True
            raise DatabaseError(f"Query failed: {exc}") from exc

    def begin(self):
        """Start an explicit multi-statement transaction (best effort)."""
        if self.mode == "turso":
            self._txn_failed = False
            try:
                self._txn = self._client.transaction()
            except Exception:
                # http(s) transport has no server-side transactions;
                # statements run sequentially (documented limitation).
                self._txn = None
        else:
            self._conn.execute("BEGIN")

    def commit(self):
        if self.mode == "turso":
            if self._txn is not None:
                if self._txn_failed:
                    self._txn.rollback()
                else:
                    self._txn.commit()
                self._txn = None
            # individual execute() calls are committed by the server
        else:
            self._conn.commit()

    def rollback(self):
        if self.mode == "turso":
            if self._txn is not None:
                try:
                    self._txn.rollback()
                except Exception:
                    pass
                self._txn = None
        else:
            self._conn.rollback()

    def close(self):
        if self.mode == "turso":
            if self._txn is not None:
                try:
                    self._txn.rollback()
                except Exception:
                    pass
            try:
                self._client.close()
            except Exception:
                pass
        else:
            self._conn.close()

    def cursor(self, dictionary=False, buffered=False):  # buffered ignored
        return CursorWrapper(self, dictionary=dictionary)


class CursorWrapper:
    """Cursor facade mirroring the mysql-connector surface that the
    quant engines already use."""

    def __init__(self, connection, dictionary=False):
        self.connection = connection
        self.dictionary = dictionary
        self.columns = []
        self.rows = []
        self.rowcount = -1
        self.lastrowid = None
        self.returned_rows = []

    @property
    def description(self):
        return [(name,) for name in self.columns] if self.columns else None

    def _absorb(self, result):
        self.columns = result["columns"]
        self.rows = result["rows"]
        self.rowcount = result["rowcount"]
        self.lastrowid = result["lastrowid"]
        self.returned_rows = result["rows"]

    def execute(self, sql, params=()):
        self._absorb(self.connection.execute(sql, params))

    def fetchone(self):
        if not self.rows:
            return None
        row = self.rows.pop(0)
        return self._shape(row)

    def fetchall(self):
        rows, self.rows = self.rows, []
        return [self._shape(row) for row in rows]

    def fetchmany(self, size=1):
        taken, self.rows = self.rows[:size], self.rows[size:]
        return [self._shape(row) for row in taken]

    def _shape(self, row):
        if self.dictionary:
            return {name: value for name, value in zip(self.columns, row)}
        return row

    def close(self):
        self.rows = []


def create_connection(use_database=True, readonly=False):
    """Open a new database connection; raises DatabaseError on failure."""
    try:
        return ConnectionWrapper(get_config(), readonly=readonly)
    except DatabaseError:
        raise
    except Exception as exc:
        cfg = get_config()
        raise DatabaseError(
            f"Database connection failed ({cfg['mode']} {cfg['url']}): {exc}"
        ) from exc


@contextmanager
def get_cursor(dictionary=False):
    """Yield a cursor on a fresh connection with commit/rollback handling."""
    connection = create_connection()
    cursor = connection.cursor(dictionary=dictionary)
    try:
        yield cursor
        connection.commit()
    except DatabaseError:
        connection.rollback()
        raise
    except (ValueError, LookupError, KeyError):
        # Application-level validation errors keep their original type so
        # routes/tests can distinguish them from driver failures.
        connection.rollback()
        raise
    except Exception as exc:
        connection.rollback()
        raise DatabaseError(f"Query failed: {exc}") from exc
    finally:
        cursor.close()
        connection.close()


@contextmanager
def get_transaction():
    """Explicit multi-statement atomic transaction."""
    connection = create_connection()
    cursor = connection.cursor()
    try:
        connection.begin()
        yield cursor
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        cursor.close()
        connection.close()


def initialize_schema():
    """Apply schema.sql (every statement is idempotent)."""
    cleaned = "\n".join(
        line for line in SCHEMA_PATH.read_text(encoding="utf-8").splitlines()
        if not line.lstrip().startswith("--")
    )
    connection = create_connection()
    cursor = connection.cursor()
    try:
        for statement in cleaned.split(";"):
            if statement.strip():
                cursor.execute(statement)
        connection.commit()
    except DatabaseError as exc:
        raise DatabaseError(f"Could not initialize schema: {exc}") from exc
    finally:
        cursor.close()
        connection.close()


def _migrate_price_data_unique():
    """Historical MySQL migration — the unique constraint ships with the
    libSQL schema, so nothing to migrate. Kept for call-site stability."""
    return None


def _to_json_value(value):
    """Convert driver-native types into JSON-safe Python types."""
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value


def _parse_date(value):
    if value in (None, ""):
        return None
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


# ---------------------------------------------------------------------------
# Datasets
# ---------------------------------------------------------------------------

_PRICE_INSERT = """
INSERT INTO price_data (dataset_id, date, "open", high, low, close, volume)
VALUES (%s, %s, %s, %s, %s, %s, %s)
"""

_PRICE_INSERT_IGNORE = """
INSERT OR IGNORE INTO price_data
    (dataset_id, date, "open", high, low, close, volume)
VALUES (%s, %s, %s, %s, %s, %s, %s)
"""

_METRIC_INSERT = """
INSERT INTO analysis_results (dataset_id, metric_name, metric_value)
VALUES (%s, %s, %s)
"""


def store_dataset(filename, start_date, end_date, row_count, latest_close, price_rows, metrics):
    """Persist dataset metadata, all OHLCV rows and metrics atomically."""
    connection = create_connection()
    cursor = connection.cursor()
    dataset_id = None
    try:
        connection.begin()
        cursor.execute(
            """
            INSERT INTO datasets (filename, start_date, end_date, row_count, latest_close)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (filename, start_date, end_date, row_count, latest_close),
        )
        dataset_id = cursor.lastrowid
        if not dataset_id and cursor.returned_rows:
            dataset_id = cursor.returned_rows[0][0]

        if price_rows:
            for row in price_rows:
                cursor.execute(_PRICE_INSERT, (dataset_id, *row))
        if metrics:
            for name, value in metrics.items():
                cursor.execute(_METRIC_INSERT, (dataset_id, name, value))

        connection.commit()
        return dataset_id
    except Exception as exc:
        connection.rollback()
        # Compensating cleanup for transports without server-side
        # transactions (http(s) remotes): never leave an empty registry row.
        if dataset_id is not None:
            try:
                connection.execute("DELETE FROM datasets WHERE id = %s", (dataset_id,))
                connection.commit()
            except Exception:
                pass
        raise DatabaseError(f"Failed to persist dataset '{filename}': {exc}") from exc
    finally:
        cursor.close()
        connection.close()


def list_datasets():
    """Return metadata for every stored dataset, newest first."""
    with get_cursor(dictionary=True) as cursor:
        cursor.execute(
            """
            SELECT id, filename, start_date, end_date, row_count, latest_close, created_at
            FROM datasets
            ORDER BY created_at DESC, id DESC
            """
        )
        return [
            {key: _to_json_value(value) for key, value in row.items()}
            for row in cursor.fetchall()
        ]


def get_dataset(dataset_id):
    """Return one dataset's metadata plus its summary metrics, or None."""
    with get_cursor(dictionary=True) as cursor:
        cursor.execute(
            """
            SELECT id, filename, start_date, end_date, row_count, latest_close, created_at
            FROM datasets
            WHERE id = %s
            """,
            (dataset_id,),
        )
        row = cursor.fetchone()
        if row is None:
            return None

        cursor.execute(
            """
            SELECT metric_name, metric_value
            FROM analysis_results
            WHERE dataset_id = %s
            ORDER BY id
            """,
            (dataset_id,),
        )
        metrics = {
            record["metric_name"]: _to_json_value(record["metric_value"])
            for record in cursor.fetchall()
        }

    dataset = {key: _to_json_value(value) for key, value in row.items()}
    dataset["metrics"] = metrics
    return dataset


def dataset_exists(dataset_id):
    """Check whether a dataset id exists."""
    with get_cursor() as cursor:
        cursor.execute("SELECT 1 FROM datasets WHERE id = %s", (dataset_id,))
        return cursor.fetchone() is not None


def get_prices(dataset_id):
    """Return all stored OHLCV rows for a dataset in chronological order."""
    with get_cursor(dictionary=True) as cursor:
        cursor.execute(
            """
            SELECT date, "open", high, low, close, volume
            FROM price_data
            WHERE dataset_id = %s
            ORDER BY date
            """,
            (dataset_id,),
        )
        records = cursor.fetchall()
    return [
        {
            "date": str(record["date"]),
            "open": float(record["open"]),
            "high": float(record["high"]),
            "low": float(record["low"]),
            "close": float(record["close"]),
            "volume": int(record["volume"]),
        }
        for record in records
    ]


def delete_dataset(dataset_id):
    """Delete a dataset; children are removed by ON DELETE CASCADE."""
    with get_cursor() as cursor:
        cursor.execute(
            "DELETE FROM datasets WHERE id = %s RETURNING id", (dataset_id,)
        )
        return len(cursor.returned_rows) > 0


# ---------------------------------------------------------------------------
# Market-data import provenance + incremental update support
# ---------------------------------------------------------------------------


def upsert_dataset_source(
    dataset_id,
    provider,
    symbol,
    instrument_name=None,
    exchange=None,
    asset_type=None,
    currency=None,
    price_interval="1d",
):
    """Create or refresh the provenance row for an imported dataset."""
    with get_cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO dataset_sources
                (dataset_id, provider, symbol, instrument_name, exchange,
                 asset_type, currency, price_interval)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT(dataset_id) DO UPDATE SET
                provider = excluded.provider,
                symbol = excluded.symbol,
                instrument_name = excluded.instrument_name,
                exchange = excluded.exchange,
                asset_type = excluded.asset_type,
                currency = excluded.currency,
                price_interval = excluded.price_interval,
                last_updated = CURRENT_TIMESTAMP
            """,
            (
                dataset_id, provider, symbol, instrument_name, exchange,
                asset_type, currency, price_interval,
            ),
        )


def get_dataset_source(dataset_id):
    """Return the provenance row for a dataset, or None for CSV uploads."""
    with get_cursor(dictionary=True) as cursor:
        cursor.execute(
            """
            SELECT dataset_id, provider, symbol, instrument_name, exchange,
                   asset_type, currency, price_interval, last_updated
            FROM dataset_sources
            WHERE dataset_id = %s
            """,
            (dataset_id,),
        )
        row = cursor.fetchone()
    if not row:
        return None
    return {key: _to_json_value(value) for key, value in row.items()}


def list_dataset_sources():
    """Return provenance rows keyed by dataset_id (small table; full scan fine)."""
    with get_cursor(dictionary=True) as cursor:
        cursor.execute("SELECT * FROM dataset_sources")
        return {
            row["dataset_id"]: {
                key: _to_json_value(value) for key, value in row.items()
            }
            for row in cursor.fetchall()
        }


def append_price_rows(dataset_id, price_rows):
    """Insert OHLCV rows, ignoring duplicates that already exist.

    Returns the number of rows actually added. Duplicate protection is done
    in SQL so concurrent updates can never double-insert a date.
    """
    if not price_rows:
        return 0
    with get_transaction() as cursor:
        inserted = 0
        for row in price_rows:
            cursor.execute(_PRICE_INSERT_IGNORE + " RETURNING 1",
                           (dataset_id, *row))
            inserted += len(cursor.returned_rows)
        return inserted


def replace_price_rows_from(dataset_id, price_rows, start_date):
    """Replace stored rows on/after ``start_date`` with fresh provider rows.

    Transactional delete+insert used by incremental updates so a previously
    stored provisional (intraday) session bar is corrected instead of frozen.
    Returns ``{"added": net_new_rows, "replaced": deleted_rows}``.
    """
    with get_transaction() as cursor:
        cursor.execute(
            "SELECT COUNT(*) AS n FROM price_data WHERE dataset_id = %s",
            (dataset_id,),
        )
        before = int(cursor.fetchone()[0])
        cursor.execute(
            "DELETE FROM price_data WHERE dataset_id = %s AND date >= %s "
            "RETURNING date",
            (dataset_id, start_date),
        )
        replaced = len(cursor.returned_rows)
        # OR IGNORE: provider batches can contain internal duplicate dates
        # (e.g. an unchanged boundary session fetched twice).
        for row in price_rows:
            cursor.execute(_PRICE_INSERT_IGNORE, (dataset_id, *row))
        cursor.execute(
            "SELECT COUNT(*) AS n FROM price_data WHERE dataset_id = %s",
            (dataset_id,),
        )
        after = int(cursor.fetchone()[0])
        return {"added": after - before, "replaced": replaced}


def get_last_price_date(dataset_id):
    """Latest stored observation date for a dataset, or None."""
    with get_cursor(dictionary=True) as cursor:
        cursor.execute(
            "SELECT MAX(date) AS last_date FROM price_data WHERE dataset_id = %s",
            (dataset_id,),
        )
        row = cursor.fetchone()
    return _parse_date(row["last_date"]) if row else None


def update_dataset_metadata(dataset_id, end_date, row_count, latest_close):
    """Refresh rollup metadata after new observations were appended."""
    with get_cursor() as cursor:
        cursor.execute(
            """
            UPDATE datasets
            SET end_date = %s, row_count = %s, latest_close = %s
            WHERE id = %s
            RETURNING id
            """,
            (end_date, row_count, latest_close, dataset_id),
        )
        return len(cursor.returned_rows) > 0


def delete_analysis_caches(dataset_id):
    """Drop every derived-analysis cache for a dataset after data changed."""
    with get_transaction() as cursor:
        cursor.execute("DELETE FROM fingerprints WHERE dataset_id = %s", (dataset_id,))
        cursor.execute(
            "DELETE FROM analogue_matches WHERE dataset_id = %s", (dataset_id,)
        )
        cursor.execute(
            "DELETE FROM regime_assignments WHERE model_id IN "
            "(SELECT id FROM regime_models WHERE dataset_id = %s)",
            (dataset_id,),
        )
        cursor.execute("DELETE FROM regime_models WHERE dataset_id = %s", (dataset_id,))
        cursor.execute(
            "DELETE FROM intelligence_snapshots WHERE dataset_id = %s", (dataset_id,)
        )


def store_fingerprint(dataset_id, metrics):
    """Replace the stored fingerprint of a dataset with a fresh one."""
    with get_transaction() as cursor:
        cursor.execute("DELETE FROM fingerprints WHERE dataset_id = %s", (dataset_id,))
        numeric_rows = [
            (dataset_id, name, value)
            for name, value in metrics.items()
            if value is None or isinstance(value, (int, float))
        ]
        if numeric_rows:
            for dataset, name, value in numeric_rows:
                cursor.execute(
                    """
                    INSERT INTO fingerprints (dataset_id, metric_name, metric_value)
                    VALUES (%s, %s, %s)
                    """,
                    (dataset, name, value),
                )


def get_stored_fingerprint(dataset_id):
    """Return the persisted fingerprint of a dataset as a dict, or None."""
    with get_cursor(dictionary=True) as cursor:
        cursor.execute(
            """
            SELECT metric_name, metric_value
            FROM fingerprints
            WHERE dataset_id = %s
            ORDER BY id
            """,
            (dataset_id,),
        )
        rows = cursor.fetchall()
    if not rows:
        return None
    return {row["metric_name"]: _to_json_value(row["metric_value"]) for row in rows}


def store_analogues(dataset_id, analogues):
    """Replace stored analogue matches for a dataset (details kept as JSON)."""
    with get_transaction() as cursor:
        cursor.execute(
            "DELETE FROM analogue_matches WHERE dataset_id = %s", (dataset_id,)
        )
        rows = [
            (
                dataset_id,
                analogue["rank"],
                analogue["start_date"],
                analogue["end_date"],
                analogue["distance"],
                analogue["similarity_score"],
                json.dumps(analogue, default=str),
            )
            for analogue in analogues
        ]
        if rows:
            for row in rows:
                cursor.execute(
                    """
                    INSERT INTO analogue_matches
                        (dataset_id, match_rank, start_date, end_date,
                         distance, similarity, details)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    """,
                    row,
                )
        return len(rows)


def get_stored_analogues(dataset_id):
    """Return persisted analogue matches ordered by rank."""
    with get_cursor(dictionary=True) as cursor:
        cursor.execute(
            """
            SELECT match_rank, start_date, end_date, distance, similarity, details
            FROM analogue_matches
            WHERE dataset_id = %s
            ORDER BY match_rank
            """,
            (dataset_id,),
        )
        records = cursor.fetchall()

    analogues = []
    for record in records:
        details = json.loads(record["details"]) if record["details"] else {}
        analogues.append(
            {
                "rank": int(record["match_rank"]),
                "start_date": _to_json_value(record["start_date"]),
                "end_date": _to_json_value(record["end_date"]),
                "distance": float(record["distance"]),
                "similarity_score": float(record["similarity"]),
                **details,
            }
        )
    return analogues


def store_regime_model(dataset_id, summary, assignments):
    """Persist the latest regime model of a dataset (previous one replaced)."""
    with get_transaction() as cursor:
        cursor.execute("DELETE FROM regime_models WHERE dataset_id = %s", (dataset_id,))
        meta = summary.get("model", {})
        pca_meta = summary.get("pca", {})
        cumulative = pca_meta.get("cumulative_explained_variance") or []
        cursor.execute(
            """
            INSERT INTO regime_models
                (dataset_id, window_size, stride, selected_k, auto_selected,
                 n_windows, silhouette, davies_bouldin, pca_components,
                 cumulative_explained_variance, model_json)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                dataset_id,
                int(summary.get("window_size", 0)),
                int(summary.get("stride", 0)),
                int(meta.get("selected_k", 0)),
                bool(meta.get("auto_selected", True)),
                int(summary.get("n_windows", 0)),
                meta.get("silhouette"),
                meta.get("davies_bouldin"),
                int(pca_meta.get("n_components", 0)),
                float(cumulative[-1]) if cumulative else None,
                json.dumps(summary, default=str),
            ),
        )
        model_id = cursor.returned_rows[0][0]

        if assignments:
            for entry in assignments:
                cursor.execute(
                    """
                    INSERT INTO regime_assignments
                        (model_id, window_start, window_end, window_end_index,
                         regime_id, distance_to_centroid, confidence, pca_coordinates)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        model_id,
                        entry["start_date"],
                        entry["end_date"],
                        int(entry["window_end_index"]),
                        int(entry["regime_id"]),
                        entry.get("distance_to_centroid"),
                        entry.get("confidence"),
                        json.dumps(entry.get("pca_coordinates"), default=str),
                    ),
                )
        return model_id


def get_stored_regime_model(dataset_id):
    """Return the latest persisted regime model and its assignments, or None."""
    with get_cursor(dictionary=True) as cursor:
        cursor.execute(
            """
            SELECT id, window_size, stride, selected_k, auto_selected, n_windows,
                   silhouette, davies_bouldin, pca_components,
                   cumulative_explained_variance, model_json, created_at
            FROM regime_models
            WHERE dataset_id = %s
            ORDER BY id DESC
            LIMIT 1
            """,
            (dataset_id,),
        )
        model = cursor.fetchone()
        if model is None:
            return None

        cursor.execute(
            """
            SELECT window_start, window_end, window_end_index, regime_id,
                   distance_to_centroid, confidence, pca_coordinates
            FROM regime_assignments
            WHERE model_id = %s
            ORDER BY window_end_index
            """,
            (model["id"],),
        )
        assignment_rows = cursor.fetchall()

    payload = json.loads(model["model_json"]) if model["model_json"] else {}
    payload["model_id"] = int(model["id"])
    payload["created_at"] = _to_json_value(model["created_at"])
    payload["timeline"] = [
        {
            "start_date": _to_json_value(row["window_start"]),
            "end_date": _to_json_value(row["window_end"]),
            "window_end_index": int(row["window_end_index"]),
            "regime_id": int(row["regime_id"]),
            "distance_to_centroid": _to_json_value(row["distance_to_centroid"]),
            "confidence": _to_json_value(row["confidence"]),
            "pca_coordinates": json.loads(row["pca_coordinates"])
            if row["pca_coordinates"]
            else None,
        }
        for row in assignment_rows
    ]
    return payload


def intelligence_param_hash(parameters):
    """Canonical SHA-256 hash of an intelligence parameter configuration."""
    canonical = json.dumps(parameters, sort_keys=True, default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def get_cached_intelligence(dataset_id, param_hash):
    """Return a reusable intelligence snapshot for identical parameters."""
    with get_cursor(dictionary=True) as cursor:
        cursor.execute(
            """
            SELECT s.id, s.created_at AS generated_at, s.intelligence
            FROM intelligence_snapshots AS s
            JOIN datasets AS d ON d.id = s.dataset_id
            WHERE s.dataset_id = %s
              AND s.param_hash = %s
              AND s.latest_market_date = d.end_date
            ORDER BY s.id DESC
            LIMIT 1
            """,
            (dataset_id, param_hash),
        )
        row = cursor.fetchone()
    if row is None:
        return None
    return {
        "id": int(row["id"]),
        "generated_at": _to_json_value(row["generated_at"]),
        "intelligence": json.loads(row["intelligence"]) if row["intelligence"] else {},
    }


def store_intelligence_snapshot(dataset_id, latest_market_date, param_hash, parameters, intelligence):
    """Insert (or replace) the intelligence snapshot for one configuration."""
    with get_transaction() as cursor:
        cursor.execute(
            """
            DELETE FROM intelligence_snapshots
            WHERE dataset_id = %s AND param_hash = %s
            """,
            (dataset_id, param_hash),
        )
        cursor.execute(
            """
            INSERT INTO intelligence_snapshots
                (dataset_id, latest_market_date, param_hash, parameters, intelligence)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                dataset_id,
                latest_market_date,
                param_hash,
                json.dumps(parameters, default=str),
                json.dumps(intelligence, default=str),
            ),
        )
        return cursor.returned_rows[0][0]


# ---------------------------------------------------------------------------
# Comparison presets (Phase 8)
# ---------------------------------------------------------------------------


def _preset_row_to_dict(row):
    """Normalize one comparison_presets row into a JSON-safe dict."""
    raw_ids = row["dataset_ids"]
    if isinstance(raw_ids, str):
        try:
            raw_ids = json.loads(raw_ids)
        except json.JSONDecodeError:
            raw_ids = []
    return {
        "id": int(row["id"]),
        "name": row["name"],
        "dataset_ids": [int(value) for value in (raw_ids or [])],
        "created_at": _to_json_value(row["created_at"]),
        "updated_at": _to_json_value(row["updated_at"]),
    }


_PRESET_SELECT = """
SELECT id, name, dataset_ids, created_at, updated_at
FROM comparison_presets
"""


def create_comparison_preset(name, dataset_ids):
    """Persist a new saved comparison selection and return it."""
    with get_cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO comparison_presets (name, dataset_ids)
            VALUES (%s, %s)
            RETURNING id
            """,
            (name, json.dumps([int(i) for i in dataset_ids])),
        )
        preset_id = cursor.returned_rows[0][0]
    return get_comparison_preset(preset_id)


def list_comparison_presets():
    """Return every preset, newest first."""
    with get_cursor(dictionary=True) as cursor:
        cursor.execute(_PRESET_SELECT + " ORDER BY updated_at DESC, id DESC")
        return [_preset_row_to_dict(row) for row in cursor.fetchall()]


def get_comparison_preset(preset_id):
    """Return one preset by id, or None."""
    with get_cursor(dictionary=True) as cursor:
        cursor.execute(_PRESET_SELECT + " WHERE id = %s", (preset_id,))
        row = cursor.fetchone()
    return _preset_row_to_dict(row) if row else None


def update_comparison_preset(preset_id, name=None, dataset_ids=None):
    """Update a preset's name and/or dataset selection."""
    assignments = ["updated_at = CURRENT_TIMESTAMP"]
    values = []
    if name is not None:
        assignments.append("name = %s")
        values.append(name)
    if dataset_ids is not None:
        assignments.append("dataset_ids = %s")
        values.append(json.dumps([int(i) for i in dataset_ids]))

    values.append(preset_id)
    with get_cursor() as cursor:
        cursor.execute(
            f"UPDATE comparison_presets SET {', '.join(assignments)} "
            "WHERE id = %s RETURNING id",
            tuple(values),
        )
        if not cursor.returned_rows:
            return None
    return get_comparison_preset(preset_id)


def delete_comparison_preset(preset_id):
    """Delete a preset; returns True when a row was removed."""
    with get_cursor() as cursor:
        cursor.execute(
            "DELETE FROM comparison_presets WHERE id = %s RETURNING id",
            (preset_id,),
        )
        return len(cursor.returned_rows) > 0


# ---------------------------------------------------------------------------
# Ingestion job persistence (serverless-safe status recovery)
# ---------------------------------------------------------------------------


def upsert_ingestion_job(job):
    """Mirror an ingestion-job snapshot so status polls survive restarts."""
    result_json = (json.dumps(job.get("result"), default=str)
                   if job.get("result") is not None else None)
    with get_cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO ingestion_jobs
                (job_id, symbol, provider, status, stage, observations,
                 result_json, error)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT(job_id) DO UPDATE SET
                symbol = excluded.symbol,
                provider = excluded.provider,
                status = excluded.status,
                stage = excluded.stage,
                observations = excluded.observations,
                result_json = excluded.result_json,
                error = excluded.error,
                updated_at = CURRENT_TIMESTAMP
            """,
            (
                job["job_id"], job.get("symbol"), job.get("provider"),
                job["status"], job["stage"], job.get("observations"),
                result_json, job.get("error"),
            ),
        )


def get_ingestion_job(job_id):
    """Return a persisted ingestion-job snapshot, or None."""
    with get_cursor(dictionary=True) as cursor:
        cursor.execute(
            """
            SELECT job_id, symbol, provider, status, stage, observations,
                   result_json, error
            FROM ingestion_jobs
            WHERE job_id = %s
            """,
            (job_id,),
        )
        row = cursor.fetchone()
    if not row:
        return None
    return {
        "job_id": row["job_id"],
        "symbol": row["symbol"],
        "provider": row["provider"],
        "status": row["status"],
        "stage": row["stage"],
        "observations": int(row["observations"]) if row["observations"] is not None else None,
        "result": json.loads(row["result_json"]) if row["result_json"] else None,
        "error": row["error"],
    }


# ---------------------------------------------------------------------------
# Watchlist (tracked symbols)
# ---------------------------------------------------------------------------


def list_watchlist():
    """Tracked symbols, oldest additions first."""
    with get_cursor(dictionary=True) as cursor:
        cursor.execute(
            "SELECT id, symbol, note, added_at FROM watchlist_symbols "
            "ORDER BY added_at, id"
        )
        return [
            {
                "id": int(row["id"]),
                "symbol": row["symbol"],
                "note": row["note"],
                "added_at": _to_json_value(row["added_at"]),
            }
            for row in cursor.fetchall()
        ]


def add_watchlist_symbol(symbol, note=None):
    """Track one symbol (idempotent). Returns the stored row."""
    clean = str(symbol).upper().strip()
    with get_cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO watchlist_symbols (symbol, note)
            VALUES (%s, %s)
            ON CONFLICT(symbol) DO UPDATE SET
                note = COALESCE(excluded.note, watchlist_symbols.note)
            """,
            (clean, note),
        )
    for entry in list_watchlist():
        if entry["symbol"] == clean:
            return entry
    raise DatabaseError(f"Watchlist insert failed for '{clean}'.")


def remove_watchlist_symbol(symbol):
    """Stop tracking one symbol; True when a row was removed."""
    clean = str(symbol).upper().strip()
    with get_cursor() as cursor:
        cursor.execute(
            "DELETE FROM watchlist_symbols WHERE symbol = %s RETURNING id",
            (clean,),
        )
        return len(cursor.returned_rows) > 0
