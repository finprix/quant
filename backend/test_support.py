"""Shared developer-session support for backend test suites.

Import this module BEFORE importing main so the throwaway environment
credentials are in place. The real deployment PIN never appears here.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import auth

SUITE_PIN = "suite-only-throwaway-pin"

if os.environ.get("MARKETDNA_DEV_PIN_HASH") is None:
    os.environ["MARKETDNA_DEV_PIN_HASH"] = auth.hash_password(SUITE_PIN)
os.environ.setdefault("MARKETDNA_SESSION_SECRET", "backend-suite-secret-not-for-prod")


def login(client):
    """Establish a developer session on the given TestClient."""
    auth.login_rate_limiter._failures.clear()
    response = client.post("/auth/login", json={"pin": SUITE_PIN})
    if response.status_code != 200:
        raise AssertionError(
            f"suite login failed: {response.status_code} {response.text[:120]}"
        )
    return response
