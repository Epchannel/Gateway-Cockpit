import { mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";
import { digest } from "./crypto.js";

export type Key = {
  id: number;
  name: string;
  prefix: string;
  key_hash: string;
  allow_all_models: number;
  rpm_limit: number;
  concurrency_limit: number;
  expires_at: string | null;
  revoked_at: string | null;
};
export type Usage = Record<string, number> | undefined;
export type UpstreamModel = {
  id: string;
  object?: string;
  owned_by?: string;
  created?: number;
};
type StoredModel = {
  model_id: string;
  object_type: string | null;
  owned_by: string | null;
  upstream_created: number | null;
  available: number;
  first_seen_at: string;
  last_seen_at: string;
  updated_at: string;
  unavailable_at: string | null;
};

const normalizedModels = (input: readonly UpstreamModel[]) => {
  if (!Array.isArray(input) || input.length > 1000)
    throw new Error("Invalid upstream model inventory");
  const models = new Map<string, Required<UpstreamModel>>();
  for (const item of input) {
    if (!item || typeof item !== "object")
      throw new Error("Invalid upstream model inventory");
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (
      !id ||
      id.length > 200 ||
      [...id].some((character) => character.charCodeAt(0) < 32)
    )
      throw new Error("Invalid upstream model ID");
    const object = typeof item.object === "string" ? item.object.trim() : "";
    const ownedBy =
      typeof item.owned_by === "string" ? item.owned_by.trim() : "";
    const created =
      typeof item.created === "number" &&
      Number.isSafeInteger(item.created) &&
      item.created >= 0
        ? item.created
        : 0;
    if (object.length > 100 || ownedBy.length > 200)
      throw new Error("Invalid upstream model metadata");
    if (models.has(id)) throw new Error("Duplicate upstream model ID");
    models.set(id, { id, object, owned_by: ownedBy, created });
  }
  return [...models.values()];
};

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, {
      timeout: 5000,
      enableForeignKeyConstraints: true,
    });
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.migrate();
  }
  migrate() {
    const dir = join(process.cwd(), "migrations");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    for (const file of existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => /^\d+_.+\.sql$/.test(name))
          .sort()
      : []) {
      const sql = readFileSync(join(dir, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = this.db
        .prepare("SELECT checksum FROM schema_migrations WHERE version=?")
        .get(file) as { checksum: string } | undefined;
      if (existing) {
        if (existing.checksum !== checksum)
          throw new Error(`Migration checksum mismatch: ${file}`);
        continue;
      }
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(sql);
        this.db
          .prepare(
            "INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)",
          )
          .run(file, checksum, new Date().toISOString());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }
  async backup(path: string) {
    return backup(this.db, path);
  }
  close() {
    this.db.close();
  }
  createAdmin(username: string, passwordHash: string) {
    this.db
      .prepare(
        "INSERT INTO admin_users(username,password_hash,enabled,created_at) VALUES(?,?,1,?)",
      )
      .run(username, passwordHash, new Date().toISOString());
  }
  admin(username: string) {
    return this.db
      .prepare("SELECT * FROM admin_users WHERE username=? AND enabled=1")
      .get(username) as
      { id: number; username: string; password_hash: string } | undefined;
  }
  session(userId: number, raw: string, csrf: string, expiry: string) {
    this.db
      .prepare(
        "INSERT INTO admin_sessions(token_hash,user_id,csrf_hash,expires_at,created_at) VALUES(?,?,?,?,?)",
      )
      .run(digest(raw), userId, digest(csrf), expiry, new Date().toISOString());
  }
  getSession(raw: string) {
    return this.db
      .prepare(
        "SELECT s.*,u.username FROM admin_sessions s JOIN admin_users u ON u.id=s.user_id WHERE s.token_hash=? AND julianday(s.expires_at)>julianday(?) AND u.enabled=1",
      )
      .get(digest(raw), new Date().toISOString()) as
      | { id: number; user_id: number; csrf_hash: string; username: string }
      | undefined;
  }
  deleteSession(raw: string) {
    this.db
      .prepare("DELETE FROM admin_sessions WHERE token_hash=?")
      .run(digest(raw));
  }
  createKey(input: {
    name: string;
    raw: string;
    allowAll: boolean;
    models: string[];
    rpm: number;
    concurrency: number;
    expiresAt: string | null;
    actor?: number | null;
  }) {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          "INSERT INTO api_keys(name,prefix,key_hash,allow_all_models,rpm_limit,concurrency_limit,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          input.name,
          input.raw.slice(0, 12),
          digest(input.raw),
          input.allowAll ? 1 : 0,
          input.rpm,
          input.concurrency,
          input.expiresAt,
          now,
        );
      const id = Number(result.lastInsertRowid),
        add = this.db.prepare(
          "INSERT OR IGNORE INTO api_key_models(api_key_id,model_id) VALUES(?,?)",
        );
      for (const model of input.models) add.run(id, model);
      this.audit(input.actor ?? null, "key.created", "api_key", String(id), {
        name: input.name,
      });
      this.db.exec("COMMIT");
      return id;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  key(raw: string) {
    return this.db
      .prepare(
        "SELECT * FROM api_keys WHERE key_hash=? AND revoked_at IS NULL AND (expires_at IS NULL OR julianday(expires_at)>julianday(?))",
      )
      .get(digest(raw), new Date().toISOString()) as Key | undefined;
  }
  allowed(key: Key, model: string) {
    return (
      key.allow_all_models === 1 ||
      !!this.db
        .prepare(
          "SELECT 1 FROM api_key_models WHERE api_key_id=? AND model_id=?",
        )
        .get(key.id, model)
    );
  }
  listKeys() {
    const keys = this.db
      .prepare(
        "SELECT id,name,prefix,allow_all_models,rpm_limit,concurrency_limit,expires_at,revoked_at,created_at,last_used_at FROM api_keys ORDER BY id DESC",
      )
      .all() as Array<Record<string, unknown>>;
    const models = this.db.prepare(
      "SELECT model_id FROM api_key_models WHERE api_key_id=? ORDER BY model_id",
    );
    return keys.map((key) => ({
      ...key,
      models: (models.all(key.id as number) as Array<{ model_id: string }>).map(
        (model) => model.model_id,
      ),
    }));
  }
  models() {
    const state = this.db
      .prepare(
        "SELECT last_synced_at,last_count FROM model_sync_state WHERE singleton=1",
      )
      .get() as
      { last_synced_at: string | null; last_count: number } | undefined;
    return {
      data: this.db
        .prepare(
          "SELECT model_id,object_type,owned_by,upstream_created,available,first_seen_at,last_seen_at,updated_at,unavailable_at FROM upstream_models ORDER BY available DESC,model_id ASC",
        )
        .all() as StoredModel[],
      lastSyncedAt: state?.last_synced_at ?? null,
      lastCount: state?.last_count ?? 0,
      mappings: this.db
        .prepare(
          "SELECT public_model_id,upstream_model_id,enabled,created_at,updated_at FROM model_mappings ORDER BY public_model_id",
        )
        .all(),
    };
  }
  syncModels(input: readonly UpstreamModel[], actor?: number | null) {
    const models = normalizedModels(input);
    const now = new Date().toISOString();
    let added = 0;
    let updated = 0;
    let unavailable = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare(
        "SELECT model_id,object_type,owned_by,upstream_created,available FROM upstream_models WHERE model_id=?",
      );
      const upsert = this.db.prepare(
        "INSERT INTO upstream_models(model_id,object_type,owned_by,upstream_created,available,first_seen_at,last_seen_at,updated_at,unavailable_at) VALUES(?,?,?,?,1,?,?,?,NULL) ON CONFLICT(model_id) DO UPDATE SET object_type=excluded.object_type,owned_by=excluded.owned_by,upstream_created=excluded.upstream_created,available=1,last_seen_at=excluded.last_seen_at,updated_at=excluded.updated_at,unavailable_at=NULL",
      );
      for (const model of models) {
        const before = current.get(model.id) as
          | {
              model_id: string;
              object_type: string | null;
              owned_by: string | null;
              upstream_created: number | null;
              available: number;
            }
          | undefined;
        if (!before) added += 1;
        else if (
          before.object_type !== (model.object || null) ||
          before.owned_by !== (model.owned_by || null) ||
          before.upstream_created !== (model.created || null) ||
          before.available !== 1
        )
          updated += 1;
        upsert.run(
          model.id,
          model.object || null,
          model.owned_by || null,
          model.created || null,
          now,
          now,
          now,
        );
      }
      const ids = models.map((model) => model.id);
      const absent = ids.length
        ? ` AND model_id NOT IN (${ids.map(() => "?").join(",")})`
        : "";
      const result = this.db
        .prepare(
          `UPDATE upstream_models SET available=0,unavailable_at=?,updated_at=? WHERE available=1${absent}`,
        )
        .run(now, now, ...ids);
      unavailable = Number(result.changes);
      this.db
        .prepare(
          "UPDATE model_sync_state SET last_synced_at=?,last_count=? WHERE singleton=1",
        )
        .run(now, models.length);
      this.audit(actor ?? null, "models.synced", "model_catalog", "upstream", {
        added,
        updated,
        unavailable,
        count: models.length,
      });
      this.db.exec("COMMIT");
      return {
        added,
        updated,
        unavailable,
        count: models.length,
        syncedAt: now,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  revokeKey(id: number, actor?: number | null) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          "UPDATE api_keys SET revoked_at=? WHERE id=? AND revoked_at IS NULL",
        )
        .run(new Date().toISOString(), id);
      if (result.changes)
        this.audit(actor ?? null, "key.revoked", "api_key", String(id), {});
      this.db.exec("COMMIT");
      return result.changes > 0;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  touchKey(id: number) {
    this.db
      .prepare("UPDATE api_keys SET last_used_at=? WHERE id=?")
      .run(new Date().toISOString(), id);
  }
  event(event: {
    requestId: string;
    keyId: number | null;
    endpoint: string;
    model: string | null;
    status: number;
    streamed: boolean;
    duration: number;
    usage?: Usage;
    errorCode?: string;
  }) {
    this.db
      .prepare(
        "INSERT INTO request_events(request_id,api_key_id,endpoint,model,status,streamed,duration_ms,usage_json,error_code,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        event.requestId,
        event.keyId,
        event.endpoint,
        event.model,
        event.status,
        event.streamed ? 1 : 0,
        event.duration,
        event.usage ? JSON.stringify(event.usage) : null,
        event.errorCode ?? null,
        new Date().toISOString(),
      );
  }
  requests() {
    return this.db
      .prepare(
        "SELECT r.*,k.name key_name,k.prefix key_prefix FROM request_events r LEFT JOIN api_keys k ON k.id=r.api_key_id ORDER BY r.id DESC LIMIT 100",
      )
      .all();
  }
  overview() {
    return this.db
      .prepare(
        "SELECT count(*) total, coalesce(sum(status BETWEEN 200 AND 399),0) success, avg(duration_ms) latency FROM request_events WHERE julianday(created_at)>julianday('now','-24 hours')",
      )
      .get();
  }
  usage() {
    const rows = this.db
      .prepare(
        "SELECT substr(r.created_at,1,10) day,r.api_key_id,k.name key_name,k.prefix key_prefix,r.model,r.usage_json FROM request_events r LEFT JOIN api_keys k ON k.id=r.api_key_id WHERE julianday(r.created_at)>julianday('now','-30 days') ORDER BY day DESC",
      )
      .all() as Array<Record<string, unknown>>;
    const out = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const id = `${row.day}|${row.api_key_id ?? ""}|${row.model ?? ""}`,
        item = out.get(id) ?? {
          day: row.day,
          keyId: row.api_key_id,
          keyName: row.key_name,
          keyPrefix: row.key_prefix,
          model: row.model,
          requests: 0,
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
          cachedTokens: null,
          reasoningTokens: null,
          unknownUsage: 0,
          unknownCachedUsage: 0,
          unknownReasoningUsage: 0,
          missingInput: 0,
          missingOutput: 0,
          missingTotal: 0,
          missingCached: 0,
          missingReasoning: 0,
        };
      item.requests = Number(item.requests) + 1;
      let parsed: Record<string, unknown> | undefined;
      try {
        parsed = row.usage_json
          ? (JSON.parse(String(row.usage_json)) as Record<string, unknown>)
          : undefined;
      } catch {
        parsed = undefined;
      }
      let partial = !parsed;
      for (const [field, names, missing, coreUsage] of [
        [
          "inputTokens",
          ["input_tokens", "prompt_tokens"],
          "missingInput",
          true,
        ],
        [
          "outputTokens",
          ["output_tokens", "completion_tokens"],
          "missingOutput",
          true,
        ],
        ["totalTokens", ["total_tokens"], "missingTotal", true],
        ["cachedTokens", ["cached_tokens"], "missingCached", false],
        ["reasoningTokens", ["reasoning_tokens"], "missingReasoning", false],
      ] as const) {
        const value = names
          .map((name) => parsed?.[name])
          .find(
            (value) =>
              typeof value === "number" &&
              Number.isSafeInteger(value) &&
              value >= 0,
          );
        if (typeof value === "number")
          item[field] = Number(item[field] ?? 0) + value;
        else {
          item[missing] = Number(item[missing]) + 1;
          if (coreUsage) partial = true;
        }
      }
      if (partial) item.unknownUsage = Number(item.unknownUsage) + 1;
      out.set(id, item);
    }
    return [...out.values()].map((item) => {
      if (Number(item.missingInput)) item.inputTokens = null;
      if (Number(item.missingOutput)) item.outputTokens = null;
      if (Number(item.missingTotal)) item.totalTokens = null;
      if (Number(item.missingCached)) item.cachedTokens = null;
      if (Number(item.missingReasoning)) item.reasoningTokens = null;
      item.unknownCachedUsage = Number(item.missingCached);
      item.unknownReasoningUsage = Number(item.missingReasoning);
      delete item.missingInput;
      delete item.missingOutput;
      delete item.missingTotal;
      delete item.missingCached;
      delete item.missingReasoning;
      return item;
    });
  }
  audit(
    actor: number | null,
    action: string,
    target: string,
    id: string,
    meta: unknown,
  ) {
    this.db
      .prepare(
        "INSERT INTO audit_events(actor_user_id,action,target_type,target_id,metadata_json,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        actor,
        action,
        target,
        id,
        JSON.stringify(meta),
        new Date().toISOString(),
      );
  }
  audits() {
    return this.db
      .prepare("SELECT * FROM audit_events ORDER BY id DESC LIMIT 100")
      .all();
  }
  cleanup() {
    this.db
      .prepare(
        "DELETE FROM request_events WHERE julianday(created_at)<julianday('now','-30 days')",
      )
      .run();
    this.db
      .prepare(
        "DELETE FROM audit_events WHERE julianday(created_at)<julianday('now','-90 days')",
      )
      .run();
    this.db
      .prepare(
        "DELETE FROM admin_sessions WHERE julianday(expires_at)<julianday('now')",
      )
      .run();
  }
}
