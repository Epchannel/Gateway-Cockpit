import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
const dirs: string[] = [];
function setup() {
  const d = mkdtempSync(join(tmpdir(), "hnq-"));
  dirs.push(d);
  const s = join(d, "s.json");
  writeFileSync(
    s,
    JSON.stringify({
      upstreamApiKey: "upstream-secret-0123456789",
      sessionSecret: "session-secret-012345678901234567890123456789",
    }),
  );
  return loadConfig({
    API_HNQ_SECRETS_FILE: s,
    API_HNQ_DATABASE_PATH: join(d, "db.sqlite"),
    API_HNQ_PUBLIC_ORIGIN: "http://localhost:3000",
    API_HNQ_UPSTREAM_URL: "http://upstream/v1",
    API_HNQ_DEFAULT_RPM: "2",
    API_HNQ_DEFAULT_CONCURRENCY: "1",
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
describe("gateway", () => {
  it("authenticates, filters models, and never exposes upstream auth", async () => {
    const c = setup();
    const fetch = vi.fn(async (url: unknown, init: RequestInit) => {
      expect(init.headers).toMatchObject({
        Authorization: "Bearer upstream-secret-0123456789",
      });
      if (String(url).endsWith("/models"))
        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ id: "ok" }, { id: "no" }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      return new Response(
        JSON.stringify({
          object: "chat.completion",
          usage: { total_tokens: 2 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetch);
    const { app, store } = await buildApp({
      config: c,
      upstreamFetch: fetch as typeof fetch,
    });
    const raw = "hnq_test_test_test_test_test_test_test_test";
    store.createKey({
      name: "t",
      raw,
      allowAll: false,
      models: ["ok"],
      rpm: 2,
      concurrency: 1,
      expiresAt: null,
    });
    expect((await app.inject({ url: "/v1/models" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: "/v1/chat/completions",
          method: "POST",
          headers: { authorization: `Bearer ${raw}` },
          payload: { model: "no" },
        })
      ).statusCode,
    ).toBe(403);
    const ok = await app.inject({
      url: "/v1/chat/completions",
      method: "POST",
      headers: { authorization: `Bearer ${raw}` },
      payload: { model: "ok", messages: [] },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().object).toBe("chat.completion");
    await app.close();
    store.close();
  });
  it("passes SSE bytes through unchanged and handles revoke", async () => {
    const c = setup();
    const upstreamFetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(x) {
              x.enqueue(new TextEncoder().encode("data: one\n\n"));
              x.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              x.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    vi.stubGlobal("fetch", upstreamFetch);
    const { app, store } = await buildApp({
      config: c,
      upstreamFetch: upstreamFetch as typeof fetch,
    });
    const raw = "hnq_stream_stream_stream_stream_stream_stream";
    const id = store.createKey({
      name: "t",
      raw,
      allowAll: true,
      models: [],
      rpm: 2,
      concurrency: 1,
      expiresAt: null,
    });
    const r = await app.inject({
      url: "/v1/chat/completions",
      method: "POST",
      headers: { authorization: `Bearer ${raw}` },
      payload: { model: "ok", stream: true, messages: [] },
    });
    expect(r.body).toContain("[DONE]");
    expect(store.revokeKey(id)).toBe(true);
    expect(
      (
        await app.inject({
          url: "/v1/models",
          headers: { authorization: `Bearer ${raw}` },
        })
      ).statusCode,
    ).toBe(401);
    await app.close();
    store.close();
  });
});
