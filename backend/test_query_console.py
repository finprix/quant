"""v0.12.1 SQL console tests.

Covers the developer-only /database/query endpoint: statement validation
(read-only prefixes, keyword denial, single statement, INTO OUTFILE denial,
comment handling), authorization (guest blocked), Workbench-parity output
shape and value equality vs the structured inspector endpoints, clean 422s
for MySQL failures, and the read-only guarantee (data untouched after
rejected attempts). Uses the real MySQL database like every other suite.
"""

from fastapi.testclient import TestClient

import db_inspector
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


def test_validator():
    print("\n[1] statement validator")
    allowed = [
        "SELECT * FROM datasets LIMIT 5",
        "  /* hi */ SELECT 1;",
        "WITH t AS (SELECT 1 AS x) SELECT x FROM t",
        "SHOW TABLES",
        "DESCRIBE price_data",
        "EXPLAIN SELECT 1",
        # UPDATE_TIME must not trip the keyword filter (word-boundary safe).
        "SELECT UPDATE_TIME FROM information_schema.TABLES LIMIT 1",
    ]
    denied = [
        "DELETE FROM datasets",
        "UPDATE datasets SET filename='x'",
        "WITH t AS (SELECT 1) DELETE FROM datasets",
        "DROP TABLE price_data",
        "SELECT 1; DROP TABLE datasets",
        "INSERT INTO datasets VALUES (1)",
        "SELECT * INTO OUTFILE '/tmp/x' FROM price_data",
        "SET @x=1",
        "CREATE TABLE t (id INT)",
        "-- SELECT 1\nDELETE FROM datasets",
        "/* SELECT */ DROP DATABASE market_dna",
        "",
        "   ",
        "/* only comment */",
    ]
    ok_allow = []
    for sql in allowed:
        try:
            db_inspector.validate_raw_query(sql)
            ok_allow.append(sql)
        except db_inspector.QueryRejected as exc:
            print(f"        unexpectedly rejected: {sql!r}: {exc}")
    check("all read-only statements accepted", len(ok_allow) == len(allowed),
          f"{len(ok_allow)}/{len(allowed)}")

    ok_deny = []
    for sql in denied:
        try:
            db_inspector.validate_raw_query(sql)
            print(f"        unexpectedly accepted: {sql!r}")
        except db_inspector.QueryRejected:
            ok_deny.append(sql)
    check("all dangerous statements rejected", len(ok_deny) == len(denied),
          f"{len(ok_deny)}/{len(denied)}")


def test_http_surface():
    print("\n[2] HTTP surface + parity + read-only guarantee")
    with TestClient(app) as client:
        r = client.post("/database/query", json={"sql": "SELECT 1"})
        check("guest blocked -> 401", r.status_code == 401, str(r.status_code))

        _ts.login(client)

        before = {d["id"]: d["row_count"]
                  for d in client.get("/datasets").json()["datasets"]}

        r = client.post(
            "/database/query",
            json={"sql": "SELECT id, filename FROM datasets ORDER BY id"},
        )
        body = r.json() if r.status_code == 200 else {}
        check("developer SELECT -> 200", r.status_code == 200, r.text[:120])
        check("workbench-style result shape", set(body) == {
            "columns", "rows", "row_count", "truncated",
            "max_rows", "elapsed_ms", "read_only",
        }, str(sorted(body)))
        check("columns echoed", body.get("columns") == ["id", "filename"],
              str(body.get("columns")))
        check("row_count matches library",
              body.get("row_count") == len(before), str(body.get("row_count")))
        check("read_only flag true", body.get("read_only") is True)
        check("elapsed_ms reported",
              isinstance(body.get("elapsed_ms"), (int, float)))

        # Parity: raw console output must equal the structured inspector.
        seed = next(iter(before)) if before else None
        if seed is not None:
            r_raw = client.post(
                "/database/query",
                json={"sql": (
                    f"SELECT * FROM price_data WHERE dataset_id={seed} "
                    "ORDER BY date DESC LIMIT 5"
                )},
            )
            raw = r_raw.json()
            view = client.get(
                "/database/tables/price_data",
                params={"dataset_id": seed, "order_by": "date",
                        "order_dir": "desc", "limit": 5},
            ).json()
            check("parity: same columns", raw["columns"] == view["columns"],
                  f"{raw['columns']} vs {view['columns']}")
            check("parity: same rows",
                  raw["rows"] == [[row[c] for c in view["columns"]]
                                  for row in view["rows"]],
                  f"{len(raw['rows'])} vs {len(view['rows'])}")

        r = client.post("/database/query", json={"sql": "SHOW TABLES"})
        check("SHOW TABLES works", r.status_code == 200 and any(
            "price_data" in str(cell)
            for row in r.json().get("rows", []) for cell in row))

        r = client.post("/database/query", json={"sql": "DESCRIBE datasets"})
        check("DESCRIBE works", r.status_code == 200
              and r.json()["columns"][0] == "Field")

        rejections = [
            ("DELETE FROM datasets", "guest-style mutation"),
            ("UPDATE datasets SET filename='x' WHERE id=1", "mutation"),
            ("DROP TABLE price_data", "ddl"),
            ("SELECT 1; DROP TABLE datasets", "multi-statement"),
            ("SELECT * INTO OUTFILE '/tmp/x' FROM price_data", "outfile"),
            ("SET @x=1", "session var"),
            ("", "empty"),
            ("   ", "whitespace only"),
            ("/* only comment */", "comment only"),
            ("SELECT nope FROM nothing", "missing table"),
            ("SELECT syntax error here from", "syntax error"),
        ]
        all_422 = True
        details = []
        for sql, label in rejections:
            r = client.post("/database/query", json={"sql": sql})
            if r.status_code != 422 or "detail" not in r.json():
                all_422 = False
                details.append(f"{label}->{r.status_code}")
        check("every rejection -> 422 with detail", all_422,
              ", ".join(details) or "")

        r = client.post(
            "/database/query", json={"sql": "SELECT nope FROM nothing"}
        )
        check("mysql errno surfaced", "1146" in r.json().get("detail", ""),
              r.text[:100])

        after = {d["id"]: d["row_count"]
                 for d in client.get("/datasets").json()["datasets"]}
        check("data untouched after all attempts", after == before)


if __name__ == "__main__":
    test_validator()
    test_http_surface()
    print(f"\nRESULT: {'ALL TESTS PASSED' if not FAIL else str(len(FAIL)) + ' FAILURES'}")
    for name, detail in FAIL:
        print(f"  - {name}: {detail}")
    raise SystemExit(0 if not FAIL else 1)
