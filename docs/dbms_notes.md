# QUANT VECTOR — DBMS & MySQL Notes

Study notes connecting the project's database layer to core DBMS theory.

## 1. What a DBMS is, and why not just files

A **DBMS** (Database Management System) is software that stores, retrieves and governs data
with guarantees a file system cannot give: transactions (ACID), concurrent access, enforced
integrity rules, indexed lookups and a declarative query language.

QUANT VECTOR could have kept everything in CSVs or Python dicts. It uses MySQL because:

- **Integrity**: foreign keys guarantee no price row can reference a deleted dataset.
- **Efficient queries**: "all prices of dataset 5 ordered by date" is an index seek, not a
  full-file scan; datasets grow to thousands of rows each.
- **Structured aggregation**: counting rows, date ranges, metric upsert patterns.
- **Persistence across restarts** with concurrent-safe access from multiple requests.
- **JSON columns** let us cache whole model payloads without losing relational structure
  elsewhere — schema flexibility exactly where it is needed.

## 2. Relational model concepts as used here

| Concept | In QUANT VECTOR |
|---|---|
| Relation / table | `datasets`, `price_data`, `fingerprints`, ... |
| Tuple / row | one dataset, one OHLCV bar, one analogue match |
| Attribute / column | `close DECIMAL(18,6)`, `volume BIGINT`, ... |
| Domain | the SQL data type + CHECK-like constraints of each column |
| Primary key | surrogate auto-increment ids everywhere (`id`) |
| Foreign key | every child table references `datasets(id)` |
| Entity integrity | PKs are unique and never NULL |
| Referential integrity | FK constraints with `ON DELETE CASCADE` |

## 3. Normalization

- **1NF**: atomic values — no comma-separated lists inside cells. The deliberate exception:
  `comparison_presets.dataset_ids` is a JSON array. This is justified denormalization: presets
  must survive deletion of referenced datasets (no FK), are only read whole, and would
  otherwise need a junction table for trivial benefit.
- **2NF/3NF**: every non-key attribute depends on the key, the whole key, and nothing but the
  key. E.g. price rows carry only bar facts; dataset facts live once in `datasets`, not
  repeated per bar. Derived statistics are stored in their own tables rather than recomputed
  or duplicated into others.
- The metric tables (`analysis_results`, `fingerprints`) use an **EAV-style narrow design**
  (`metric_name`, `metric_value`): metrics evolve feature-by-feature without ALTER TABLE,
  at the cost of wider reads — acceptable because we always want all metrics of one dataset,
  served by the `(dataset_id, metric_name)` unique index.

## 4. Data types chosen

| Type | Used for | Why |
|---|---|---|
| `INT AUTO_INCREMENT` / `BIGINT` | surrogate keys | BIGINT for high-volume children (prices, assignments) |
| `DECIMAL(18,6)` | prices | exact decimal arithmetic; no float rounding on money values |
| `DOUBLE` | derived statistics | floats fine for computed analytics |
| `DATE` | trading dates | calendar semantics, comparable/indexable |
| `TIMESTAMP DEFAULT CURRENT_TIMESTAMP` | created_at | automatic audit stamp |
| `VARCHAR(n)` | names, labels | bounded strings |
| `CHAR(64)` | param_hash | fixed-length SHA-256 hex |
| `BOOLEAN` (= TINYINT(1)) | auto_selected | logical flag |
| `JSON` | payloads, caches | validated structured documents in MySQL 5.7+ |

Note `open` is a reserved word in MySQL — quoted as `` `open` `` throughout.

## 5. Keys and indexes

- Every table has a clustered **primary key**.
- **Composite index** `price_data(dataset_id, date)` serves both "full history of dataset"
  and "point lookup by date" (leftmost-prefix rule).
- **Unique indexes** double as correctness tools: `uq_analysis_results_metric`,
  `uq_fingerprints_metric`, `uq_analogue_matches_rank`, `uq_regime_assignment(model_id,
  window_end_index)`, `uq_intelligence_params(dataset_id, param_hash)` make re-runs
  idempotent and prevent duplicate cache entries.
- Indexes exist only where real queries hit them — no speculative indexes.

## 6. Relationships and cascade behaviour

One-to-many from `datasets` to all analytics children; `regime_models` →
`regime_assignments` is a second level. All use `ON DELETE CASCADE`: deleting a dataset
removes its prices, metrics, matches, models, timeline and cached intelligence in one
statement, with no orphan rows possible. Presets intentionally have **no FK** — they must
outlive the datasets they reference; the UI filters stale ids on load.

Rewrites use **delete-then-insert within one commit** (e.g. a new regime model replaces the
old row plus its assignments atomically), keeping "one current model per dataset" true.

## 7. SQL features exercised

- DDL: `CREATE DATABASE/TABLE IF NOT EXISTS`, inline index declarations (MySQL lacks
  `CREATE INDEX IF NOT EXISTS`), `ENGINE=InnoDB CHARSET=utf8mb4`.
- DML: parameterized `INSERT`, `SELECT` with joins/filters/ordering/limits, `UPDATE`,
  `DELETE`, aggregate-free range scans.
- Expressions like `ON UPDATE CURRENT_TIMESTAMP` maintain preset edit times automatically.

## 8. Security: SQL injection prevention

Every value reaches MySQL through **parameterized statements**
(`cursor.execute(sql, (params...))`, `%s` placeholders). User input (filenames, ids,
query parameters) is never string-concatenated into SQL. This is the single most important
database-security practice in the project; combined with FK constraints it also bounds what
any single request can touch.

## 9. Transactions and connection management

The backend opens one `mysql.connector.connect(**config)` per operation and calls
`connection.commit()` after write batches, so multi-statement rewrites succeed or fail as a
unit (atomicity). Reads run in autocommit mode implicitly. There is deliberately no
connection pool — this is a single-user local application, and per-call connections keep the
code simple and test-friendly.

## 10. Where logic lives

No stored procedures, triggers or views: business logic stays in Python (`database.py`
contains all SQL behind typed helper functions). That keeps the quant layer testable in
process (TestClient suites run against real MySQL), keeps portability between machines, and
avoids splitting one calculation across two languages.

## 11. ACID mapping

| Property | Realization |
|---|---|
| Atomicity | commit-per-operation around delete+insert rewrites; failed inserts leave no partial rows |
| Consistency | FKs, unique constraints, NOT NULLs, typed columns |
| Isolation | InnoDB default REPEATABLE READ; single-writer usage pattern |
| Durability | InnoDB redo log; committed uploads survive restarts |
