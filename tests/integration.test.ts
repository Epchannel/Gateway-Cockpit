import { afterEach, describe, expect, it } from "vitest";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { buildApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { passwordHash } from "../src/crypto.js";

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;
const dirs: string[] = [];
async function upstream(handler: Handler) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No upstream address");
  return { server, url: `http://127.0.0.1:${address.port}/v1` };
}
async function gateway(handler: Handler, extra: Record<string, string> = {}) {
  const fake = await upstream(handler),
    directory = mkdtempSync(join(tmpdir(), "hnq-http-"));
  dirs.push(directory);
  const secrets = join(directory, "secrets.json");
  writeFileSync(
    secrets,
    JSON.stringify({
      upstreamApiKey: "upstream-canary-secret-0123456789",
      sessionSecret: "session-canary-secret-012345678901234567890123",
    }),
  );
  const config = loadConfig({
    API_HNQ_SECRETS_FILE: secrets,
    API_HNQ_DATABASE_PATH: join(directory, "database.sqlite"),
    API_HNQ_PUBLIC_ORIGIN: "http://localhost:3000",
    API_HNQ_UPSTREAM_URL: fake.url,
    API_HNQ_DEFAULT_RPM: "50",
    API_HNQ_DEFAULT_CONCURRENCY: "2",
    ...extra,
  });
  const built = await buildApp({ config });
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  const address = built.app.server.address();
  if (!address || typeof address === "string")
    throw new Error("No gateway address");
  return { ...built, fake, url: `http://127.0.0.1:${address.port}` };
}
async function close(system: Awaited<ReturnType<typeof gateway>>) {
  system.app.server.closeAllConnections();
  await system.app.close();
  system.store.close();
  system.fake.server.closeAllConnections();
  await new Promise<void>((resolve) =>
    system.fake.server.close(() => resolve()),
  );
}
const json = (
  url: string,
  raw: string,
  payload: unknown,
  options: RequestInit = {},
) =>
  fetch(url, {
    ...options,
    method: "POST",
    headers: {
      authorization: `Bearer ${raw}`,
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
    body: JSON.stringify(payload),
  });
const incompleteJsonPost = (
  url: string,
  headers: Record<string, string>,
  contentLength = 15_000_000,
) => {
  let request: ReturnType<typeof httpRequest> | undefined,
    settled = false;
  const response = new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      const finish = (work: () => void) => {
        if (settled) return;
        settled = true;
        work();
      };
      request = httpRequest(
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(contentLength),
            ...headers,
          },
        },
        (result) => {
          let body = "";
          result.setEncoding("utf8");
          result.on("data", (chunk) => {
            body += chunk;
          });
          result.on("end", () =>
            finish(() => resolve({ status: result.statusCode ?? 0, body })),
          );
        },
      );
      request.once("error", (cause) => finish(() => reject(cause)));
      request.write('{"model":"m","input":"');
    },
  );
  return { response, abort: () => request?.destroy() };
};
const declaredJsonPost = async (
  url: string,
  headers: Record<string, string>,
  payload: unknown,
) => {
  const body = JSON.stringify(payload);
  const request = incompleteJsonPost(url, headers, Buffer.byteLength(body));
  try {
    return await request.response;
  } finally {
    request.abort();
  }
};
afterEach(() => {
  for (const directory of dirs.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
});

describe("real HTTP gateway", () => {
  it("preserves fragmented Chat and Responses SSE while recording only terminal numeric usage", async () => {
    const system = await gateway((request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (request.url?.endsWith("/chat/completions")) {
        response.write('data: {"choices":[{"delta":{"content":"kept"}}]');
        response.end(
          '}\n\ndata: {"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5,"prompt_tokens_details":{"cached_tokens":1},"completion_tokens_details":{"reasoning_tokens":2}}}\n\ndata: [DONE]\n\n',
        );
        return;
      }
      response.write(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"not persisted"}\n\n',
      );
      response.write('data: {"usage":{"input_tokens":2,');
      response.end(
        '"output_tokens":3,"total_tokens":5,"input_tokens_details":{"cached_tokens":1},"output_tokens_details":{"reasoning_tokens":2}}}\n\ndata: [DONE]\n\n',
      );
    });
    const raw = "hnq_real_stream_test_key_012345678901234567890";
    system.store.createKey({
      name: "stream",
      raw,
      allowAll: true,
      models: [],
      rpm: 50,
      concurrency: 2,
      expiresAt: null,
    });
    const response = await json(`${system.url}/v1/responses`, raw, {
      model: "m",
      stream: true,
      input: "secret prompt",
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("response.output_text.delta");
    expect(body).toContain("data: [DONE]");
    const chat = await json(`${system.url}/v1/chat/completions`, raw, {
      model: "m",
      stream: true,
      messages: [],
    });
    expect(await chat.text()).toContain("data: [DONE]");
    expect(
      (
        system.store.requests() as Array<{
          endpoint: string;
          usage_json: string;
        }>
      ).find((entry) => entry.endpoint === "/v1/chat/completions")?.usage_json,
    ).toBe(
      '{"input_tokens":2,"output_tokens":3,"total_tokens":5,"cached_tokens":1,"reasoning_tokens":2}',
    );
    const event = (
      system.store.requests() as Array<{ endpoint: string; usage_json: string }>
    ).find((entry) => entry.endpoint === "/v1/responses")!;
    expect(event.usage_json).toBe(
      '{"input_tokens":2,"output_tokens":3,"total_tokens":5,"cached_tokens":1,"reasoning_tokens":2}',
    );
    expect(JSON.stringify(event)).not.toContain("not persisted");
    await close(system);
  });

  it("normalizes cached and reasoning usage from JSON responses without storing nested details", async () => {
    const system = await gateway((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            total_tokens: 14,
            cached_tokens: 7,
            reasoning_tokens: 1,
            input_tokens_details: { cached_tokens: 6 },
            output_tokens_details: { reasoning_tokens: 2 },
          },
        }),
      );
    });
    const raw = "hnq_json_usage_test_key_012345678901234567890";
    system.store.createKey({
      name: "json usage",
      raw,
      allowAll: true,
      models: [],
      rpm: 50,
      concurrency: 2,
      expiresAt: null,
    });
    const response = await json(`${system.url}/v1/responses`, raw, {
      model: "m",
      input: "secret prompt",
    });
    expect(response.status).toBe(200);
    const event = system.store.requests()[0] as { usage_json: string };
    expect(event.usage_json).toBe(
      '{"input_tokens":10,"output_tokens":4,"total_tokens":14,"cached_tokens":7,"reasoning_tokens":1}',
    );
    expect(event.usage_json).not.toContain("details");
    await close(system);
  });

  it("sanitizes upstream failures, rejects redirect/invalid input, and bounds a nonstream response", async () => {
    let oversizedDisconnected = false;
    const system = await gateway(
      async (request, response) => {
        if (request.url?.endsWith("/models")) {
          response.writeHead(302, { location: "http://evil.invalid" });
          response.end();
          return;
        }
        let body = "";
        for await (const chunk of request) body += chunk;
        if (body.includes('"large"')) {
          response.writeHead(200, { "content-type": "application/json" });
          response.once("close", () => {
            oversizedDisconnected = true;
          });
          response.write(`{"x":"${"x".repeat(2048)}"}`);
          return;
        }
        if (body.includes('"sse-error"')) {
          response.writeHead(500, { "content-type": "text/event-stream" });
          response.end("data: upstream-canary-secret-0123456789\n\n");
          return;
        }
        if (body.includes('"empty"')) {
          response.writeHead(204);
          response.end();
          return;
        }
        if (body.includes('"not-modified"')) {
          response.writeHead(304);
          response.end();
          return;
        }
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          '{"error":{"message":"upstream-canary-secret-0123456789"}}',
        );
      },
      {
        API_HNQ_MAX_UPSTREAM_RESPONSE_BYTES: "1024",
        API_HNQ_BODY_LIMIT: "1048576",
      },
    );
    const raw = "hnq_real_errors_test_key_012345678901234567890";
    system.store.createKey({
      name: "errors",
      raw,
      allowAll: true,
      models: [],
      rpm: 50,
      concurrency: 2,
      expiresAt: null,
    });
    const failed = await json(`${system.url}/v1/chat/completions`, raw, {
      model: "m",
      messages: [],
    });
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain("canary");
    const large = await json(`${system.url}/v1/chat/completions`, raw, {
      model: "large",
      messages: [],
    });
    expect(large.status).toBe(502);
    expect((await large.json()).error.code).toBe("upstream_response_too_large");
    await delay(30);
    expect(oversizedDisconnected).toBe(true);
    const sseError = await json(`${system.url}/v1/chat/completions`, raw, {
      model: "sse-error",
      stream: true,
      messages: [],
    });
    expect(sseError.status).toBe(502);
    expect(await sseError.text()).not.toContain("canary");
    const empty = await json(`${system.url}/v1/chat/completions`, raw, {
      model: "empty",
      messages: [],
    });
    expect(empty.status).toBe(502);
    const notModified = await json(`${system.url}/v1/chat/completions`, raw, {
      model: "not-modified",
      messages: [],
    });
    expect(notModified.status).toBe(502);
    expect((await fetch(`${system.url}/healthz`)).status).toBe(200);
    const redirect = await fetch(`${system.url}/v1/models`, {
      headers: { authorization: `Bearer ${raw}` },
    });
    expect(redirect.status).toBe(502);
    const malformed = await fetch(`${system.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${raw}`,
        "content-type": "application/json",
      },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    const media = await fetch(`${system.url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${raw}`, "content-type": "text/plain" },
      body: "x",
    });
    expect(media.status).toBe(415);
    const oversized = await declaredJsonPost(
      `${system.url}/v1/chat/completions`,
      { authorization: `Bearer ${raw}` },
      {
        model: "m",
        messages: [{ role: "user", content: "x".repeat(1_100_000) }],
      },
    );
    expect(oversized.status).toBe(413);
    expect(JSON.parse(oversized.body)).toMatchObject({
      error: { code: "body_too_large", message: "Request body too large" },
    });
    expect((await fetch(`${system.url}/v1/nope`)).status).toBe(404);
    expect((await fetch(`${system.url}/admin/api/nope`)).status).toBe(404);
    expect(JSON.stringify(system.store.requests())).not.toContain("canary");
    await close(system);
  });

  it("applies the configured body cap only to public generation routes", async () => {
    let forwarded = 0;
    const system = await gateway(
      (_request, response) => {
        forwarded += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      },
      { API_HNQ_BODY_LIMIT: "2048" },
    );
    const raw = "hnq_body_limit_test_key_012345678901234567890";
    system.store.createKey({
      name: "body limit",
      raw,
      allowAll: true,
      models: [],
      rpm: 50,
      concurrency: 2,
      expiresAt: null,
    });

    const responsesUnderLimit = await json(`${system.url}/v1/responses`, raw, {
      model: "m",
      input: "x".repeat(1_500),
    });
    const chatUnderLimit = await json(
      `${system.url}/v1/chat/completions`,
      raw,
      { model: "m", messages: [{ role: "user", content: "x".repeat(1_400) }] },
    );
    expect(responsesUnderLimit.status).toBe(200);
    expect(chatUnderLimit.status).toBe(200);

    for (const [url, payload] of [
      [`${system.url}/v1/responses`, { model: "m", input: "x".repeat(2_200) }],
      [
        `${system.url}/v1/chat/completions`,
        {
          model: "m",
          messages: [{ role: "user", content: "x".repeat(2_100) }],
        },
      ],
    ] as const) {
      const response = await declaredJsonPost(
        url,
        { authorization: `Bearer ${raw}` },
        payload,
      );
      expect(response.status).toBe(413);
      expect(JSON.parse(response.body)).toMatchObject({
        error: { code: "body_too_large", message: "Request body too large" },
      });
    }
    expect(forwarded).toBe(2);

    const admin = await declaredJsonPost(
      `${system.url}/admin/api/session`,
      { origin: "http://localhost:3000" },
      {
        username: "admin",
        password: "x".repeat(1_100_000),
      },
    );
    expect(admin.status).toBe(413);
    expect(JSON.parse(admin.body)).toMatchObject({
      error: { code: "body_too_large", message: "Request body too large" },
    });
    expect(forwarded).toBe(2);
    await close(system);
  });

  it("admits generation keys before parsing and releases the gate after parser failures", async () => {
    let forwarded = 0;
    const system = await gateway(
      (_request, response) => {
        forwarded += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      },
      { API_HNQ_BODY_LIMIT: "2048" },
    );
    const raw = "hnq_preparse_admission_key_012345678901234567890";
    system.store.createKey({
      name: "preparse admission",
      raw,
      allowAll: true,
      models: [],
      rpm: 50,
      concurrency: 1,
      expiresAt: null,
    });

    for (const headers of [
      {},
      { authorization: "Bearer invalid-key" },
    ] as Array<Record<string, string>>) {
      const slow = incompleteJsonPost(`${system.url}/v1/responses`, headers);
      const rejected = await slow.response;
      expect(rejected.status).toBe(401);
      expect(JSON.parse(rejected.body)).toMatchObject({
        error: { code: "invalid_api_key" },
      });
      slow.abort();
    }
    expect(forwarded).toBe(0);

    const held = incompleteJsonPost(
      `${system.url}/v1/responses`,
      {
        authorization: `Bearer ${raw}`,
      },
      1_000,
    );
    await delay(25);
    const limited = await json(`${system.url}/v1/responses`, raw, {
      model: "m",
      input: "small",
    });
    expect(limited.status).toBe(429);
    expect(forwarded).toBe(0);
    held.abort();
    await held.response.catch(() => undefined);
    await delay(25);

    const malformed = await fetch(`${system.url}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${raw}`,
        "content-type": "application/json",
      },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    const afterMalformed = await json(`${system.url}/v1/responses`, raw, {
      model: "m",
      input: "small",
    });
    expect(afterMalformed.status).toBe(200);

    const oversized = await declaredJsonPost(
      `${system.url}/v1/responses`,
      { authorization: `Bearer ${raw}` },
      { model: "m", input: "x".repeat(2_200) },
    );
    expect(oversized.status).toBe(413);
    const afterOversized = await json(`${system.url}/v1/responses`, raw, {
      model: "m",
      input: "small",
    });
    expect(afterOversized.status).toBe(200);
    expect(forwarded).toBe(2);
    await close(system);
  });

  it("cancels upstream before headers and mid-stream, then releases concurrency exactly once", async () => {
    let disconnected = 0;
    const system = await gateway(
      async (request, response) => {
        response.once("close", () => {
          disconnected += 1;
        });
        let body = "";
        for await (const chunk of request) body += chunk;
        if (body.includes('"slow"')) {
          await delay(500);
          if (!response.destroyed) response.end('{"ok":true}');
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: first\n\n");
        await delay(500);
        if (!response.destroyed) response.end("data: [DONE]\n\n");
      },
      {
        API_HNQ_DEFAULT_CONCURRENCY: "1",
        API_HNQ_UPSTREAM_TOTAL_TIMEOUT_MS: "2000",
      },
    );
    const raw = "hnq_real_cancel_test_key_012345678901234567890";
    system.store.createKey({
      name: "cancel",
      raw,
      allowAll: true,
      models: [],
      rpm: 50,
      concurrency: 1,
      expiresAt: null,
    });
    const before = new AbortController();
    const pending = json(
      `${system.url}/v1/chat/completions`,
      raw,
      { model: "slow", messages: [] },
      { signal: before.signal },
    );
    await delay(40);
    before.abort();
    await expect(pending).rejects.toThrow();
    await delay(80);
    expect(disconnected).toBeGreaterThanOrEqual(1);
    const heldAbort = new AbortController();
    const held = json(
      `${system.url}/v1/chat/completions`,
      raw,
      { model: "slow", messages: [] },
      { signal: heldAbort.signal },
    );
    await delay(30);
    const limited = await json(`${system.url}/v1/chat/completions`, raw, {
      model: "m",
      messages: [],
    });
    expect(limited.status).toBe(429);
    heldAbort.abort();
    await expect(held).rejects.toThrow();
    await delay(40);
    const stream = await json(`${system.url}/v1/chat/completions`, raw, {
      model: "m",
      stream: true,
      messages: [],
    });
    expect(stream.status).toBe(200);
    await stream.body?.cancel();
    await delay(80);
    expect(disconnected).toBeGreaterThanOrEqual(2);
    const next = await json(`${system.url}/v1/chat/completions`, raw, {
      model: "m",
      messages: [],
    });
    expect(next.status).toBe(200);
    await next.body?.cancel();
    await delay(30);
    await close(system);
  });

  it("enforces header, idle and total timers without writing JSON after stream headers", async () => {
    const system = await gateway(
      async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        if (body.includes('"header"')) {
          await delay(120);
          response.end('{"late":true}');
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: first\n\n");
        if (body.includes('"idle"')) {
          await delay(120);
          response.end("data: late\n\n");
          return;
        }
        await delay(35);
        response.write("data: second\n\n");
        await delay(35);
        response.write("data: third\n\n");
        await delay(35);
        response.end("data: fourth\n\n");
      },
      {
        API_HNQ_UPSTREAM_HEADER_TIMEOUT_MS: "40",
        API_HNQ_UPSTREAM_IDLE_TIMEOUT_MS: "40",
        API_HNQ_UPSTREAM_TOTAL_TIMEOUT_MS: "80",
      },
    );
    const raw = "hnq_real_timeout_test_key_012345678901234567890";
    system.store.createKey({
      name: "timeout",
      raw,
      allowAll: true,
      models: [],
      rpm: 50,
      concurrency: 2,
      expiresAt: null,
    });
    const headers = await json(`${system.url}/v1/chat/completions`, raw, {
      model: "header",
      messages: [],
    });
    expect(headers.status).toBe(504);
    const idle = await json(`${system.url}/v1/chat/completions`, raw, {
      model: "idle",
      stream: true,
      messages: [],
    });
    expect(idle.status).toBe(200);
    await expect(idle.text()).rejects.toThrow();
    const total = await json(`${system.url}/v1/chat/completions`, raw, {
      model: "total",
      stream: true,
      messages: [],
    });
    expect(total.status).toBe(200);
    await expect(total.text()).rejects.toThrow();
    await delay(50);
    const events = system.store.requests() as Array<{
      error_code: string | null;
    }>;
    expect(
      events.filter((event) => event.error_code === "upstream_timeout"),
    ).toHaveLength(3);
    await close(system);
  });

  it("stops a backpressured upstream when a slow reader disconnects", async () => {
    let upstreamClosed = false,
      upstreamBackpressured = false;
    const system = await gateway(
      (_request, response) => {
        response.once("close", () => {
          upstreamClosed = true;
        });
        response.writeHead(200, { "content-type": "text/event-stream" });
        const write = () => {
          for (let index = 0; index < 200; index += 1) {
            if (!response.write(`data: ${"x".repeat(32_000)}\n\n`)) {
              upstreamBackpressured = true;
              response.once("drain", write);
              return;
            }
          }
          response.end("data: [DONE]\n\n");
        };
        write();
      },
      { API_HNQ_UPSTREAM_TOTAL_TIMEOUT_MS: "5000" },
    );
    const raw = "hnq_real_pressure_test_key_012345678901234567890";
    system.store.createKey({
      name: "pressure",
      raw,
      allowAll: true,
      models: [],
      rpm: 50,
      concurrency: 1,
      expiresAt: null,
    });
    const response = await json(`${system.url}/v1/chat/completions`, raw, {
      model: "pressure",
      stream: true,
      messages: [],
    });
    expect(response.status).toBe(200);
    await delay(80);
    await response.body?.cancel();
    await delay(100);
    expect(upstreamBackpressured).toBe(true);
    expect(upstreamClosed).toBe(true);
    await close(system);
  });

  it("enforces admin sessions, CSRF/origin, throttle, disabled accounts, expiry normalization, and one audit per key mutation", async () => {
    const system = await gateway((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    system.store.createAdmin("admin", passwordHash("very-long-admin-password"));
    const login = async (
      password = "very-long-admin-password",
      username = "admin",
    ) =>
      fetch(`${system.url}/admin/api/session`, {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({ username, password }),
      });
    const first = await login();
    expect(first.status).toBe(200);
    const cookie = first.headers.get("set-cookie")!.split(";")[0],
      session = (await first.json()) as { csrfToken: string };
    expect(session.csrfToken).toBeTruthy();
    const restored = await fetch(`${system.url}/admin/api/session`, {
      headers: { cookie },
    });
    expect(((await restored.json()) as { csrfToken: string }).csrfToken).toBe(
      session.csrfToken,
    );
    const forbidden = await fetch(`${system.url}/admin/api/keys`, {
      method: "POST",
      headers: {
        cookie,
        origin: "http://evil.invalid",
        "content-type": "application/json",
        "x-csrf-token": session.csrfToken,
      },
      body: "{}",
    });
    expect(forbidden.status).toBe(403);
    const created = await fetch(`${system.url}/admin/api/keys`, {
      method: "POST",
      headers: {
        cookie,
        origin: "http://localhost:3000",
        "content-type": "application/json",
        "x-csrf-token": session.csrfToken,
      },
      body: JSON.stringify({
        name: "one",
        allowAllModels: false,
        models: ["m"],
        expiresAt: "2030-01-01T07:00:00+07:00",
      }),
    });
    expect(created.status).toBe(201);
    expect(
      (system.store.listKeys()[0] as { expires_at: string }).expires_at,
    ).toBe("2030-01-01T00:00:00.000Z");
    expect(
      (system.store.audits() as Array<{ action: string }>).filter(
        (entry) => entry.action === "key.created",
      ),
    ).toHaveLength(1);
    const burst = await Promise.all(
      Array.from({ length: 10 }, () => login("wrong-password")),
    );
    expect(burst.filter((response) => response.status === 401)).toHaveLength(8);
    expect(burst.filter((response) => response.status === 429)).toHaveLength(2);
    expect((await fetch(`${system.url}/healthz`)).status).toBe(200);
    const throttled = await login("wrong-password");
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBe("900");
    expect((await login("wrong-password", "rotated-username")).status).toBe(
      429,
    );
    const expired = "hnq_expired_key_012345678901234567890";
    system.store.createKey({
      name: "expired",
      raw: expired,
      allowAll: true,
      models: [],
      rpm: 1,
      concurrency: 1,
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    expect(
      (
        await fetch(`${system.url}/v1/models`, {
          headers: { authorization: `Bearer ${expired}` },
        })
      ).status,
    ).toBe(401);
    system.store.db
      .prepare("UPDATE admin_users SET enabled=0 WHERE username='admin'")
      .run();
    expect(
      (await fetch(`${system.url}/admin/api/session`, { headers: { cookie } }))
        .status,
    ).toBe(401);
    await close(system);
  });
  it("syncs the Cockpit model catalog only through an authenticated CSRF-protected admin action", async () => {
    const system = await gateway((request, response) => {
      if (request.url?.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            data: [
              {
                id: "gpt-catalog-a",
                object: "model",
                owned_by: "cockpit",
                created: 1,
              },
              { id: "gpt-catalog-b", object: "model", owned_by: "cockpit" },
            ],
          }),
        );
        return;
      }
      response.writeHead(500);
      response.end();
    });
    system.store.createAdmin(
      "catalog-admin",
      passwordHash("very-long-admin-password"),
    );
    const login = await fetch(`${system.url}/admin/api/session`, {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        username: "catalog-admin",
        password: "very-long-admin-password",
      }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const { csrfToken } = (await login.json()) as { csrfToken: string };
    expect((await fetch(`${system.url}/admin/api/models`)).status).toBe(401);
    const forbidden = await fetch(`${system.url}/admin/api/models/sync`, {
      method: "POST",
      headers: {
        cookie,
        origin: "http://evil.invalid",
        "content-type": "application/json",
        "x-csrf-token": csrfToken,
      },
      body: "{}",
    });
    expect(forbidden.status).toBe(403);
    const synced = await fetch(`${system.url}/admin/api/models/sync`, {
      method: "POST",
      headers: {
        cookie,
        origin: "http://localhost:3000",
        "content-type": "application/json",
        "x-csrf-token": csrfToken,
      },
      body: "{}",
    });
    expect(synced.status).toBe(200);
    expect((await synced.json()) as { count: number }).toMatchObject({
      count: 2,
    });
    const catalog = await fetch(`${system.url}/admin/api/models`, {
      headers: { cookie },
    });
    expect(
      (await catalog.json()) as {
        data: Array<{ model_id: string; available: number }>;
      },
    ).toMatchObject({
      lastCount: 2,
      data: [
        { model_id: "gpt-catalog-a", available: 1 },
        { model_id: "gpt-catalog-b", available: 1 },
      ],
    });
    expect(
      (system.store.audits() as Array<{ action: string }>).filter(
        (event) => event.action === "models.synced",
      ),
    ).toHaveLength(1);
    await close(system);
  });
});
