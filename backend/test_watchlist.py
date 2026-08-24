"""Watchlist (tracked symbols) tests — v0.16.0.

Covers: guest read access, developer-only mutations, idempotent adds,
removal, 404s and quote-merge shape (network quotes mocked by not being
reached — the merge path tolerates provider failures).
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import test_support as _ts
from fastapi.testclient import TestClient
from main import app


PASS, FAIL = [], []


def check(name, condition, detail=""):
    if condition:
        PASS.append(name)
        print(f"  ok    {name}")
    else:
        FAIL.append(name)
        print(f"  FAIL  {name} {detail}")


def run():
    print("\n[1] watchlist authorization + CRUD")
    with TestClient(app) as client:
        r = client.get("/watchlist")
        check("guest can read watchlist", r.status_code == 200)

        r = client.post("/watchlist", json={"symbol": "AAPL"})
        check("guest cannot add -> 401", r.status_code == 401)

        _ts.login(client)

        # clean slate for deterministic counts
        for row in client.get("/watchlist").json().get("symbols", []):
            client.delete(f"/watchlist/{row['symbol']}")

        r = client.post("/watchlist", json={"symbol": "aapl"})
        check("add lowercases->uppercases", r.status_code == 200
              and r.json()["entry"]["symbol"] == "AAPL")

        r = client.post("/watchlist", json={"symbol": "AAPL", "note": "primary"})
        check("duplicate add is idempotent", r.status_code == 200)
        rows = client.get("/watchlist").json()["symbols"]
        check("still one AAPL row",
              sum(1 for x in rows if x["symbol"] == "AAPL") == 1)

        r = client.get("/watchlist")
        body = r.json()
        check("movers arrays present", "gainers" in body and "losers" in body)
        first = (body["symbols"] or [{}])[0]
        check("quote merge tolerated when provider fails",
              ("quote" in first) or ("quote_error" in first))

        r = client.post("/watchlist", json={})
        check("empty symbol -> 422", r.status_code == 422)
        r = client.post("/watchlist", json={"symbol": "X" * 40})
        check("oversized symbol -> 422", r.status_code == 422)

        r = client.delete("/watchlist/AAPL")
        check("remove tracked symbol", r.status_code == 200
              and r.json()["removed"] is True)
        r = client.delete("/watchlist/AAPL")
        check("remove unknown -> 404", r.status_code == 404)


if __name__ == "__main__":
    run()
    print(f"\nRESULT: {'ALL TESTS PASSED' if not FAIL else str(len(FAIL)) + ' FAILURES'} "
          f"({len(PASS)} passed, {len(FAIL)} failed)")
    raise SystemExit(0 if not FAIL else 1)
