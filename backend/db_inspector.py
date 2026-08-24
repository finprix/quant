"""Read-only MySQL inspector backing the DATABASE page (v0.11.0).

Security model:
  - table names must be members of TABLE_WHITELIST,
  - column identifiers are resolved against information_schema for the
    whitelisted table before being quoted into SQL,
  - every value is bound as a parameter — never interpolated,
  - pagination is bounded (MAX_PAGE_LIMIT),
  - only SELECT / SHOW / information_schema reads are ever issued.

This module is an inspector, not a SQL console: the structured browsing
endpoints never accept caller-supplied SQL. A separate, tightly fenced
raw-query executor (run_raw_query, v0.12.1) exists for developers only —
see its guardrail list above it.
"""

import re
import time

from database import (
    DatabaseError,
    create_connection,
    get_cursor,
)

MAX_PAGE_LIMIT = 500

# The real Quant Vector tables (verified against schema.sql + information_schema).
TABLE_WHITELIST = {
    "datasets": {"category": "raw", "label": "Dataset registry"},
    "price_data": {"category": "raw", "label": "OHLCV observations"},
    "dataset_sources": {"category": "raw", "label": "Import provenance"},
    "analysis_results": {"category": "cache", "label": "Summary cache"},
    "fingerprints": {"category": "cache", "label": "Fingerprint cache"},
    "analogue_matches": {"category": "cache", "label": "Analogue matches"},
    "regime_models": {"category": "cache", "label": "Regime models"},
    "regime_assignments": {"category": "cache", "label": "Regime windows"},
    "intelligence_snapshots": {"category": "cache", "label": "Intelligence cache"},
    "comparison_presets": {"category": "config", "label": "Saved presets"},
}

# Equality filters accepted per table (values are always parameterized).
_FILTERABLE = {
    "datasets": {"id", "filename"},
    "price_data": {"dataset_id", "date"},
    "dataset_sources": {"dataset_id", "provider", "symbol", "price_interval"},
    "analysis_results": {"dataset_id", "metric_name"},
    "fingerprints": {"dataset_id", "metric_name"},
    "analogue_matches": {"dataset_id", "match_rank"},
    "regime_models": {"dataset_id", "window_size", "selected_k"},
    "regime_assignments": {"model_id", "regime_id"},
    "intelligence_snapshots": {"dataset_id", "latest_market_date"},
    "comparison_presets": {},
}


class UnknownTable(LookupError):
    """Requested table is not on the read-only whitelist."""


def _quote_ident(identifier):
    """Backtick-quote an identifier that was already whitelist-validated."""
    clean = str(identifier).replace("`", "")
    return f"`{clean}`"


def get_status():
    """Cheap connectivity probe with latency. Never raises for offline DB."""
    started = time.perf_counter()
    try:
        with get_cursor(dictionary=True) as cursor:
            cursor.execute("SELECT DATABASE() AS db, VERSION() AS ver")
            row = cursor.fetchone()
            cursor.execute(
                """
                SELECT COUNT(*) AS n FROM information_schema.TABLES
                WHERE TABLE_SCHEMA = DATABASE()
                """
            )
            tables = cursor.fetchone()["n"]
        latency_ms = round((time.perf_counter() - started) * 1000, 1)
        return {
            "connected": True,
            "database": row["db"],
            "server_version": row["ver"],
            "latency_ms": latency_ms,
            "tables_count": int(tables),
        }
    except DatabaseError:
        return {
            "connected": False,
            "database": None,
            "server_version": None,
            "latency_ms": None,
            "tables_count": None,
            "reason": "Unable to establish database connection.",
        }


def list_tables():
    """All whitelisted tables with exact row counts and categories."""
    result = []
    for name, meta in TABLE_WHITELIST.items():
        with get_cursor() as cursor:
            cursor.execute(f"SELECT COUNT(*) FROM {_quote_ident(name)}")
            rows = cursor.fetchone()[0]
        result.append(
            {
                "name": name,
                "label": meta["label"],
                "category": meta["category"],
                "rows": int(rows),
            }
        )
    # Raw tables first, then caches/config; alphabetical inside each group.
    order = {"raw": 0, "cache": 1, "config": 2}
    result.sort(key=lambda item: (order[item["category"]], item["name"]))
    return result


def _table_columns(cursor, table):
    """Column names of a whitelisted table, from information_schema."""
    cursor.execute(
        """
        SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s
        ORDER BY ORDINAL_POSITION
        """,
        (table,),
    )
    return [row["COLUMN_NAME"] for row in cursor.fetchall()]


def get_table_schema(table):
    """Full schema description: columns, PK, FKs, unique keys, indexes."""
    if table not in TABLE_WHITELIST:
        raise UnknownTable(f"Unknown table '{table}'.")
    with get_cursor(dictionary=True) as cursor:
        cursor.execute(
            """
            SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY,
                   COLUMN_DEFAULT, EXTRA
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s
            ORDER BY ORDINAL_POSITION
            """,
            (table,),
        )
        columns = [
            {
                "name": c["COLUMN_NAME"],
                "type": c["COLUMN_TYPE"],
                "nullable": c["IS_NULLABLE"] == "YES",
                "key": c["COLUMN_KEY"] or None,
                "default": None if c["COLUMN_DEFAULT"] is None
                else str(c["COLUMN_DEFAULT"]),
                "extra": c["EXTRA"] or None,
            }
            for c in cursor.fetchall()
        ]
        cursor.execute(
            """
            SELECT INDEX_NAME, NON_UNIQUE,
                   GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
            FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s
            GROUP BY INDEX_NAME, NON_UNIQUE
            """,
            (table,),
        )
        indexes = []
        for idx in cursor.fetchall():
            index_cols = idx["cols"].split(",")
            entry = {
                "name": idx["INDEX_NAME"],
                "columns": index_cols,
                "unique": idx["NON_UNIQUE"] == 0,
                "primary": idx["INDEX_NAME"] == "PRIMARY",
            }
            indexes.append(entry)
        primary_key = next(
            (e["columns"] for e in indexes if e["primary"]), []
        )
        uniques = [
            {"name": e["name"], "columns": e["columns"]}
            for e in indexes if e["unique"] and not e["primary"]
        ]
        plain_indexes = [
            {"name": e["name"], "columns": e["columns"]}
            for e in indexes if not e["unique"] and not e["primary"]
        ]
        cursor.execute(
            """
            SELECT CONSTRAINT_NAME, COLUMN_NAME,
                   REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
            FROM information_schema.KEY_COLUMN_USAGE
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s
              AND REFERENCED_TABLE_NAME IS NOT NULL
            """,
            (table,),
        )
        foreign_keys = [
            {
                "name": fk["CONSTRAINT_NAME"],
                "column": fk["COLUMN_NAME"],
                "references_table": fk["REFERENCED_TABLE_NAME"],
                "references_column": fk["REFERENCED_COLUMN_NAME"],
            }
            for fk in cursor.fetchall()
        ]
    return {
        "table": table,
        "category": TABLE_WHITELIST[table]["category"],
        "label": TABLE_WHITELIST[table]["label"],
        "columns": columns,
        "primary_key": primary_key,
        "foreign_keys": foreign_keys,
        "unique_keys": uniques,
        "indexes": plain_indexes,
    }


def _coerce_filter_value(column_type, raw):
    """Validate/coerce one filter value by the column's SQL type."""
    text = str(raw).strip()
    upper = column_type.upper()
    if not text or len(text) > 80:
        raise ValueError("Filter value too long or empty.")
    if any(t in upper for t in ("INT", "DECIMAL", "DOUBLE", "FLOAT")):
        try:
            return float(text) if "." in text else int(text)
        except ValueError:
            raise ValueError(f"'{text}' is not numeric.") from None
    if "DATE" in upper and "DATETIME" not in upper:
        try:
            time.strptime(text, "%Y-%m-%d")
        except ValueError:
            raise ValueError(f"'{text}' is not a YYYY-MM-DD date.") from None
        return text
    return text


def build_where(table, filters, columns=None):
    """Validated WHERE clause. Returns (sql_fragment, params).

    Equality filters must be whitelisted per table. Range pseudo-filters
    ``date_from`` / ``date_to`` are accepted only when the table actually
    has a ``date`` column.
    """
    allowed = _FILTERABLE.get(table, set())
    if columns is None:
        with get_cursor(dictionary=True) as cursor:
            columns = _table_columns(cursor, table)
    clauses, params = [], []
    for key, raw in (filters or {}).items():
        value = str(raw).strip() if raw is not None else ""
        if value == "":
            continue
        if key in ("date_from", "date_to"):
            if "date" not in columns:
                raise ValueError(f"Table '{table}' has no date column.")
            operator = ">=" if key == "date_from" else "<="
            try:
                time.strptime(value, "%Y-%m-%d")
            except ValueError:
                raise ValueError(
                    f"'{value}' is not a YYYY-MM-DD date."
                ) from None
            clauses.append(f"{_quote_ident('date')} {operator} %s")
            params.append(value)
            continue
        if key not in allowed:
            raise ValueError(f"Filtering '{table}' by '{key}' is not supported.")
        clauses.append(f"{_quote_ident(key)} = %s")
        params.append(value)
    sql = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    return sql, params


def get_table_rows(table, limit=100, offset=0, filters=None,
                   order_by=None, order_dir="asc"):
    """Bounded, filtered, sorted page of REAL stored rows."""
    if table not in TABLE_WHITELIST:
        raise UnknownTable(f"Unknown table '{table}'.")
    limit = max(1, min(int(limit), MAX_PAGE_LIMIT))
    offset = max(0, int(offset))
    order_dir = "DESC" if str(order_dir).lower() == "desc" else "ASC"

    with get_cursor(dictionary=True) as cursor:
        columns = _table_columns(cursor, table)
        where_sql, params = build_where(table, filters, columns)
        if order_by is not None and order_by not in columns:
            raise ValueError(
                f"Cannot sort by '{order_by}'. Sortable columns: "
                + ", ".join(columns)
            )
        order_sql = ""
        if order_by:
            order_sql = f" ORDER BY {_quote_ident(order_by)} {order_dir}"
        else:
            # Stable default: primary-key order when available.
            pk = [c["name"] for c in get_table_schema(table)["columns"]
                  if c["key"] == "PRI"]
            if pk:
                order_sql = f" ORDER BY {_quote_ident(pk[0])} ASC"

        cursor.execute(
            f"SELECT COUNT(*) AS n FROM {_quote_ident(table)}{where_sql}",
            params,
        )
        total = int(cursor.fetchone()["n"])

        page_sql = (
            f"SELECT * FROM {_quote_ident(table)}{where_sql}"
            f"{order_sql} LIMIT %s OFFSET %s"
        )
        cursor.execute(page_sql, (*params, limit, offset))
        raw_rows = cursor.fetchall()

    import datetime as _dt
    from decimal import Decimal

    def cell(value):
        if isinstance(value, Decimal):
            return float(value)
        if isinstance(value, (_dt.date, _dt.datetime)):
            return value.isoformat(sep=" ") if isinstance(
                value, _dt.datetime) else value.isoformat()
        if isinstance(value, _dt.timedelta):
            return str(value)
        return value

    rows = [{c: cell(r.get(c)) for c in r.keys()} for r in raw_rows]
    return {
        "table": table,
        "category": TABLE_WHITELIST[table]["category"],
        "columns": columns,
        "rows": rows,
        "total": total,
        "limit": limit,
        "offset": offset,
        "order_by": order_by,
        "order_dir": order_dir.lower(),
        "filters": {k: v for k, v in (filters or {}).items()
                    if str(v).strip() != ""},
    }


def get_database_stats():
    """DBMS-level statistics for the overview strip."""
    with get_cursor(dictionary=True) as cursor:
        cursor.execute("SELECT COUNT(*) AS n FROM datasets")
        datasets = int(cursor.fetchone()["n"])
        cursor.execute("SELECT COUNT(*) AS n FROM dataset_sources")
        imports = int(cursor.fetchone()["n"])
        cursor.execute(
            "SELECT MIN(date) AS oldest, MAX(date) AS newest FROM price_data"
        )
        span = cursor.fetchone()
        cursor.execute("SELECT COUNT(*) AS n FROM price_data")
        price_rows = int(cursor.fetchone()["n"])
        cursor.execute(
            """
            SELECT SUM(data_length + index_length) AS bytes
            FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = DATABASE()
            """
        )
        size_bytes = int(cursor.fetchone()["bytes"] or 0)
    return {
        "datasets": datasets,
        "market_imports": imports,
        "csv_imports": datasets - imports,
        "price_observations": price_rows,
        "oldest_observation": span["oldest"].isoformat()
        if span["oldest"] else None,
        "newest_observation": span["newest"].isoformat()
        if span["newest"] else None,
        "size_bytes": size_bytes,
        "size_pretty": f"{size_bytes / 1024:.1f} KiB"
        if size_bytes < 1024 * 1024 else f"{size_bytes / 1024 / 1024:.2f} MiB",
    }


def get_dataset_storage(dataset_id):
    """Per-dataset storage breakdown: raw rows + each derived cache."""
    with get_cursor(dictionary=True) as cursor:
        cursor.execute("SELECT * FROM datasets WHERE id = %s", (dataset_id,))
        dataset = cursor.fetchone()
        if dataset is None:
            raise LookupError(f"Dataset {dataset_id} not found.")

        def count(sql, args=(dataset_id,)):
            cursor.execute(sql, args)
            return int(cursor.fetchone()["n"])

        source_row = None
        cursor.execute(
            "SELECT * FROM dataset_sources WHERE dataset_id = %s",
            (dataset_id,),
        )
        row = cursor.fetchone()
        if row is not None:
            source_row = {
                k: (v.isoformat(sep=" ") if isinstance(v, __import__(
                    "datetime").datetime) else v)
                for k, v in dict(row).items()
            }

        cursor.execute(
            """
            SELECT COUNT(*) AS n FROM regime_assignments ra
            JOIN regime_models rm ON rm.id = ra.model_id
            WHERE rm.dataset_id = %s
            """,
            (dataset_id,),
        )
        assignment_count = int(cursor.fetchone()["n"])

        counts = {
            "datasets": 1,
            "price_data": count(
                "SELECT COUNT(*) AS n FROM price_data WHERE dataset_id = %s"),
            "dataset_sources": count(
                "SELECT COUNT(*) AS n FROM dataset_sources "
                "WHERE dataset_id = %s"),
            "analysis_results": count(
                "SELECT COUNT(*) AS n FROM analysis_results "
                "WHERE dataset_id = %s"),
            "fingerprints": count(
                "SELECT COUNT(*) AS n FROM fingerprints WHERE dataset_id = %s"),
            "analogue_matches": count(
                "SELECT COUNT(*) AS n FROM analogue_matches "
                "WHERE dataset_id = %s"),
            "regime_models": count(
                "SELECT COUNT(*) AS n FROM regime_models "
                "WHERE dataset_id = %s"),
            "regime_assignments": assignment_count,
            "intelligence_snapshots": count(
                "SELECT COUNT(*) AS n FROM intelligence_snapshots "
                "WHERE dataset_id = %s"),
        }

    created = dataset["created_at"]
    return {
        "dataset_id": dataset_id,
        "filename": dataset["filename"],
        "start_date": dataset["start_date"].isoformat(),
        "end_date": dataset["end_date"].isoformat(),
        "row_count": int(dataset["row_count"]),
        "latest_close": float(dataset["latest_close"]),
        "created_at": created.isoformat(sep=" ")
        if hasattr(created, "isoformat") else str(created),
        "source": source_row,
        "counts": counts,
    }


def run_integrity_check():
    """Read-only integrity verification. Never repairs or deletes data."""
    with get_cursor(dictionary=True) as cursor:
        checks = {}

        cursor.execute(
            """
            SELECT COUNT(*) AS n FROM (
                SELECT dataset_id, date FROM price_data
                GROUP BY dataset_id, date HAVING COUNT(*) > 1
            ) d
            """
        )
        checks["duplicate_dates"] = int(cursor.fetchone()["n"])

        cursor.execute(
            """
            SELECT COUNT(*) AS n FROM price_data p
            LEFT JOIN datasets d ON d.id = p.dataset_id
            WHERE d.id IS NULL
            """
        )
        checks["orphan_observations"] = int(cursor.fetchone()["n"])

        cursor.execute(
            """
            SELECT COUNT(*) AS n FROM price_data
            WHERE `open` <= 0 OR high <= 0 OR low <= 0 OR close <= 0
               OR volume < 0
               OR high < GREATEST(`open`, close)
               OR low > LEAST(`open`, close)
            """
        )
        checks["invalid_candles"] = int(cursor.fetchone()["n"])

        cursor.execute(
            """
            SELECT COUNT(*) AS n FROM datasets d
            LEFT JOIN (
                SELECT dataset_id, COUNT(*) AS actual
                FROM price_data GROUP BY dataset_id
            ) p ON p.dataset_id = d.id
            WHERE COALESCE(p.actual, 0) <> d.row_count
            """
        )
        checks["dataset_rowcount_mismatches"] = int(cursor.fetchone()["n"])

        cursor.execute(
            """
            SELECT d.id, d.filename FROM datasets d
            LEFT JOIN dataset_sources s ON s.dataset_id = d.id
            WHERE s.dataset_id IS NULL
            ORDER BY d.id
            """
        )
        without_provenance = [
            {"dataset_id": r["id"], "filename": r["filename"]}
            for r in cursor.fetchall()
        ]

    core_failures = sum(
        checks[key] for key in (
            "duplicate_dates", "orphan_observations",
            "invalid_candles", "dataset_rowcount_mismatches",
        )
    )
    return {
        "checks": checks,
        "datasets_without_provenance": without_provenance,
        "status": "HEALTHY" if core_failures == 0 else "ISSUES FOUND",
    }


# ---------------------------------------------------------------------------
# Developer SQL console (v0.12.1) — read-only raw queries, developer only.
#
# Defence in depth, in order:
#   1. route is behind require_developer (main.py),
#   2. single statement only, comments stripped before validation,
#   3. statement must start with SELECT / WITH / SHOW / DESCRIBE / EXPLAIN,
#   4. mutating keywords denied anywhere in the text (catches `WITH..DELETE`),
#   5. INTO OUTFILE / DUMPFILE / @var writes denied,
#   6. the session itself is SET TRANSACTION READ ONLY, so even a filter
#      bypass could not mutate data,
#   7. bounded: 10k chars, 15s server-side timeout, MAX_RAW_ROWS rows.
# ---------------------------------------------------------------------------

MAX_RAW_ROWS = 500
MAX_SQL_LENGTH = 10_000
QUERY_TIMEOUT_MS = 15_000

_ALLOWED_PREFIXES = ("select", "with", "show", "describe", "desc", "explain")

_DENIED_KEYWORDS = re.compile(
    r"\b(insert|update|delete|drop|alter|create|truncate|replace|call|"
    r"set|use|grant|revoke|kill|shutdown|lock|unlock|load|handler|"
    r"rename|optimize|analyze|cache|flush|purge|reset)\b",
    re.IGNORECASE,
)
_OUTFILE_PATTERN = re.compile(r"\binto\s+(outfile|dumpfile|@)", re.IGNORECASE)
_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)
_LINE_COMMENT = re.compile(r"(--[^\n]*|#[^\n]*)")


class QueryRejected(ValueError):
    """Caller-supplied SQL failed console validation."""


class QueryExecutionError(RuntimeError):
    """MySQL rejected or failed while running a validated query."""

    def __init__(self, message, errno=None):
        super().__init__(message)
        self.errno = errno


def _strip_sql_comments(sql):
    cleaned = _BLOCK_COMMENT.sub(" ", sql)
    cleaned = _LINE_COMMENT.sub(" ", cleaned)
    return cleaned.strip()


def validate_raw_query(sql):
    if not sql or not sql.strip():
        raise QueryRejected("Enter a SQL statement.")
    if len(sql) > MAX_SQL_LENGTH:
        raise QueryRejected(
            f"Statement too long ({len(sql)} chars; limit {MAX_SQL_LENGTH})."
        )
    cleaned = _strip_sql_comments(sql)
    if not cleaned:
        raise QueryRejected("Statement contains no executable SQL.")
    body = cleaned[:-1].rstrip() if cleaned.endswith(";") else cleaned
    if not body:
        raise QueryRejected("Statement contains no executable SQL.")
    if ";" in body:
        raise QueryRejected(
            "Only a single statement can be run per execution."
        )
    first_word = body.split(None, 1)[0].lower()
    if first_word not in _ALLOWED_PREFIXES:
        allowed = ", ".join(p.upper() for p in _ALLOWED_PREFIXES)
        raise QueryRejected(
            f"Read-only console: statements must start with one of "
            f"{allowed} (got '{first_word.upper()}')."
        )
    match = _DENIED_KEYWORDS.search(body)
    if match:
        raise QueryRejected(
            f"Read-only console: keyword '{match.group(0).upper()}' "
            "is not allowed."
        )
    if _OUTFILE_PATTERN.search(body):
        raise QueryRejected(
            "Read-only console: INTO OUTFILE / DUMPFILE / @variable "
            "is not allowed."
        )
    return body


def run_raw_query(sql):
    """Run one validated read-only statement; return Workbench-style output."""
    body = validate_raw_query(sql)
    connection = create_connection()
    try:
        cursor = connection.cursor(buffered=True)
        cursor.execute("SET SESSION TRANSACTION READ ONLY")
        try:
            cursor.execute(f"SET SESSION MAX_EXECUTION_TIME={QUERY_TIMEOUT_MS}")
        except DatabaseError:
            pass  # older MySQL without the optimizer hint — filters still apply
        started = time.perf_counter()
        try:
            cursor.execute(body)
        except Exception as exc:
            # mysql-connector raises its own hierarchy (ProgrammingError etc.);
            # wrap everything so the API layer can surface a clean 422.
            errno = getattr(exc, "errno", None)
            raise QueryExecutionError(str(exc), errno=errno) from exc
        elapsed_ms = round((time.perf_counter() - started) * 1000, 1)

        columns = [d[0] for d in cursor.description] if cursor.description else []
        fetched = cursor.fetchmany(MAX_RAW_ROWS + 1) if columns else []
        truncated = len(fetched) > MAX_RAW_ROWS
        fetched = fetched[:MAX_RAW_ROWS]
    finally:
        try:
            connection.rollback()
        except Exception:
            pass
        connection.close()

    import datetime as _dt
    from decimal import Decimal

    def cell(value):
        if isinstance(value, Decimal):
            return float(value)
        if isinstance(value, (_dt.date, _dt.datetime)):
            return value.isoformat(sep=" ") if isinstance(
                value, _dt.datetime) else value.isoformat()
        if isinstance(value, _dt.timedelta):
            return str(value)
        return value

    rows = [[cell(v) for v in row] for row in fetched]
    return {
        "columns": columns,
        "rows": rows,
        "row_count": len(rows),
        "truncated": truncated,
        "max_rows": MAX_RAW_ROWS,
        "elapsed_ms": elapsed_ms,
        "read_only": True,
    }
