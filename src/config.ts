import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type Config = {
  host: string;
  port: number;
  databasePath: string;
  upstreamUrl: string;
  publicOrigin: string;
  upstreamApiKey: string;
  sessionSecret: string;
  secureCookies: boolean;
  bodyLimit: number;
  defaultRpm: number;
  defaultConcurrency: number;
  upstreamHeaderTimeoutMs: number;
  upstreamConnectTimeoutMs: number;
  upstreamIdleTimeoutMs: number;
  upstreamTotalTimeoutMs: number;
  maxUpstreamResponseBytes: number;
};
const positiveInt = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
) => {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new Error(`${name} must be a positive integer`);
  return value;
};
const parseUrl = (value: string, field: string) => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${field} must be an absolute URL`);
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new Error(`${field} is invalid`);
  return parsed;
};
export function loadConfig(env = process.env): Config {
  const file = env.API_HNQ_SECRETS_FILE;
  if (!file) throw new Error("API_HNQ_SECRETS_FILE is required");
  let secrets: unknown;
  try {
    secrets = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error("Cannot read API_HNQ_SECRETS_FILE");
  }
  if (!secrets || typeof secrets !== "object" || Array.isArray(secrets))
    throw new Error("Invalid secrets file");
  const secret = secrets as Record<string, unknown>;
  if (
    typeof secret.upstreamApiKey !== "string" ||
    secret.upstreamApiKey.length < 16 ||
    secret.upstreamApiKey.length > 4096
  )
    throw new Error("Missing upstreamApiKey");
  if (
    typeof secret.sessionSecret !== "string" ||
    secret.sessionSecret.length < 32 ||
    secret.sessionSecret.length > 4096
  )
    throw new Error("Missing sessionSecret");
  const origin = parseUrl(
    env.API_HNQ_PUBLIC_ORIGIN ?? "https://apihnq.hnquan.com",
    "API_HNQ_PUBLIC_ORIGIN",
  );
  const upstream = parseUrl(
    env.API_HNQ_UPSTREAM_URL ?? "http://127.0.0.1:65238/v1",
    "API_HNQ_UPSTREAM_URL",
  );
  if (upstream.pathname.replace(/\/$/, "") !== "/v1")
    throw new Error("API_HNQ_UPSTREAM_URL must end in /v1");
  const host = env.API_HNQ_HOST ?? "127.0.0.1";
  if (!/^(127\.0\.0\.1|::1|localhost)$/i.test(host))
    throw new Error("API_HNQ_HOST must be loopback");
  const timeouts = {
    ...env,
    API_HNQ_UPSTREAM_HEADER_TIMEOUT_MS:
      env.API_HNQ_UPSTREAM_HEADER_TIMEOUT_MS ?? env.API_HNQ_UPSTREAM_TIMEOUT_MS,
    API_HNQ_UPSTREAM_TOTAL_TIMEOUT_MS:
      env.API_HNQ_UPSTREAM_TOTAL_TIMEOUT_MS ?? env.API_HNQ_UPSTREAM_TIMEOUT_MS,
    API_HNQ_UPSTREAM_CONNECT_TIMEOUT_MS:
      env.API_HNQ_UPSTREAM_CONNECT_TIMEOUT_MS ??
      env.API_HNQ_UPSTREAM_TIMEOUT_MS,
  };
  return {
    host,
    port: positiveInt(env, "API_HNQ_PORT", 8787, 65535),
    databasePath: resolve(env.API_HNQ_DATABASE_PATH ?? "./data/api-hnq.sqlite"),
    upstreamUrl: upstream.toString().replace(/\/$/, ""),
    publicOrigin: origin.origin,
    upstreamApiKey: secret.upstreamApiKey,
    sessionSecret: secret.sessionSecret,
    secureCookies: origin.protocol === "https:",
    bodyLimit: positiveInt(env, "API_HNQ_BODY_LIMIT", 16_777_216, 16_777_216),
    defaultRpm: positiveInt(env, "API_HNQ_DEFAULT_RPM", 60, 100_000),
    defaultConcurrency: positiveInt(
      env,
      "API_HNQ_DEFAULT_CONCURRENCY",
      4,
      10_000,
    ),
    upstreamHeaderTimeoutMs: positiveInt(
      timeouts,
      "API_HNQ_UPSTREAM_HEADER_TIMEOUT_MS",
      30_000,
      600_000,
    ),
    upstreamConnectTimeoutMs: positiveInt(
      timeouts,
      "API_HNQ_UPSTREAM_CONNECT_TIMEOUT_MS",
      10_000,
      600_000,
    ),
    upstreamIdleTimeoutMs: positiveInt(
      env,
      "API_HNQ_UPSTREAM_IDLE_TIMEOUT_MS",
      30_000,
      600_000,
    ),
    upstreamTotalTimeoutMs: positiveInt(
      timeouts,
      "API_HNQ_UPSTREAM_TOTAL_TIMEOUT_MS",
      120_000,
      3_600_000,
    ),
    maxUpstreamResponseBytes: positiveInt(
      env,
      "API_HNQ_MAX_UPSTREAM_RESPONSE_BYTES",
      8_388_608,
      67_108_864,
    ),
  };
}
