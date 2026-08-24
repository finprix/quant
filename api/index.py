"""Vercel Python runtime entrypoint for the Quant Vector API.

Exposes the EXISTING FastAPI application (backend/main.py) — this file is
a thin adapter only; all routes, engines and configuration live in the
backend package. Local development continues to use Uvicorn directly:

    cd backend && uvicorn main:app --reload
"""

import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from main import app  # noqa: E402  (FastAPI app served at /api/*)

# Vercel's Python builder looks for an `app` attribute in api/index.py.
