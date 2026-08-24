"""One-shot production database initializer.

Applies backend/schema.sql to whatever MySQL instance the environment
points at (MYSQL_* or DB_* variables — see database.py). Every statement
is idempotent (CREATE TABLE IF NOT EXISTS); nothing is ever dropped,
truncated or reset. Safe to re-run at any time.

Usage (from the backend/ directory):
    python init_db.py

On Railway this runs automatically at service boot via the app lifespan;
the CLI exists for manual initialization without starting the API.
"""

import sys

import database


def main():
    try:
        config = database.get_config()
        target = (
            f"{config['host']}:{config['port']} as {config['user']} "
            f"database '{config['database']}'"
        )
        print(f"Initializing Quant Vector schema on {target} ...")
        database.initialize_schema()
        print("Schema initialized successfully (all tables verified/created).")
        return 0
    except database.DatabaseError as exc:
        print(f"FAILED: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
