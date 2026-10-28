import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/db.js";

const directories: string[] = [];
const temporary = () => {
  const path = mkdtempSync(join(tmpdir(), "hnq-store-"));
  directories.push(path);
  return path;
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
});

describe("store durability", () => {
  it("rolls key and audit back together on a transaction fault, and writes exactly one actor audit", () => {
    const store = new Store(":memory:");
    store.createAdmin("owner", "hash");
    store.db.exec(
      "CREATE TRIGGER fail_models BEFORE INSERT ON api_key_models BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
    );
    expect(() =>
      store.createKey({
        name: "broken",
        raw: "hnq_transaction_test_012345678901234567890",
        allowAll: false,
        models: ["m"],
        rpm: 1,
        concurrency: 1,
        expiresAt: null,
        actor: 1,
      }),
    ).toThrow("injected failure");
    expect(store.listKeys()).toHaveLength(0);
    expect(store.audits()).toHaveLength(0);
    store.db.exec("DROP TRIGGER fail_models");
    const id = store.createKey({
      name: "good",
      raw: "hnq_transaction_good_012345678901234567890",
      allowAll: true,
      models: [],
      rpm: 1,
      concurrency: 1,
      expiresAt: null,
      actor: 1,
    });
    expect(
      (
        store.audits() as Array<{
          actor_user_id: number;
          action: string;
          target_id: string;
        }>
      )
        .filter((event) => event.action === "key.created")
        .map(({ actor_user_id, action, target_id }) => ({
          actor_user_id,
          action,
          target_id,
        })),
    ).toEqual([
      { actor_user_id: 1, action: "key.created", target_id: String(id) },
    ]);
    store.close();
  });
  it("uses ISO-aware retention, validates migration checksums, and creates a readable SQLite backup", async () => {
    const directory = temporary(),
      database = join(directory, "source.sqlite"),
      destination = join(directory, "backup.sqlite"),
      store = new Store(database);
    store.db
      .prepare(
        "INSERT INTO request_events(request_id,endpoint,status,streamed,duration_ms,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run("old", "/v1/x", 200, 0, 1, "2000-01-01T00:00:00.000Z");
    store.db
      .prepare(
        "INSERT INTO audit_events(action,target_type,target_id,metadata_json,created_at) VALUES(?,?,?,?,?)",
      )
      .run("old", "x", "x", "{}", "2000-01-01T00:00:00.000Z");
    store.cleanup();
    expect(store.requests()).toHaveLength(0);
    expect(store.audits()).toHaveLength(0);
    await store.backup(destination);
    store.close();
    const copied = new DatabaseSync(destination, { readOnly: true });
    expect(copied.prepare("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    copied.close();
    const checked = new Store(database);
    checked.db
      .prepare(
        "UPDATE schema_migrations SET checksum='tampered' WHERE version='001_initial.sql'",
      )
      .run();
    expect(() => checked.migrate()).toThrow("Migration checksum mismatch");
    checked.close();
  });
  it("keeps each usage aggregate nullable when any contributing request omits that metric", () => {
    const store = new Store(":memory:");
    store.event({
      requestId: "partial",
      keyId: null,
      endpoint: "/v1/responses",
      model: "m",
      status: 200,
      streamed: false,
      duration: 1,
      usage: { input_tokens: 2 },
    });
    store.event({
      requestId: "full",
      keyId: null,
      endpoint: "/v1/responses",
      model: "m",
      status: 200,
      streamed: false,
      duration: 1,
      usage: {
        input_tokens: 3,
        output_tokens: 4,
        total_tokens: 7,
        cached_tokens: 2,
        reasoning_tokens: 1,
      },
    });
    expect(store.usage()).toMatchObject([
      {
        inputTokens: 5,
        outputTokens: null,
        totalTokens: null,
        unknownUsage: 1,
        cachedTokens: null,
        reasoningTokens: null,
        unknownCachedUsage: 1,
        unknownReasoningUsage: 1,
      },
    ]);
    store.close();
  });
  it("keeps zero cached and reasoning tokens distinct from unavailable values", () => {
    const store = new Store(":memory:");
    for (const requestId of ["first", "second"])
      store.event({
        requestId,
        keyId: null,
        endpoint: "/v1/responses",
        model: "m",
        status: 200,
        streamed: false,
        duration: 1,
        usage: {
          input_tokens: 5,
          output_tokens: 1,
          total_tokens: 6,
          cached_tokens: 0,
          reasoning_tokens: 0,
        },
      });
    expect(store.usage()).toMatchObject([
      {
        inputTokens: 10,
        cachedTokens: 0,
        reasoningTokens: 0,
        unknownCachedUsage: 0,
        unknownReasoningUsage: 0,
      },
    ]);
    store.close();
  });
  it("persists a model catalog snapshot, marks missing models unavailable, and reactivates them", () => {
    const store = new Store(":memory:");
    const first = store.syncModels(
      [
        { id: "model-a", object: "model", owned_by: "cockpit", created: 1 },
        { id: "model-b", object: "model", owned_by: "cockpit" },
      ],
      null,
    );
    expect(first).toMatchObject({
      added: 2,
      updated: 0,
      unavailable: 0,
      count: 2,
    });
    const second = store.syncModels(
      [{ id: "model-a", object: "model", owned_by: "updated", created: 2 }],
      null,
    );
    expect(second).toMatchObject({
      added: 0,
      updated: 1,
      unavailable: 1,
      count: 1,
    });
    expect(store.models()).toMatchObject({
      lastCount: 1,
      data: [
        { model_id: "model-a", available: 1, owned_by: "updated" },
        { model_id: "model-b", available: 0 },
      ],
    });
    const third = store.syncModels(
      [
        { id: "model-a", object: "model", owned_by: "updated", created: 2 },
        { id: "model-b", object: "model", owned_by: "cockpit" },
      ],
      null,
    );
    expect(third).toMatchObject({ updated: 1, unavailable: 0, count: 2 });
    expect(
      store.models().data.map((model) => [model.model_id, model.available]),
    ).toEqual([
      ["model-a", 1],
      ["model-b", 1],
    ]);
    expect(() => store.syncModels([{ id: "dup" }, { id: "dup" }])).toThrow(
      "Duplicate upstream model ID",
    );
    expect(
      (store.audits() as Array<{ action: string }>).filter(
        (event) => event.action === "models.synced",
      ),
    ).toHaveLength(3);
    store.close();
  });
});
