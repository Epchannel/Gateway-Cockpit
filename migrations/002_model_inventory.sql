CREATE TABLE upstream_models(
  model_id TEXT PRIMARY KEY,
  object_type TEXT,
  owned_by TEXT,
  upstream_created INTEGER,
  available INTEGER NOT NULL DEFAULT 1 CHECK(available IN (0,1)),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  unavailable_at TEXT
);
CREATE INDEX upstream_models_available ON upstream_models(available,model_id);
CREATE TABLE model_sync_state(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  last_synced_at TEXT,
  last_count INTEGER NOT NULL DEFAULT 0
);
INSERT INTO model_sync_state(singleton,last_count) VALUES(1,0);
CREATE TABLE model_mappings(
  public_model_id TEXT PRIMARY KEY,
  upstream_model_id TEXT NOT NULL REFERENCES upstream_models(model_id),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
