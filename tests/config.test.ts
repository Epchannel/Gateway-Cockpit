import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";

const directories: string[] = [];
const environment = (overrides: Record<string, string> = {}) => {
  const directory = mkdtempSync(join(tmpdir(), "hnq-config-"));
  directories.push(directory);
  const file = join(directory, "secrets.json");
  writeFileSync(
    file,
    JSON.stringify({
      upstreamApiKey: "upstream-secret-0123456789",
      sessionSecret: "session-secret-012345678901234567890123456789",
    }),
  );
  return {
    API_HNQ_SECRETS_FILE: file,
    API_HNQ_DATABASE_PATH: join(directory, "db.sqlite"),
    ...overrides,
  };
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
describe("configuration", () => {
  it("defaults the public generation request limit to 16 MiB and caps it there", () => {
    expect(loadConfig(environment()).bodyLimit).toBe(16_777_216);
    expect(() =>
      loadConfig(environment({ API_HNQ_BODY_LIMIT: "16777217" })),
    ).toThrow("positive integer");
  });
  it("fails closed for non-loopback listeners, malformed limits, and unsafe upstream URLs", () => {
    expect(() => loadConfig(environment({ API_HNQ_HOST: "0.0.0.0" }))).toThrow(
      "loopback",
    );
    expect(() => loadConfig(environment({ API_HNQ_BODY_LIMIT: "0" }))).toThrow(
      "positive integer",
    );
    expect(() =>
      loadConfig(
        environment({ API_HNQ_UPSTREAM_URL: "http://user:pass@127.0.0.1/v1" }),
      ),
    ).toThrow("invalid");
    expect(() =>
      loadConfig(
        environment({ API_HNQ_UPSTREAM_URL: "http://127.0.0.1/not-v1" }),
      ),
    ).toThrow("end in /v1");
  });
  it("preserves legacy combined timeout only as a bounded compatibility alias", () => {
    const config = loadConfig(
      environment({ API_HNQ_UPSTREAM_TIMEOUT_MS: "1234" }),
    );
    expect(config.upstreamHeaderTimeoutMs).toBe(1234);
    expect(config.upstreamConnectTimeoutMs).toBe(1234);
    expect(config.upstreamTotalTimeoutMs).toBe(1234);
  });
});
