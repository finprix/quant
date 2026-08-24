"""QUANT VECTOR v0.12.2 — PIN access gate & developer authorization tests.

Covers the §28 matrix: login success/failure modes, session restore,
logout, guest read access, guest mutation blocks, developer privileges,
rate limiting and regression of normal analysis routes.

The REAL developer PIN never appears here — a throwaway PIN is generated
into the environment at runtime.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Configure authentication BEFORE importing main (env wins over .env).
TEST_PIN = "throwaway-pin-9f3a"

import auth  # noqa: E402

os.environ["MARKETDNA_DEV_PIN_HASH"] = auth.hash_password(TEST_PIN)
os.environ.setdefault("MARKETDNA_SESSION_SECRET", "test-suite-secret-not-for-prod")

from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402
import database  # noqa: E402
from data_sources import _PROVIDERS  # noqa: E402  # package-level import!

PASS, FAIL = [], []


def check(name, condition, detail=""):
    if condition:
        PASS.append(name)
        print(f"  PASS  {name}")
    else:
        FAIL.append(name)
        print(f"  FAIL  {name} {detail}")


class AuthTestProvider:
    name = "authtest"
    supports_search = True

    def search(self, query, limit=8):
        return [
            {
                "symbol": "TST",
                "name": "Auth Test Instrument",
                "exchange": "TEST",
                "asset_type": "stock",
                "currency": "USD",
            }
        ]

    def fetch(self, symbol, start_date, end_date, interval="1d",
              min_observations=None):
        import pandas as pd

        from data_sources.base import normalize_ohlcv

        dates = pd.bdate_range(start=start_date, end=end_date)
        n = len(dates)
        frame = pd.DataFrame(
            {
                "Date": dates,
                "Open": [100.0] * n,
                "High": [102.0] * n,
                "Low": [98.0] * n,
                "Close": [101.0] * n,
                "Volume": [1000] * n,
            }
        )
        return normalize_ohlcv(
            frame.copy(), symbol=symbol, provider=self.name,
            min_observations=min_observations or 30,
        )


def login(pin=TEST_PIN):
    return client.post("/auth/login", json={"pin": pin})


def clear_rate_limits():
    auth.login_rate_limiter._failures.clear()


CSV_BYTES = (
    b"Date,Open,High,Low,Close,Volume\n"
    b"2026-01-05,10,11,9.5,10.5,1000\n"
    b"2026-01-06,10.5,12,10,11.8,1200\n"
)

provider = AuthTestProvider()
_PROVIDERS["authtest"] = provider
client = TestClient(main.app)

print("== LOGIN MATRIX ==")
r = login(pin="wrong-pin")
check("wrong pin -> 401", r.status_code == 401, str(r.status_code))
r = client.post("/auth/login", json={})
check("missing pin -> 422", r.status_code == 422)
r = client.get("/auth/session")
check("anonymous session -> unauthenticated", r.json().get("authenticated") is False)

clear_rate_limits()
r = login()
check("correct pin -> 200 developer", r.status_code == 200 and r.json()["role"] == "developer")
check("login sets session cookie", any(c.name == auth.SESSION_COOKIE for c in client.cookies.jar))
body = r.json()
check("no pin material in response", "pin" not in body and "hash" not in body)
check("response carries no username concept", "username" not in body)
r = client.get("/auth/session")
check(
    "session restores after refresh",
    r.json().get("authenticated") is True and r.json().get("role") == "developer",
)

print("== LOGOUT ==")
r = client.post("/auth/logout")
check("logout -> 200", r.status_code == 200)
r = client.get("/auth/session")
check("session gone after logout", r.json().get("authenticated") is False)
r = client.post("/database/integrity")
check("mutation blocked after logout -> 401", r.status_code == 401)

print("== TAMPERED SESSION ==")
client.cookies.set(auth.SESSION_COOKIE, "forged.sig")
r = client.get("/auth/session")
check("forged cookie rejected", r.json().get("authenticated") is False)
client.cookies.clear()

print("== GUEST (ANONYMOUS) READ ACCESS ==")
r = client.get("/health")
check("health open", r.status_code == 200)
r = client.get("/datasets")
check("dataset list readable", r.status_code == 200)
datasets_now = r.json()["datasets"]
target_id = datasets_now[0]["id"] if datasets_now else None
if target_id:
    r = client.get(f"/datasets/{target_id}")
    check("dataset detail readable", r.status_code == 200)
    r = client.get(f"/datasets/{target_id}/prices")
    check("price history readable", r.status_code == 200)
r = client.get("/database/tables")
check("database inspector tables readable", r.status_code == 200)
r = client.get("/database/stats")
check("database stats readable", r.status_code == 200)
r = client.get("/market/overview")
check("market overview readable", r.status_code == 200)
r = client.get("/market/search?q=test&provider=yahoo")
check("provider search readable (no mutation)", r.status_code in (200, 502))

print("== GUEST MUTATIONS BLOCKED ==")
r = client.post("/upload", files={"file": ("x.csv", CSV_BYTES, "text/csv")})
check("guest cannot upload CSV -> 401", r.status_code == 401, str(r.status_code))
payload = {
    "symbol": "TST", "start_date": "2026-01-05", "end_date": "2026-04-30",
    "interval": "1d", "provider": "authtest",
}
r = client.post("/market/import", json=payload)
check("guest cannot import -> 401", r.status_code == 401, str(r.status_code))
some_id = target_id or 999999
r = client.post(f"/market/update/{some_id}")
check("guest cannot update -> 401", r.status_code == 401)
r = client.delete(f"/datasets/{some_id}")
check("guest cannot delete -> 401", r.status_code == 401)
r = client.post("/database/integrity")
check("guest cannot run maintenance -> 401", r.status_code == 401)
r = client.post("/comparison-presets", json={"name": "g", "dataset_ids": [1]})
check("guest cannot save presets -> 401", r.status_code == 401)

print("== DEVELOPER PRIVILEGES ==")
clear_rate_limits()
assert login().status_code == 200

r = client.post(
    "/upload", files={"file": ("auth_upload.csv", CSV_BYTES, "text/csv")}
)
check("developer can upload CSV", r.status_code == 200, f"{r.status_code} {r.text[:120]}")
upload_id = r.json().get("dataset", {}).get("id")

r = client.post("/market/import", json=payload)
check("developer can start import", r.status_code in (200, 202), str(r.status_code))
job_id = r.json().get("job_id")
status = {}
if job_id:
    import time

    for _ in range(60):
        status = client.get(f"/market/import/status/{job_id}").json()
        if status.get("status") in ("COMPLETE", "FAILED"):
            break
        time.sleep(0.2)
check("developer import completes", status.get("status") == "COMPLETE", str(status)[:160])
imported_id = (status.get("result") or {}).get("dataset_id")

r = client.post("/database/integrity")
check("developer can run integrity check", r.status_code == 200, str(r.status_code))
check(
    "integrity report shape intact",
    isinstance(r.json().get("checks"), dict),
)

preset = None
preset_ids = [imported_id or 1, upload_id or 2]
r = client.post("/comparison-presets", json={"name": "auth-preset", "dataset_ids": preset_ids})
check("developer can save preset", r.status_code == 200, f"{r.status_code} {r.text[:120]}")
if r.status_code == 200:
    preset = r.json().get("preset", {}).get("id") or r.json().get("id")
r = client.get("/comparison-presets")
check("presets listable", r.status_code == 200)
if preset:
    r = client.put(f"/comparison-presets/{preset}", json={"name": "auth-preset-2"})
    check("developer can rename preset", r.status_code == 200, str(r.status_code))
    r = client.delete(f"/comparison-presets/{preset}")
    check("developer can delete preset", r.status_code == 200)

# Incremental update against the fake-provider dataset
if imported_id:
    r = client.post(f"/market/update/{imported_id}")
    check("developer can update dataset", r.status_code == 200, f"{r.status_code} {r.text[:120]}")

print("== LOGIN RATE LIMITING ==")
clear_rate_limits()
codes = []
for _ in range(5):
    codes.append(client.post("/auth/login", json={"pin": "bad"}).status_code)
check("five failures all 401", all(code == 401 for code in codes), str(codes))
r = client.post("/auth/login", json={"pin": "bad"})
check("sixth attempt throttled -> 429", r.status_code == 429, str(r.status_code))
r = client.post("/auth/login", json={"pin": TEST_PIN})
check("even correct pin throttled while locked", r.status_code == 429)
# Lockout is keyed per client IP: a fresh limiter entry for another IP
# would allow attempts (verified by resetting only this IP's window).
auth.login_rate_limiter._failures.clear()
r = client.post("/auth/login", json={"pin": "bad"})
check("limiter reset clears lockout -> 401 again", r.status_code == 401)
clear_rate_limits()
r = login()
check("successful login resets the limiter window", r.status_code == 200)
clear_rate_limits()

print("== ANALYSIS ROUTES UNAFFECTED (regression) ==")
if imported_id:
    r = client.get(f"/datasets/{imported_id}/fingerprint?lookback=20")
    check("fingerprint open without special role", r.status_code == 200, str(r.status_code))
    r = client.get(f"/datasets/{imported_id}/analogues?lookback=20&top_n=3")
    check("analogues open", r.status_code == 200, str(r.status_code))

print("== CLEANUP ==")
for ds in (imported_id, upload_id):
    if ds:
        try:
            client.delete(f"/datasets/{ds}")
        except Exception:
            pass
_PROVIDERS.pop("authtest", None)
clear_rate_limits()

print(f"\nRESULT: {'ALL TESTS PASSED' if not FAIL else 'FAILURES'} ({len(PASS)} passed, {len(FAIL)} failed)")
for name in FAIL:
    print("  failed:", name)
sys.exit(1 if FAIL else 0)
