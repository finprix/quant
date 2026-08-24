"""MySQL persistence layer for QUANT VECTOR.

Configuration is read from environment variables, optionally loaded from a
backend/.env file. No ORM is used and every query is parameterized.
"""

import hashlib
import json
import os
from contextlib import contextmanager
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

import mysql.connector
from mysql.connector import Error as MySQLError

BASE_DIR = Path(__file__).resolve().parent
SCHEMA_PATH = BASE_DIR / "schema.sql"

_ENV_DEFAULTS = {
    "MYSQL_HOST": "localhost",
    "MYSQL_PORT": "3306",
    "MYSQL_USER": "root",
    "MYSQL_PASSWORD": "",
    "MYSQL_DATABASE": "market_dna",
}

# Hosted-platform friendly aliases. Precedence: MYSQL_* (project standard)
# -> DB_* -> Railway's MYSQLHOST-style variables -> local defaults.
_ENV_ALIASES = {
    "MYSQL_HOST": ("DB_HOST", "MYSQLHOST"),
    "MYSQL_PORT": ("DB_PORT", "MYSQLPORT"),
    "MYSQL_USER": ("DB_USER", "MYSQLUSER"),
    "MYSQL_PASSWORD": ("DB_PASSWORD", "MYSQLPASSWORD"),
    "MYSQL_DATABASE": ("DB_NAME", "MYSQLDATABASE"),
}


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


def _env_value(canonical):
    """Resolve one setting through its alias chain."""
    value = os.environ.get(canonical, "").strip()
    if value:
        return value
    for alias in _ENV_ALIASES[canonical]:
        value = os.environ.get(alias, "").strip()
        if value:
            return value
    return ""


def database_name_is_explicit():
    """True when a target database name comes from the environment."""
    _load_env_file()
    return bool(_env_value("MYSQL_DATABASE"))


def get_config():
    """Return the MySQL connection settings from the environment."""
    _load_env_file()
    return {
        "host": _env_value("MYSQL_HOST") or _ENV_DEFAULTS["MYSQL_HOST"],
        "port": int(_env_value("MYSQL_PORT") or _ENV_DEFAULTS["MYSQL_PORT"]),
        "user": _env_value("MYSQL_USER") or _ENV_DEFAULTS["MYSQL_USER"],
        "password": _env_value("MYSQL_PASSWORD"),
        "database": _env_value("MYSQL_DATABASE") or _ENV_DEFAULTS["MYSQL_DATABASE"],
        "connection_timeout": int(os.environ.get("MYSQL_CONNECT_TIMEOUT", "10")),
        # Hosted MySQL (e.g. Railway proxy) benefits from explicit TCP
        # keepalives so idle pooled sockets are not dropped silently.
        "pool_reset_session": True,
    }


def create_connection(use_database=True):
    """Open a new MySQL connection; raises DatabaseError on failure."""
    config = get_config()
    if not use_database:
        config.pop("database", None)
    try:
        return mysql.connector.connect(**config)
    except MySQLError as exc:
        raise DatabaseError(
            f"MySQL connection failed ({config['host']}:{config['port']} "
            f"as {config['user']}, database '{config.get('database')}'): {exc}"
        ) from exc


@contextmanager
def get_cursor(dictionary=False):
    """Yield a cursor on a fresh connection with commit/rollback handling."""
    connection = create_connection()
    cursor = connection.cursor(dictionary=dictionary)
    try:
        yield cursor
        connection.commit()
    except MySQLError as exc:
        connection.rollback()
        raise DatabaseError(f"Query failed: {exc}") from exc
    finally:
        cursor.close()
        connection.close()


def initialize_schema():
    """Apply schema.sql (every statement is idempotent).

    When an explicit database name is configured (hosted MySQL), the
    connection selects it directly and the file's CREATE DATABASE / USE
    provisioning statements are skipped so any database name works.
    """
    raw_lines = SCHEMA_PATH.read_text(encoding="utf-8").splitlines()
    # Drop comment lines so statement splitting on ';' stays trivial.
    cleaned = "\n".join(line for line in raw_lines if not line.lstrip().startswith("--"))

    use_explicit_database = database_name_is_explicit()
    if use_explicit_database:
        provisioned = []
        for statement in cleaned.split(";"):
            head = statement.strip().split("\n", 1)[0].strip().upper()
            if head.startswith("CREATE DATABASE") or head.startswith("USE "):
                continue
            provisioned.append(statement)
        cleaned = ";".join(provisioned)

    connection = create_connection(use_database=not use_explicit_database)
    cursor = connection.cursor()
    try:
        for statement in cleaned.split(";"):
            if statement.strip():
                cursor.execute(statement)
        connection.commit()
    except MySQLError as exc:
        raise DatabaseError(f"Could not initialize schema: {exc}") from exc
    finally:
        cursor.close()
        connection.close()

    _migrate_price_data_unique()


def _migrate_price_data_unique():
    """v0.10 migration: enforce one row per (dataset_id, date).

    Older installs created price_data with a plain (dataset_id, date) index.
    Deduplicate any existing repeats, then add the unique index. Safe to run
    on every startup.
    """
    dedupe = """
        DELETE p1 FROM price_data p1
        JOIN price_data p2
          ON p1.dataset_id = p2.dataset_id
         AND p1.date = p2.date
         AND p1.id > p2.id
    """
    add_index = (
        "ALTER TABLE price_data "
        "ADD UNIQUE INDEX uq_price_data_dataset_date (dataset_id, date)"
    )
    connection = create_connection()
    cursor = connection.cursor()
    try:
        cursor.execute(dedupe)
        connection.commit()
        try:
            cursor.execute(add_index)
            connection.commit()
        except MySQLError as exc:
            # 1061 duplicate key name -> index already present.
            if exc.errno != 1061:
                raise
    except MySQLError as exc:
        connection.rollback()
        raise DatabaseError(f"price_data unique-index migration failed: {exc}") from exc
    finally:
        cursor.close()
        connection.close()


def _to_json_value(value):
    """Convert MySQL-native types into JSON-safe Python types."""
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return value


_PRICE_INSERT = """
INSERT INTO price_data (dataset_id, date, `open`, high, low, close, volume)
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
    try:
        cursor.execute(
            """
            INSERT INTO datasets (filename, start_date, end_date, row_count, latest_close)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (filename, start_date, end_date, row_count, latest_close),
        )
        dataset_id = cursor.lastrowid

        if price_rows:
            cursor.executemany(
                _PRICE_INSERT,
                [(dataset_id, *row) for row in price_rows],
            )
        if metrics:
            cursor.executemany(
                _METRIC_INSERT,
                [(dataset_id, name, value) for name, value in metrics.items()],
            )

        connection.commit()
        return dataset_id
    except MySQLError as exc:
        connection.rollback()
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
            SELECT date, `open`, high, low, close, volume
            FROM price_data
            WHERE dataset_id = %s
            ORDER BY date
            """,
            (dataset_id,),
        )
        return [
            {
                "date": record["date"].isoformat(),
                "open": float(record["open"]),
                "high": float(record["high"]),
                "low": float(record["low"]),
                "close": float(record["close"]),
                "volume": int(record["volume"]),
            }
            for record in cursor.fetchall()
        ]


def delete_dataset(dataset_id):
    """Delete a dataset; children are removed by ON DELETE CASCADE."""
    with get_cursor() as cursor:
        cursor.execute("DELETE FROM datasets WHERE id = %s", (dataset_id,))
        return cursor.rowcount > 0


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
            ON DUPLICATE KEY UPDATE
                provider = VALUES(provider),
                symbol = VALUES(symbol),
                instrument_name = VALUES(instrument_name),
                exchange = VALUES(exchange),
                asset_type = VALUES(asset_type),
                currency = VALUES(currency),
                price_interval = VALUES(price_interval)
            """,
            (
                dataset_id,
                provider,
                symbol,
                instrument_name,
                exchange,
                asset_type,
                currency,
                price_interval,
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
    connection = create_connection()
    cursor = connection.cursor()
    try:
        inserted = 0
        for row in price_rows:
            cursor.execute(
                """
                INSERT IGNORE INTO price_data
                    (dataset_id, date, `open`, high, low, close, volume)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                (dataset_id, *row),
            )
            inserted += cursor.rowcount
        connection.commit()
        return inserted
    except MySQLError as exc:
        connection.rollback()
        raise DatabaseError(f"Failed to append price rows: {exc}") from exc
    finally:
        cursor.close()
        connection.close()


def replace_price_rows_from(dataset_id, price_rows, start_date):
    """Replace stored rows on/after ``start_date`` with fresh provider rows.

    Transactional delete+insert used by incremental updates so a previously
    stored provisional (intraday) session bar is corrected instead of frozen.
    Returns ``{"added": net_new_rows, "replaced": deleted_rows}`` where
    ``added`` is the net change relative to the previous state (0 means the
    content did not effectively change) and ``replaced`` counts stored rows
    that were removed from the overlap window and rewritten.
    """
    connection = create_connection()
    cursor = connection.cursor()
    try:
        cursor.execute(
            "SELECT COUNT(*) FROM price_data WHERE dataset_id = %s",
            (dataset_id,),
        )
        before = cursor.fetchone()[0]
        cursor.execute(
            "DELETE FROM price_data WHERE dataset_id = %s AND date >= %s",
            (dataset_id, start_date),
        )
        replaced = cursor.rowcount
        for row in price_rows:
            cursor.execute(
                """
                INSERT IGNORE INTO price_data
                    (dataset_id, date, `open`, high, low, close, volume)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                (dataset_id, *row),
            )
        cursor.execute(
            "SELECT COUNT(*) FROM price_data WHERE dataset_id = %s",
            (dataset_id,),
        )
        after = cursor.fetchone()[0]
        connection.commit()
        return {"added": after - before, "replaced": replaced}
    except MySQLError as exc:
        connection.rollback()
        raise DatabaseError(f"Failed to replace price rows: {exc}") from exc
    finally:
        cursor.close()
        connection.close()


def get_last_price_date(dataset_id):
    """Latest stored observation date for a dataset, or None."""
    with get_cursor(dictionary=True) as cursor:
        cursor.execute(
            "SELECT MAX(date) AS last_date FROM price_data WHERE dataset_id = %s",
            (dataset_id,),
        )
        row = cursor.fetchone()
    value = row["last_date"] if row else None
    return value.date() if isinstance(value, datetime) else value


def update_dataset_metadata(dataset_id, end_date, row_count, latest_close):
    """Refresh rollup metadata after new observations were appended."""
    with get_cursor() as cursor:
        cursor.execute(
            """
            UPDATE datasets
            SET end_date = %s, row_count = %s, latest_close = %s
            WHERE id = %s
            """,
            (end_date, row_count, latest_close, dataset_id),
        )
        return cursor.rowcount > 0


def delete_analysis_caches(dataset_id):
    """Drop every derived-analysis cache for a dataset after data changed.

    Fingerprints, analogue matches and regime models are recomputed lazily on
    the next request; intelligence snapshots are parameter-hash keyed and are
    invalidated by deleting them outright.
    """
    connection = create_connection()
    cursor = connection.cursor()
    try:
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
        connection.commit()
    except MySQLError as exc:
        connection.rollback()
        raise DatabaseError(f"Failed to invalidate caches: {exc}") from exc
    finally:
        cursor.close()
        connection.close()


def store_fingerprint(dataset_id, metrics):
    """Replace the stored fingerprint of a dataset with a fresh one."""
    connection = create_connection()
    cursor = connection.cursor()
    try:
        cursor.execute("DELETE FROM fingerprints WHERE dataset_id = %s", (dataset_id,))
        # metric_value is a DOUBLE column: persist numbers and nulls only;
        # categorical entries (e.g. ma20_ma50_relationship) stay API-only.
        numeric_rows = [
            (dataset_id, name, value)
            for name, value in metrics.items()
            if value is None or isinstance(value, (int, float))
        ]
        if numeric_rows:
            cursor.executemany(
                """
                INSERT INTO fingerprints (dataset_id, metric_name, metric_value)
                VALUES (%s, %s, %s)
                """,
                numeric_rows,
            )
        connection.commit()
    except MySQLError as exc:
        connection.rollback()
        raise DatabaseError(f"Failed to store fingerprint for dataset {dataset_id}: {exc}") from exc
    finally:
        cursor.close()
        connection.close()


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
    connection = create_connection()
    cursor = connection.cursor()
    try:
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
            cursor.executemany(
                """
                INSERT INTO analogue_matches
                    (dataset_id, match_rank, start_date, end_date,
                     distance, similarity, details)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                rows,
            )
        connection.commit()
        return len(rows)
    except MySQLError as exc:
        connection.rollback()
        raise DatabaseError(f"Failed to store analogues for dataset {dataset_id}: {exc}") from exc
    finally:
        cursor.close()
        connection.close()


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
    """Persist the latest regime model of a dataset (previous one replaced).

    `summary` is stored as JSON so results can be reproduced/displayed
    without duplicating OHLCV rows; `assignments` rows carry per-window
    regime labels, distances, confidences and PCA coordinates.
    """
    connection = create_connection()
    cursor = connection.cursor()
    try:
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
        model_id = cursor.lastrowid

        if assignments:
            cursor.executemany(
                """
                INSERT INTO regime_assignments
                    (model_id, window_start, window_end, window_end_index,
                     regime_id, distance_to_centroid, confidence, pca_coordinates)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                [
                    (
                        model_id,
                        entry["start_date"],
                        entry["end_date"],
                        int(entry["window_end_index"]),
                        int(entry["regime_id"]),
                        entry.get("distance_to_centroid"),
                        entry.get("confidence"),
                        json.dumps(entry.get("pca_coordinates"), default=str),
                    )
                    for entry in assignments
                ],
            )
        connection.commit()
        return model_id
    except MySQLError as exc:
        connection.rollback()
        raise DatabaseError(f"Failed to store regime model for dataset {dataset_id}: {exc}") from exc
    finally:
        cursor.close()
        connection.close()


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
    """Return a reusable intelligence snapshot for identical parameters.

    A snapshot is only valid while the dataset's latest market date still
    matches the one it was generated from; new uploads naturally invalidate
    cached results because they receive a new dataset id or end date.
    """
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
    connection = create_connection()
    cursor = connection.cursor()
    try:
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
            """,
            (
                dataset_id,
                latest_market_date,
                param_hash,
                json.dumps(parameters, default=str),
                json.dumps(intelligence, default=str),
            ),
        )
        connection.commit()
        return cursor.lastrowid
    except MySQLError as exc:
        connection.rollback()
        raise DatabaseError(f"Failed to store intelligence snapshot for dataset {dataset_id}: {exc}") from exc
    finally:
        cursor.close()
        connection.close()


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
    with get_cursor(dictionary=True) as cursor:
        cursor.execute(
            """
            INSERT INTO comparison_presets (name, dataset_ids)
            VALUES (%s, %s)
            """,
            (name, json.dumps([int(i) for i in dataset_ids])),
        )
        preset_id = cursor.lastrowid
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
    """Update a preset's name and/or dataset selection.

    Returns the refreshed preset, or None when the id does not exist.
    """
    assignments = []
    values = []
    if name is not None:
        assignments.append("name = %s")
        values.append(name)
    if dataset_ids is not None:
        assignments.append("dataset_ids = %s")
        values.append(json.dumps([int(i) for i in dataset_ids]))
    if not assignments:
        return get_comparison_preset(preset_id)

    values.append(preset_id)
    with get_cursor(dictionary=True) as cursor:
        cursor.execute(
            f"UPDATE comparison_presets SET {', '.join(assignments)} WHERE id = %s",
            tuple(values),
        )
        if cursor.rowcount == 0:
            return None
    return get_comparison_preset(preset_id)


def delete_comparison_preset(preset_id):
    """Delete a preset; returns True when a row was removed."""
    with get_cursor() as cursor:
        cursor.execute("DELETE FROM comparison_presets WHERE id = %s", (preset_id,))
        return cursor.rowcount > 0
