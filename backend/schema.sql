-- MARKET DNA MySQL schema (idempotent; safe to re-run)
-- NOTE: indexes are declared inline because MySQL has no
-- CREATE INDEX IF NOT EXISTS.

CREATE DATABASE IF NOT EXISTS market_dna
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE market_dna;

CREATE TABLE IF NOT EXISTS datasets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    filename VARCHAR(255) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    row_count INT UNSIGNED NOT NULL,
    latest_close DECIMAL(18, 6) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS price_data (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    dataset_id INT NOT NULL,
    date DATE NOT NULL,
    `open` DECIMAL(18, 6) NOT NULL,
    high DECIMAL(18, 6) NOT NULL,
    low DECIMAL(18, 6) NOT NULL,
    close DECIMAL(18, 6) NOT NULL,
    volume BIGINT NOT NULL,
    UNIQUE INDEX uq_price_data_dataset_date (dataset_id, date),
    CONSTRAINT fk_price_data_dataset
        FOREIGN KEY (dataset_id) REFERENCES datasets (id)
        ON DELETE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS analysis_results (
    id INT AUTO_INCREMENT PRIMARY KEY,
    dataset_id INT NOT NULL,
    metric_name VARCHAR(100) NOT NULL,
    metric_value DOUBLE NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE INDEX uq_analysis_results_metric (dataset_id, metric_name),
    CONSTRAINT fk_analysis_results_dataset
        FOREIGN KEY (dataset_id) REFERENCES datasets (id)
        ON DELETE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS fingerprints (
    id INT AUTO_INCREMENT PRIMARY KEY,
    dataset_id INT NOT NULL,
    metric_name VARCHAR(100) NOT NULL,
    metric_value DOUBLE NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE INDEX uq_fingerprints_metric (dataset_id, metric_name),
    CONSTRAINT fk_fingerprints_dataset
        FOREIGN KEY (dataset_id) REFERENCES datasets (id)
        ON DELETE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS analogue_matches (
    id INT AUTO_INCREMENT PRIMARY KEY,
    dataset_id INT NOT NULL,
    match_rank INT NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    distance DOUBLE NOT NULL,
    similarity DOUBLE NOT NULL,
    details JSON NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE INDEX uq_analogue_matches_rank (dataset_id, match_rank),
    CONSTRAINT fk_analogue_matches_dataset
        FOREIGN KEY (dataset_id) REFERENCES datasets (id)
        ON DELETE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS regime_models (
    id INT AUTO_INCREMENT PRIMARY KEY,
    dataset_id INT NOT NULL,
    window_size INT NOT NULL,
    stride INT NOT NULL,
    selected_k INT NOT NULL,
    auto_selected BOOLEAN NOT NULL DEFAULT TRUE,
    n_windows INT NOT NULL,
    silhouette DOUBLE NULL,
    davies_bouldin DOUBLE NULL,
    pca_components INT NOT NULL,
    cumulative_explained_variance DOUBLE NULL,
    model_json JSON NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_regime_models_dataset (dataset_id),
    CONSTRAINT fk_regime_models_dataset
        FOREIGN KEY (dataset_id) REFERENCES datasets (id)
        ON DELETE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS regime_assignments (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    model_id INT NOT NULL,
    window_start DATE NOT NULL,
    window_end DATE NOT NULL,
    window_end_index INT NOT NULL,
    regime_id INT NOT NULL,
    distance_to_centroid DOUBLE NULL,
    confidence DOUBLE NULL,
    pca_coordinates JSON NULL,
    UNIQUE INDEX uq_regime_assignment (model_id, window_end_index),
    CONSTRAINT fk_regime_assignments_model
        FOREIGN KEY (model_id) REFERENCES regime_models (id)
        ON DELETE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS intelligence_snapshots (
    id INT AUTO_INCREMENT PRIMARY KEY,
    dataset_id INT NOT NULL,
    latest_market_date DATE NOT NULL,
    param_hash CHAR(64) NOT NULL,
    parameters JSON NULL,
    intelligence JSON NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE INDEX uq_intelligence_params (dataset_id, param_hash),
    CONSTRAINT fk_intelligence_dataset
        FOREIGN KEY (dataset_id) REFERENCES datasets (id)
        ON DELETE CASCADE
) ENGINE = InnoDB;

-- Saved comparison selections. dataset_ids is a JSON array so presets
-- survive dataset deletion (stale ids are filtered at read time by the
-- frontend instead of silently breaking rows). No authentication yet:
-- presets are global to this installation.
CREATE TABLE IF NOT EXISTS comparison_presets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    dataset_ids JSON NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                 ON UPDATE CURRENT_TIMESTAMP
) ENGINE = InnoDB;

-- Provenance for externally imported datasets (market-data providers).
-- Rows here mark a dataset as importable/updatable; plain CSV uploads have
-- no row and keep behaving exactly as before.
CREATE TABLE IF NOT EXISTS dataset_sources (
    dataset_id INT PRIMARY KEY,
    provider VARCHAR(40) NOT NULL,
    symbol VARCHAR(40) NOT NULL,
    instrument_name VARCHAR(160) NULL,
    exchange VARCHAR(60) NULL,
    asset_type VARCHAR(40) NULL,
    currency VARCHAR(12) NULL,
    price_interval VARCHAR(12) NOT NULL DEFAULT '1d',
    last_updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                 ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_dataset_sources_dataset
        FOREIGN KEY (dataset_id) REFERENCES datasets (id)
        ON DELETE CASCADE
) ENGINE = InnoDB;
