"""v0.11.0 Database Inspector tests.

Covers the read-only /database/* surface: whitelisting, schema introspection,
bounded pagination, validated filtering/sorting, statistics, per-dataset
storage breakdown, integrity checks and the absence of any SQL-execution
endpoint. Uses the real MySQL database (same convention as the other suites).
"""

from fastapi.testclient import TestClient

import db_inspector
import database
import test_support as _ts
from main import app


PASS = []
FAIL = []


def check(name, condition, detail=""):
    if condition:
        PASS.append(name)
        print(f"  ok    {name}")
    else:
        FAIL.append((name, detail))
        print(f"  FAIL  {name} :: {detail}")


def test_unit_level():
    print("\n[1] status + tables + stats")
    status = db_inspector.get_status()
    check("status connected", status["connected"] is True)
    check("status names database", status["database"] == "market_dna", str(status))
    check("status counts tables", status["tables_count"] >= 10)

    tables = db_inspector.list_tables()
    names = {t["name"] for t in tables}
    expected = set(db_inspector.TABLE_WHITELIST.keys())
    check("all whitelisted tables listed", names == expected,
          f"{sorted(expected ^ names)}")
    categories = {t["name"]: t["category"] for t in tables}
    check("price_data is raw", categories["price_data"] == "raw")
    check("fingerprints is cache", categories["fingerprints"] == "cache")
    check("row counts are ints",
          all(isinstance(t["rows"], int) for t in tables))

    stats = db_inspector.get_database_stats()
    check("stats datasets positive", stats["datasets"] >= 1)
    check("stats imports partition datasets",
          stats["market_imports"] + stats["csv_imports"] == stats["datasets"])
    check("stats size reported", stats["size_bytes"] > 0)
    with database.get_cursor() as cursor:
        cursor.execute("SELECT COUNT(*) FROM price_data")
        actual = cursor.fetchone()[0]
    check("stats price observations exact",
          stats["price_observations"] == actual,
          f"{stats['price_observations']} vs {actual}")

    print("\n[2] schema introspection")
    schema = db_inspector.get_table_schema("price_data")
    check("pk detected", schema["primary_key"] == ["id"])
    uq_names = {u["name"] for u in schema["unique_keys"]}
    check("unique dataset/date protection visible",
          "uq_price_data_dataset_date" in uq_names, str(uq_names))
    uq_cols = next(u["columns"] for u in schema["unique_keys"]
                   if u["name"] == "uq_price_data_dataset_date")
    check("unique columns correct", uq_cols == ["dataset_id", "date"], str(uq_cols))
    fks = {(f["column"], f["references_table"]) for f in schema["foreign_keys"]}
    check("fk to datasets visible", ("dataset_id", "datasets") in fks, str(fks))
    col_types = {c["name"]: c["type"] for c in schema["columns"]}
    check("decimal prices exposed", "decimal" in col_types.get("close", ""),
          str(col_types.get("close")))

    try:
        db_inspector.get_table_schema("information_schema.tables")
        check("schema whitelist blocks foreign tables", False)
    except db_inspector.UnknownTable:
        check("schema whitelist blocks foreign tables", True)

    print("\n[3] pagination / filters / sorting guards")
    page = db_inspector.get_table_rows("datasets", limit=2, offset=0)
    check("page bounded by limit", len(page["rows"]) <= 2)
    big = db_inspector.get_table_rows("price_data", limit=1000000)
    check("limit clamped to MAX_PAGE_LIMIT",
          len(big["rows"]) <= db_inspector.MAX_PAGE_LIMIT and
          big["limit"] == db_inspector.MAX_PAGE_LIMIT)
    if page["total"] > 2:
        page2 = db_inspector.get_table_rows("datasets", limit=2, offset=2)
        first_ids = [r["id"] for r in page["rows"]]
        second_ids = [r["id"] for r in page2["rows"]]
        check("offset moves the window", not set(first_ids) & set(second_ids))
    else:
        check("offset moves the window (skipped: tiny table)", True)

    with database.get_cursor(dictionary=True) as cursor:
        cursor.execute(
            "SELECT dataset_id FROM price_data GROUP BY dataset_id "
            "ORDER BY COUNT(*) DESC LIMIT 1"
        )
        target = cursor.fetchone()["dataset_id"]
    filtered = db_inspector.get_table_rows(
        "price_data", limit=50, filters={"dataset_id": target})
    check("dataset filter applied",
          filtered["total"] > 0 and
          all(r["dataset_id"] == target for r in filtered["rows"]))

    desc = db_inspector.get_table_rows(
        "price_data", limit=10, order_by="date", order_dir="desc")
    dates = [r["date"] for r in desc["rows"]]
    check("sort desc works", dates == sorted(dates, reverse=True), str(dates[:3]))

    try:
        db_inspector.get_table_rows("price_data", order_by="close; DROP TABLE x")
        check("sort identifier guarded", False)
    except ValueError:
        check("sort identifier guarded", True)

    try:
        db_inspector.get_table_rows("price_data", filters={"1=1": "1"})
        check("filter key whitelist enforced", False)
    except ValueError:
        check("filter key whitelist enforced", True)

    try:
        di_rows = db_inspector.get_table_rows(
            "price_data", filters={"date_from": "not-a-date"})
        raise AssertionError(di_rows)
    except ValueError:
        check("date filter format validated", True)

    try:
        db_inspector.get_table_rows("mysql.user")
        check("table whitelist enforced", False)
    except db_inspector.UnknownTable:
        check("table whitelist enforced", True)

    print("\n[4] storage breakdown + integrity")
    with database.get_cursor(dictionary=True) as cursor:
        cursor.execute(
            "SELECT d.id FROM datasets d JOIN price_data p ON p.dataset_id = d.id "
            "GROUP BY d.id ORDER BY COUNT(*) DESC LIMIT 1"
        )
        ds_id = cursor.fetchone()["id"]
    storage = db_inspector.get_dataset_storage(ds_id)
    with database.get_cursor() as cursor:
        cursor.execute(
            "SELECT COUNT(*) FROM price_data WHERE dataset_id = %s", (ds_id,))
        actual_prices = cursor.fetchone()[0]
    check("storage price count exact",
          storage["counts"]["price_data"] == actual_prices,
          f"{storage['counts']['price_data']} vs {actual_prices}")
    check("storage includes cache sections",
          {"fingerprints", "analogue_matches", "regime_models",
           "regime_assignments", "intelligence_snapshots"}
          <= set(storage["counts"].keys()))

    report = db_inspector.run_integrity_check()
    check("integrity structure complete",
          {"duplicate_dates", "orphan_observations", "invalid_candles",
           "dataset_rowcount_mismatches"} <= set(report["checks"].keys()))
    check("no duplicate dates under unique index",
          report["checks"]["duplicate_dates"] == 0, str(report))
    check("status vocabulary", report["status"] in ("HEALTHY", "ISSUES FOUND"))


def test_http_surface():
    print("\n[5] HTTP surface")
    with TestClient(app) as client:
        _ts.login(client)
        r = client.get("/database/status")
        body = r.json()
        check("GET /database/status", r.status_code == 200 and body["connected"])

        r = client.get("/database/tables")
        tables = r.json()["tables"]
        check("GET /database/tables", r.status_code == 200 and len(tables) >= 10)

        r = client.get("/database/tables/price_data/schema")
        check("GET table schema", r.status_code == 200
              and r.json()["primary_key"] == ["id"])

        r = client.get("/database/tables/price_data?dataset_id=166&limit=5")
        ok = r.status_code == 200 and (
            r.json()["total"] == 0 or
            all(row["dataset_id"] == 166 for row in r.json()["rows"]))
        check("GET rows with dataset filter", ok, r.text[:200])

        r = client.get("/database/tables/does_not_exist")
        check("unknown table -> 404", r.status_code == 404)

        r = client.get("/database/tables/price_data?limit=501")
        check("limit above max -> 422", r.status_code == 422)

        r = client.get("/database/tables/price_data?order_dir=sideways")
        check("bad sort direction -> 422", r.status_code == 422)

        r = client.get("/database/tables/price_data?order_by=(SELECT+1)")
        check("sql-ish sort column rejected", r.status_code in (400, 422),
              str(r.status_code))

        r = client.post("/database/sql", json={"query": "SELECT 1"})
        check("no arbitrary SQL endpoint exists", r.status_code == 404,
              str(r.status_code))

        r = client.post("/database/integrity")
        check("POST /database/integrity", r.status_code == 200
              and "status" in r.json())

        r = client.get("/database/datasets/999999/storage")
        check("unknown dataset storage -> 404", r.status_code == 404)


if __name__ == "__main__":
    test_unit_level()
    test_http_surface()
    print(f"\nRESULT: {'ALL TESTS PASSED' if not FAIL else str(len(FAIL)) + ' FAILURES'}")
    for name, detail in FAIL:
        print(f"  - {name}: {detail}")
    sys_exit = 0 if not FAIL else 1
    raise SystemExit(sys_exit)
