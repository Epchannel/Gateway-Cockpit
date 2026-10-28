import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import statik from "@fastify/static";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { createHmac, randomUUID } from "node:crypto";
import { loadConfig, type Config } from "./config.js";
import { Store, type Key, type UpstreamModel, type Usage } from "./db.js";
import {
  apiKey,
  digest,
  passwordHash,
  passwordVerifyAsync,
  safeEqual,
  token,
} from "./crypto.js";

type AppOpts = { config?: Config; store?: Store; upstreamFetch?: typeof fetch };
type TimeoutKind = "connect" | "header" | "idle" | "total" | undefined;
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "cookie",
  "authorization",
]);
const ADMIN_USERNAME = /^[a-zA-Z0-9_.-]{3,64}$/;
const error = (
  reply: FastifyReply,
  status: number,
  message: string,
  code: string,
) =>
  reply.code(status).send({
    error: {
      message,
      type: status === 401 ? "authentication_error" : "invalid_request_error",
      param: null,
      code,
    },
  });
const authHeader = (request: FastifyRequest) => {
  const value = request.headers.authorization;
  return typeof value === "string" && /^Bearer\s+\S+$/.test(value)
    ? value.slice(7)
    : null;
};
const usageNumber = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
const usageObject = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const firstUsageNumber = (...values: unknown[]) =>
  values.map(usageNumber).find((value) => value !== undefined);
const usageFrom = (value: unknown): Usage => {
  const obj = usageObject(value);
  if (!obj) return undefined;
  const candidate =
    usageObject(obj.usage) ?? usageObject(usageObject(obj.response)?.usage);
  if (!candidate) return undefined;
  const inputDetails = usageObject(candidate.input_tokens_details),
    promptDetails = usageObject(candidate.prompt_tokens_details),
    outputDetails = usageObject(candidate.output_tokens_details),
    completionDetails = usageObject(candidate.completion_tokens_details);
  const output: Record<string, number> = {};
  for (const [field, number] of [
    [
      "input_tokens",
      firstUsageNumber(candidate.input_tokens, candidate.prompt_tokens),
    ],
    [
      "output_tokens",
      firstUsageNumber(candidate.output_tokens, candidate.completion_tokens),
    ],
    ["total_tokens", firstUsageNumber(candidate.total_tokens)],
    [
      "cached_tokens",
      firstUsageNumber(
        candidate.cached_tokens,
        inputDetails?.cached_tokens,
        promptDetails?.cached_tokens,
      ),
    ],
    [
      "reasoning_tokens",
      firstUsageNumber(
        candidate.reasoning_tokens,
        outputDetails?.reasoning_tokens,
        completionDetails?.reasoning_tokens,
      ),
    ],
  ] as const)
    if (number !== undefined) output[field] = number;
  return Object.keys(output).length ? output : undefined;
};
const upstreamModelsFrom = (value: unknown): UpstreamModel[] => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid upstream model list");
  const list = value as { object?: unknown; data?: unknown };
  if (list.object !== "list") throw new Error("Invalid upstream model list");
  const data = list.data;
  if (!Array.isArray(data) || data.length > 1000)
    throw new Error("Invalid upstream model list");
  return data.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Invalid upstream model list");
    const model = item as Record<string, unknown>;
    if (typeof model.id !== "string")
      throw new Error("Invalid upstream model list");
    return {
      id: model.id,
      object: typeof model.object === "string" ? model.object : undefined,
      owned_by: typeof model.owned_by === "string" ? model.owned_by : undefined,
      created: typeof model.created === "number" ? model.created : undefined,
    };
  });
};
const boundedText = async (
  response: Response,
  maximum: number,
  signal: AbortSignal,
) => {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maximum) throw new Error("upstream_response_too_large");
      chunks.push(item.value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  } catch (cause) {
    try {
      await reader.cancel(cause);
    } catch {
      /* cancellation is best effort */
    }
    throw cause;
  } finally {
    reader.releaseLock();
  }
};
const upstreamRequest = (
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  connectTimeoutMs: number,
  onConnectTimeout: () => void,
  injectedFetch?: typeof fetch,
) => {
  if (injectedFetch) return injectedFetch(url, { ...init, signal });
  return new Promise<Response>((resolve, reject) => {
    const target = new URL(url);
    const options = {
      method: init.method,
      headers: init.headers
        ? Object.fromEntries(new Headers(init.headers))
        : {},
    };
    const request =
      target.protocol === "https:"
        ? httpsRequest(target, options)
        : httpRequest(target, options);
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () =>
      request.destroy(
        signal.reason instanceof Error ? signal.reason : undefined,
      );
    const cleanupConnect = () => {
      if (connectTimer) clearTimeout(connectTimer);
      connectTimer = undefined;
    };
    request.once("socket", (socket) => {
      if (!socket.connecting) return;
      connectTimer = setTimeout(() => {
        onConnectTimeout();
        request.destroy(new Error("connect_timeout"));
      }, connectTimeoutMs);
      socket.once("connect", cleanupConnect);
      socket.once("error", cleanupConnect);
    });
    request.once("response", (response) => {
      cleanupConnect();
      response.once("close", () => signal.removeEventListener("abort", abort));
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined)
            headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        const status = response.statusCode ?? 502;
        const body = [204, 205, 304].includes(status)
          ? null
          : (Readable.toWeb(response) as ReadableStream);
        const upstream = new Response(body, { status, headers });
        finish(() => resolve(upstream));
      } catch (cause) {
        response.destroy(cause instanceof Error ? cause : undefined);
        finish(() => reject(cause));
      }
    });
    request.on("error", (cause) => {
      cleanupConnect();
      signal.removeEventListener("abort", abort);
      if (!settled) finish(() => reject(cause));
    });
    signal.addEventListener("abort", abort, { once: true });
    if (typeof init.body === "string") request.end(init.body);
    else request.end();
  });
};
class Gate {
  hits = new Map<number, number[]>();
  active = new Map<number, number>();
  acquire(key: Key) {
    const now = Date.now(),
      hits = (this.hits.get(key.id) ?? []).filter((at) => now - at < 60_000);
    if (hits.length >= key.rpm_limit) return false;
    const current = this.active.get(key.id) ?? 0;
    if (current >= key.concurrency_limit) return false;
    hits.push(now);
    this.hits.set(key.id, hits);
    this.active.set(key.id, current + 1);
    return true;
  }
  release(key: Key) {
    const current = this.active.get(key.id) ?? 0;
    if (current <= 1) this.active.delete(key.id);
    else this.active.set(key.id, current - 1);
  }
}
class LoginThrottle {
  private attempts = new Map<string, number[]>();
  private active = 0;
  private waiting = 0;
  private queue: Array<() => void> = [];
  private readonly windowMs = 15 * 60_000;
  private readonly limit = 8;
  private readonly maxHashes = 4;
  private readonly maxQueuedHashes = 16;
  private keys(ip: string, username: string) {
    return [`ip:${ip}`, `user:${username}`, `pair:${ip}:${username}`];
  }
  private live(key: string, now: number) {
    const attempts = (this.attempts.get(key) ?? []).filter(
      (at) => now - at < this.windowMs,
    );
    if (attempts.length) this.attempts.set(key, attempts);
    else this.attempts.delete(key);
    return attempts;
  }
  reserve(ip: string, username: string) {
    const now = Date.now();
    const keys = this.keys(ip, username);
    if (keys.some((key) => this.live(key, now).length >= this.limit))
      return false;
    for (const key of keys) {
      const attempts = this.live(key, now);
      attempts.push(now);
      this.attempts.set(key, attempts);
    }
    return true;
  }
  success(ip: string, username: string) {
    for (const key of this.keys(ip, username)) this.attempts.delete(key);
  }
  async verify<T>(work: () => Promise<T>): Promise<T | undefined> {
    if (this.active + this.waiting >= this.maxQueuedHashes) return undefined;
    if (this.active >= this.maxHashes) {
      this.waiting += 1;
      await new Promise<void>((resolve) => this.queue.push(resolve));
      this.waiting -= 1;
    }
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}
class SseUsageObserver {
  private text = "";
  private decoder = new TextDecoder();
  usage: Usage;
  push(chunk: Uint8Array) {
    this.text += this.decoder.decode(chunk, { stream: true });
    if (this.text.length > 65_536) this.text = this.text.slice(-16_384);
    let boundary: number;
    while ((boundary = this.text.search(/\r?\n\r?\n/)) >= 0) {
      const frame = this.text.slice(0, boundary);
      this.text = this.text.slice(boundary).replace(/^\r?\n\r?\n/, "");
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        const observed = usageFrom(JSON.parse(data));
        if (observed) this.usage = observed;
      } catch {
        /* observational only; never alter bytes */
      }
    }
  }
}
const waitForDrainOrClose = (
  raw: NodeJS.WritableStream & { destroyed?: boolean },
  signal: AbortSignal,
) =>
  new Promise<void>((resolve, reject) => {
    const clean = () => {
      raw.removeListener("drain", done);
      raw.removeListener("close", closed);
      raw.removeListener("error", failed);
      signal.removeEventListener("abort", aborted);
    };
    const done = () => {
        clean();
        resolve();
      },
      closed = () => {
        clean();
        reject(new Error("client_closed"));
      },
      failed = (cause: Error) => {
        clean();
        reject(cause);
      },
      aborted = () => {
        clean();
        reject(signal.reason ?? new Error("aborted"));
      };
    if (raw.destroyed || signal.aborted) return aborted();
    raw.once("drain", done);
    raw.once("close", closed);
    raw.once("error", failed);
    signal.addEventListener("abort", aborted, { once: true });
  });

export async function buildApp(opts: AppOpts = {}) {
  const config = opts.config ?? loadConfig(),
    store = opts.store ?? new Store(config.databasePath),
    gate = new Gate();
  const loginThrottle = new LoginThrottle(),
    dummyPasswordHash = passwordHash("api-hnq-invalid-login-dummy-password");
  const app = Fastify({
    logger: {
      level: "info",
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "headers.authorization",
        "headers.cookie",
      ],
      serializers: {
        req: (request: {
          method?: string;
          routeOptions?: { url?: string };
          url?: string;
        }) => ({
          method: request.method,
          url: request.routeOptions?.url ?? request.url?.split("?")[0],
        }),
      },
    },
    // Keep non-generation routes (notably admin authentication) at Fastify's
    // conservative default. Generation endpoints opt into the configured cap.
    bodyLimit: 1_048_576,
    trustProxy: false,
  });
  const publicApiDocument = readFileSync(
    join(process.cwd(), "docs", "api.md"),
    "utf8",
  );
  await app.register(cookie);
  const cleanupTimer = setInterval(() => store.cleanup(), 60 * 60 * 1000);
  cleanupTimer.unref();
  app.addHook("onClose", async () => clearInterval(cleanupTimer));
  app.addHook("onSend", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
  });
  app.addHook("preValidation", async (request, reply) => {
    if (
      request.method === "POST" &&
      (request.url.startsWith("/v1/chat/completions") ||
        request.url.startsWith("/v1/responses") ||
        request.url.startsWith("/admin/api/"))
    ) {
      const contentType = request.headers["content-type"];
      if (
        typeof contentType !== "string" ||
        !/^application\/json(?:\s*;|$)/i.test(contentType)
      )
        return error(
          reply,
          415,
          "Content-Type must be application/json",
          "unsupported_media_type",
        );
    }
  });
  app.setErrorHandler((cause, _request, reply) => {
    const status = (cause as { statusCode?: number }).statusCode;
    if (status === 400 || status === 413 || status === 415)
      return error(
        reply,
        status,
        status === 400
          ? "Malformed JSON"
          : status === 413
            ? "Request body too large"
            : "Unsupported media type",
        status === 400
          ? "invalid_json"
          : status === 413
            ? "body_too_large"
            : "unsupported_media_type",
      );
    app.log.error(
      { code: (cause as { code?: string }).code },
      "request failed",
    );
    return error(reply, 500, "Internal server error", "internal_error");
  });
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async () => ({ ok: true }));
  app.get("/api.md", async (_request, reply) =>
    reply.type("text/markdown; charset=utf-8").send(publicApiDocument),
  );
  const csrfToken = (raw: string) =>
    createHmac("sha256", config.sessionSecret).update(raw).digest("base64url");
  const user = async (request: FastifyRequest, reply: FastifyReply) => {
    const raw = request.cookies.hnq_admin;
    if (!raw) {
      error(reply, 401, "Admin authentication required", "admin_auth_required");
      return null;
    }
    const session = store.getSession(raw);
    if (!session) {
      error(reply, 401, "Admin session expired", "admin_auth_required");
      return null;
    }
    return session;
  };
  const csrf = async (request: FastifyRequest, reply: FastifyReply) => {
    const session = await user(request, reply);
    if (!session) return null;
    if (request.headers.origin !== config.publicOrigin) {
      error(reply, 403, "Invalid origin", "csrf_failed");
      return null;
    }
    const supplied = request.headers["x-csrf-token"];
    if (
      typeof supplied !== "string" ||
      !safeEqual(digest(supplied), session.csrf_hash)
    ) {
      error(reply, 403, "Invalid CSRF token", "csrf_failed");
      return null;
    }
    return session;
  };
  app.post("/admin/api/session", async (request, reply) => {
    const body = request.body as { username?: unknown; password?: unknown };
    if (request.headers.origin !== config.publicOrigin)
      return error(reply, 403, "Invalid origin", "csrf_failed");
    if (
      typeof body?.username !== "string" ||
      !ADMIN_USERNAME.test(body.username) ||
      typeof body.password !== "string" ||
      body.password.length < 1 ||
      body.password.length > 1024
    )
      return error(
        reply,
        400,
        "username and password are required",
        "invalid_request",
      );
    const username = body.username as string;
    const password = body.password as string;
    if (!loginThrottle.reserve(request.ip, username)) {
      reply.header("Retry-After", "900");
      return error(
        reply,
        429,
        "Too many login attempts",
        "rate_limit_exceeded",
      );
    }
    const admin = store.admin(username);
    const valid = await loginThrottle.verify(() =>
      passwordVerifyAsync(password, admin?.password_hash ?? dummyPasswordHash),
    );
    if (valid === undefined) {
      reply.header("Retry-After", "60");
      return error(
        reply,
        429,
        "Login verification busy",
        "rate_limit_exceeded",
      );
    }
    if (!admin || !valid) {
      store.audit(null, "admin.login_failed", "admin_user", username, {});
      return error(reply, 401, "Invalid credentials", "invalid_credentials");
    }
    loginThrottle.success(request.ip, username);
    const raw = token(),
      csrf = csrfToken(raw);
    store.session(
      admin.id,
      raw,
      csrf,
      new Date(Date.now() + 8 * 3600_000).toISOString(),
    );
    store.audit(admin.id, "admin.login", "admin_user", String(admin.id), {});
    reply.setCookie("hnq_admin", raw, {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: "strict",
      path: "/admin",
      maxAge: 28_800,
    });
    return { csrfToken: csrf, user: { username: admin.username } };
  });
  app.get("/admin/api/session", async (request, reply) => {
    const session = await user(request, reply);
    if (!session) return;
    return {
      csrfToken: csrfToken(request.cookies.hnq_admin!),
      user: { username: session.username },
    };
  });
  app.delete("/admin/api/session", async (request, reply) => {
    const session = await csrf(request, reply);
    if (!session) return;
    store.deleteSession(request.cookies.hnq_admin!);
    store.audit(
      session.user_id,
      "admin.logout",
      "admin_user",
      String(session.user_id),
      {},
    );
    reply.clearCookie("hnq_admin", { path: "/admin" });
    return reply.code(204).send();
  });
  app.get("/admin/api/overview", async (request, reply) => {
    const session = await user(request, reply);
    if (!session) return;
    return {
      ...store.overview(),
      activeStreams: [...gate.active.values()].reduce(
        (left, right) => left + right,
        0,
      ),
      user: session.username,
    };
  });
  app.get("/admin/api/keys", async (request, reply) => {
    if (!(await user(request, reply))) return;
    return { data: store.listKeys() };
  });
  app.post("/admin/api/keys", async (request, reply) => {
    const session = await csrf(request, reply);
    if (!session) return;
    const body = request.body as {
      name?: unknown;
      allowAllModels?: unknown;
      models?: unknown;
      rpmLimit?: unknown;
      concurrencyLimit?: unknown;
      expiresAt?: unknown;
    };
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 100)
      return error(reply, 400, "A key name is required", "invalid_request");
    const rpm =
        typeof body.rpmLimit === "number" ? body.rpmLimit : config.defaultRpm,
      concurrency =
        typeof body.concurrencyLimit === "number"
          ? body.concurrencyLimit
          : config.defaultConcurrency;
    if (
      !Number.isSafeInteger(rpm) ||
      rpm < 1 ||
      rpm > 100_000 ||
      !Number.isSafeInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > 10_000
    )
      return error(
        reply,
        400,
        "Limits must be positive integers",
        "invalid_request",
      );
    if (
      body.allowAllModels !== undefined &&
      typeof body.allowAllModels !== "boolean"
    )
      return error(
        reply,
        400,
        "allowAllModels must be boolean",
        "invalid_request",
      );
    if (
      body.models !== undefined &&
      (!Array.isArray(body.models) ||
        body.models.length > 64 ||
        body.models.some(
          (model) =>
            typeof model !== "string" || !model.trim() || model.length > 200,
        ))
    )
      return error(reply, 400, "Invalid model allowlist", "invalid_request");
    let expiresAt: string | null = null;
    if (body.expiresAt !== undefined && body.expiresAt !== null) {
      if (
        typeof body.expiresAt !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(
          body.expiresAt,
        )
      )
        return error(
          reply,
          400,
          "expiresAt must be RFC3339",
          "invalid_request",
        );
      const time = Date.parse(body.expiresAt);
      if (!Number.isFinite(time) || time <= Date.now())
        return error(
          reply,
          400,
          "expiresAt must be in the future",
          "invalid_request",
        );
      expiresAt = new Date(time).toISOString();
    }
    const raw = apiKey(),
      models = [
        ...new Set(
          Array.isArray(body.models)
            ? body.models.map((model) => (model as string).trim())
            : [],
        ),
      ],
      id = store.createKey({
        name,
        raw,
        allowAll: body.allowAllModels !== false,
        models,
        rpm,
        concurrency,
        expiresAt,
        actor: session.user_id,
      });
    return reply.code(201).send({ id, key: raw, prefix: raw.slice(0, 12) });
  });
  app.post("/admin/api/keys/:id/revoke", async (request, reply) => {
    const session = await csrf(request, reply);
    if (!session) return;
    const id = Number((request.params as { id: string }).id);
    if (!Number.isSafeInteger(id) || !store.revokeKey(id, session.user_id))
      return error(reply, 404, "Key not found", "not_found");
    return { ok: true };
  });
  app.get("/admin/api/requests", async (request, reply) => {
    if (!(await user(request, reply))) return;
    return { data: store.requests() };
  });
  app.get("/admin/api/audit", async (request, reply) => {
    if (!(await user(request, reply))) return;
    return { data: store.audits() };
  });
  app.get("/admin/api/usage", async (request, reply) => {
    if (!(await user(request, reply))) return;
    return { data: store.usage() };
  });
  app.get("/admin/api/models", async (request, reply) => {
    if (!(await user(request, reply))) return;
    return store.models();
  });
  app.post("/admin/api/models/sync", async (request, reply) => {
    const session = await csrf(request, reply);
    if (!session) return;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("model_sync_timeout")),
      config.upstreamTotalTimeoutMs,
    );
    try {
      const result = await upstreamRequest(
        `${config.upstreamUrl}/models`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${config.upstreamApiKey}` },
          redirect: "error",
        },
        controller.signal,
        config.upstreamConnectTimeoutMs,
        () => undefined,
        opts.upstreamFetch,
      );
      if (!result.ok) {
        try {
          await boundedText(
            result,
            config.maxUpstreamResponseBytes,
            controller.signal,
          );
        } catch {
          /* upstream error content is intentionally discarded */
        }
        return error(
          reply,
          502,
          "Upstream unavailable",
          "upstream_unavailable",
        );
      }
      const text = await boundedText(
        result,
        config.maxUpstreamResponseBytes,
        controller.signal,
      );
      let models: UpstreamModel[];
      try {
        models = upstreamModelsFrom(JSON.parse(text));
      } catch {
        return error(
          reply,
          502,
          "Upstream returned an invalid model list",
          "upstream_invalid_response",
        );
      }
      const summary = store.syncModels(models, session.user_id);
      return reply.code(200).send({ ...summary, ...store.models() });
    } catch {
      return error(reply, 502, "Upstream unavailable", "upstream_unavailable");
    } finally {
      clearTimeout(timer);
    }
  });
  app.get("/admin/api/upstream", async (request, reply) => {
    if (!(await user(request, reply))) return;
    try {
      const signal = AbortSignal.timeout(5000);
      const result = await upstreamRequest(
        `${config.upstreamUrl}/models`,
        { headers: { Authorization: `Bearer ${config.upstreamApiKey}` } },
        signal,
        config.upstreamConnectTimeoutMs,
        () => undefined,
        opts.upstreamFetch,
      );
      const diagnostic = { ok: result.ok, status: result.status };
      await result.body?.cancel();
      return diagnostic;
    } catch {
      return { ok: false, status: null };
    }
  });
  const clientKey = async (request: FastifyRequest, reply: FastifyReply) => {
    const raw = authHeader(request),
      key = raw && store.key(raw);
    if (!key) {
      error(reply, 401, "Incorrect API key provided", "invalid_api_key");
      return null;
    }
    return key;
  };
  const admissions = new WeakMap<
    FastifyRequest,
    { key: Key; release: () => void }
  >();
  const releaseAdmission = (request: FastifyRequest) => {
    const admission = admissions.get(request);
    if (!admission) return;
    admissions.delete(request);
    admission.release();
  };
  const admitGeneration = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const key = await clientKey(request, reply);
    if (!key) return;
    if (!gate.acquire(key)) {
      reply.header("Retry-After", "60");
      return error(
        reply,
        429,
        "Rate or concurrency limit exceeded",
        "rate_limit_exceeded",
      );
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      reply.raw.removeListener("finish", release);
      reply.raw.removeListener("close", release);
      gate.release(key);
    };
    admissions.set(request, { key, release });
    reply.raw.once("finish", release);
    reply.raw.once("close", release);
  };
  async function proxy(
    request: FastifyRequest,
    reply: FastifyReply,
    path: "models" | "chat/completions" | "responses",
  ) {
    const admission = admissions.get(request);
    const key = admission?.key ?? (await clientKey(request, reply));
    if (!key) return;
    const body: unknown = request.body;
    let model: string | undefined;
    if (path !== "models") {
      if (!body || typeof body !== "object" || Array.isArray(body))
        return error(
          reply,
          400,
          "JSON object body required",
          "invalid_request",
        );
      model = (body as { model?: unknown }).model as string;
      if (
        typeof model !== "string" ||
        !model.trim() ||
        model.length > 200 ||
        !store.allowed(key, model)
      )
        return error(
          reply,
          403,
          "Model is not permitted for this API key",
          "model_not_allowed",
        );
    }
    if (!admission && !gate.acquire(key)) {
      reply.header("Retry-After", "60");
      return error(
        reply,
        429,
        "Rate or concurrency limit exceeded",
        "rate_limit_exceeded",
      );
    }
    const started = Date.now(),
      requestId = randomUUID(),
      controller = new AbortController();
    let status = 502,
      streamed = false,
      usage: Usage,
      errorCode: string | undefined,
      timeout: TimeoutKind;
    const totalTimer = setTimeout(() => {
      timeout = "total";
      controller.abort(new Error("total_timeout"));
    }, config.upstreamTotalTimeoutMs);
    const closed = () => {
      if (!reply.raw.writableEnded)
        controller.abort(new Error("client_closed"));
    };
    reply.raw.once("close", closed);
    try {
      const headerTimer = setTimeout(() => {
        timeout = "header";
        controller.abort(new Error("header_timeout"));
      }, config.upstreamHeaderTimeoutMs);
      let upstream: Response;
      try {
        upstream = await upstreamRequest(
          `${config.upstreamUrl}/${path}`,
          {
            method: request.method,
            headers: {
              Authorization: `Bearer ${config.upstreamApiKey}`,
              "X-Request-Id": requestId,
              ...(path === "models"
                ? {}
                : { "Content-Type": "application/json" }),
            },
            body: path === "models" ? undefined : JSON.stringify(body),
            redirect: "error",
          },
          controller.signal,
          config.upstreamConnectTimeoutMs,
          () => {
            timeout = "connect";
          },
          opts.upstreamFetch,
        );
      } finally {
        clearTimeout(headerTimer);
      }
      status = upstream.status;
      const contentType =
        upstream.headers.get("content-type") ?? "application/json";
      if (!upstream.ok) {
        try {
          await boundedText(
            upstream,
            config.maxUpstreamResponseBytes,
            controller.signal,
          );
        } catch {
          /* error bodies are deliberately discarded */
        }
        errorCode =
          (upstream.status >= 300 && upstream.status < 400) ||
          upstream.status === 401 ||
          upstream.status === 403 ||
          upstream.status >= 500
            ? "upstream_unavailable"
            : "upstream_rejected";
        status =
          (upstream.status >= 300 && upstream.status < 400) ||
          upstream.status === 401 ||
          upstream.status === 403 ||
          upstream.status >= 500
            ? 502
            : upstream.status;
        return error(
          reply,
          status,
          status === 502 ? "Upstream unavailable" : "Upstream rejected request",
          errorCode,
        );
      }
      if (
        contentType.toLowerCase().includes("text/event-stream") &&
        upstream.body
      ) {
        streamed = true;
        reply
          .code(status)
          .header("Content-Type", contentType)
          .header("X-Request-Id", requestId);
        for (const [name, value] of upstream.headers)
          if (
            !HOP_HEADERS.has(name) &&
            ["cache-control", "content-type"].includes(name)
          )
            reply.raw.setHeader(name, value);
        reply.hijack();
        reply.raw.writeHead(status);
        const reader = upstream.body.getReader(),
          observer = new SseUsageObserver();
        try {
          while (true) {
            let idleTimer: ReturnType<typeof setTimeout> | undefined;
            const next = Promise.race([
              reader.read(),
              new Promise<never>((_resolve, reject) => {
                idleTimer = setTimeout(() => {
                  timeout = "idle";
                  controller.abort(new Error("idle_timeout"));
                  reject(new Error("idle_timeout"));
                }, config.upstreamIdleTimeoutMs);
              }),
            ]);
            let item: ReadableStreamReadResult<Uint8Array>;
            try {
              item = await next;
            } finally {
              if (idleTimer) clearTimeout(idleTimer);
            }
            if (item.done) break;
            observer.push(item.value);
            if (!reply.raw.write(item.value))
              await waitForDrainOrClose(reply.raw, controller.signal);
          }
          usage = observer.usage;
        } catch (cause) {
          errorCode = timeout
            ? "upstream_timeout"
            : controller.signal.aborted
              ? "client_cancelled"
              : "upstream_stream_error";
          if (!reply.raw.destroyed)
            reply.raw.destroy(cause instanceof Error ? cause : undefined);
        } finally {
          try {
            await reader.cancel();
          } catch {
            /* already consumed */
          }
          reader.releaseLock();
          if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end();
        }
        return;
      }
      const text = await boundedText(
        upstream,
        config.maxUpstreamResponseBytes,
        controller.signal,
      );
      if (upstream.status === 204 || upstream.status === 205) {
        status = 502;
        errorCode = "upstream_invalid_response";
        return error(reply, status, "Upstream returned no JSON", errorCode);
      }
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        status = 502;
        errorCode = "upstream_invalid_response";
        return error(reply, 502, "Upstream returned invalid JSON", errorCode);
      }
      if (
        path === "models" &&
        key.allow_all_models === 0 &&
        parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { data?: unknown }).data)
      )
        (parsed as { data: unknown[] }).data = (
          parsed as { data: unknown[] }
        ).data.filter(
          (item) =>
            !!item &&
            typeof item === "object" &&
            typeof (item as { id?: unknown }).id === "string" &&
            store.allowed(key, (item as { id: string }).id),
        );
      usage = usageFrom(parsed);
      return reply.code(status).header("X-Request-Id", requestId).send(parsed);
    } catch (cause) {
      if (controller.signal.aborted && !timeout) {
        errorCode = "client_cancelled";
        return;
      }
      status = timeout ? 504 : 502;
      errorCode = timeout
        ? "upstream_timeout"
        : cause instanceof Error &&
            cause.message === "upstream_response_too_large"
          ? "upstream_response_too_large"
          : "upstream_unavailable";
      if (!reply.sent && !reply.raw.headersSent)
        return error(
          reply,
          status,
          errorCode === "upstream_response_too_large"
            ? "Upstream response too large"
            : timeout
              ? "Upstream timed out"
              : "Upstream unavailable",
          errorCode,
        );
    } finally {
      clearTimeout(totalTimer);
      reply.raw.removeListener("close", closed);
      if (admission) releaseAdmission(request);
      else gate.release(key);
      store.touchKey(key.id);
      store.event({
        requestId,
        keyId: key.id,
        endpoint: `/v1/${path}`,
        model: model ?? null,
        status,
        streamed,
        duration: Date.now() - started,
        usage,
        errorCode,
      });
    }
  }
  app.get("/v1/models", (request, reply) => proxy(request, reply, "models"));
  app.post(
    "/v1/chat/completions",
    { bodyLimit: config.bodyLimit, onRequest: admitGeneration },
    (request, reply) => proxy(request, reply, "chat/completions"),
  );
  app.post(
    "/v1/responses",
    { bodyLimit: config.bodyLimit, onRequest: admitGeneration },
    (request, reply) => proxy(request, reply, "responses"),
  );
  await app.register(statik, {
    root: join(process.cwd(), "dist/admin"),
    prefix: "/admin/",
    wildcard: false,
  });
  app.get("/admin", async (_request, reply) => reply.redirect("/admin/"));
  app.get("/admin/api/*", async (_request, reply) =>
    error(reply, 404, "Route not found", "not_found"),
  );
  app.get("/admin/*", async (_request, reply) => reply.sendFile("index.html"));
  app.setNotFoundHandler((_request, reply) =>
    error(reply, 404, "Route not found", "not_found"),
  );
  return { app, store, config };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { app, config } = await buildApp();
  const shutdown = () => {
    void app
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await app.listen({ host: config.host, port: config.port });
}
