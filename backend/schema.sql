-- QUANT VECTOR schema (Turso / libSQL — SQLite dialect).
-- Idempotent: every statement uses IF NOT EXISTS; safe to re-run.
-- All tables are InnoDB-equivalent transactional tables with foreign keys,
-- cascade deletion, unique constraints and indexes preserved from the
-- original MySQL design. Enable foreign keys per connection (the app does).

CREATE TABLE IF NOT EXISTS datasets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    latest_close REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS price_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dataset_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    "open" REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume INTEGER NOT NULL,
    CONSTRAINT fk_price_data_dataset FOREIGN KEY (dataset_id)
        REFERENCES datasets (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_price_data_dataset_date
    ON price_data (dataset_id, date);

CREATE INDEX IF NOT EXISTS idx_price_data_dataset
    ON price_data (dataset_id, date);

CREATE TABLE IF NOT EXISTS analysis_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dataset_id INTEGER NOT NULL,
    metric_name TEXT NOT NULL,
    metric_value REAL,
    CONSTRAINT fk_analysis_results_dataset FOREIGN KEY (dataset_id)
        REFERENCES datasets (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_analysis_results_dataset
    ON analysis_results (dataset_id, metric_name);

CREATE TABLE IF NOT EXISTS fingerprints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dataset_id INTEGER NOT NULL,
    metric_name TEXT NOT NULL,
    metric_value REAL,
    computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_fingerprints_dataset FOREIGN KEY (dataset_id)
        REFERENCES datasets (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fingerprints_dataset
    ON fingerprints (dataset_id, metric_name);

CREATE TABLE IF NOT EXISTS analogue_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dataset_id INTEGER NOT NULL,
    match_rank INTEGER NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    distance REAL NOT NULL,
    similarity REAL NOT NULL,
    details TEXT,
    CONSTRAINT fk_analogue_matches_dataset FOREIGN KEY (dataset_id)
        REFERENCES datasets (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_analogue_matches_dataset
    ON analogue_matches (dataset_id, match_rank);

CREATE TABLE IF NOT EXISTS regime_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dataset_id INTEGER NOT NULL,
    window_size INTEGER NOT NULL,
    stride INTEGER NOT NULL,
    selected_k INTEGER NOT NULL,
    auto_selected INTEGER NOT NULL DEFAULT 1,
    n_windows INTEGER NOT NULL,
    silhouette REAL,
    davies_bouldin REAL,
    pca_components INTEGER NOT NULL DEFAULT 0,
    cumulative_explained_variance REAL,
    model_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_regime_models_dataset FOREIGN KEY (dataset_id)
        REFERENCES datasets (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_regime_models_dataset
    ON regime_models (dataset_id);

CREATE TABLE IF NOT EXISTS regime_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id INTEGER NOT NULL,
    window_start TEXT NOT NULL,
    window_end TEXT NOT NULL,
    window_end_index INTEGER NOT NULL,
    regime_id INTEGER NOT NULL,
    distance_to_centroid REAL,
    confidence REAL,
    pca_coordinates TEXT,
    CONSTRAINT fk_regime_assignments_model FOREIGN KEY (model_id)
        REFERENCES regime_models (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_regime_assignments_model
    ON regime_assignments (model_id, window_end_index);

CREATE TABLE IF NOT EXISTS intelligence_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dataset_id INTEGER NOT NULL,
    latest_market_date TEXT NOT NULL,
    param_hash TEXT NOT NULL,
    parameters TEXT,
    intelligence TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_intelligence_snapshots_dataset FOREIGN KEY (dataset_id)
        REFERENCES datasets (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_intelligence_snapshots_lookup
    ON intelligence_snapshots (dataset_id, param_hash, latest_market_date);

CREATE TABLE IF NOT EXISTS comparison_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    dataset_ids TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dataset_sources (
    dataset_id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    symbol TEXT NOT NULL,
    instrument_name TEXT,
    exchange TEXT,
    asset_type TEXT,
    currency TEXT,
    price_interval TEXT NOT NULL DEFAULT '1d',
    last_updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_dataset_sources_dataset FOREIGN KEY (dataset_id)
        REFERENCES datasets (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ingestion_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    symbol TEXT,
    provider TEXT,
    status TEXT NOT NULL,
    stage TEXT NOT NULL,
    observations INTEGER,
    result_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_ingestion_jobs_job_id UNIQUE (job_id)
);
