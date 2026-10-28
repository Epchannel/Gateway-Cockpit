// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/main.js";

type MockOptions = {
  initialSession?: boolean;
  keys?: unknown[];
  usage?: unknown[];
  catalog?: unknown;
  syncCatalog?: () => Promise<Response> | Response;
  keyPost?: () => Promise<Response> | Response;
  overview?: () => Promise<Response> | Response;
};

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const empty = () => new Response(null, { status: 204 });
const rejected = (status = 401) =>
  json({ error: { message: "Unauthorized" } }, status);

function installApi(options: MockOptions = {}) {
  let login = 0;
  const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).replace("/admin/api/", "");
    const method = init?.method ?? "GET";
    if (path === "session" && method === "GET")
      return Promise.resolve(
        options.initialSession
          ? json({ user: { username: "admin" }, csrfToken: "restored" })
          : rejected(),
      );
    if (path === "session" && method === "POST") {
      login += 1;
      return Promise.resolve(
        json({
          user: { username: `admin-${login}` },
          csrfToken: `csrf-${login}`,
        }),
      );
    }
    if (path === "session" && method === "DELETE")
      return Promise.resolve(empty());
    if (path === "overview")
      return Promise.resolve(
        options.overview?.() ??
          json({
            total: 2,
            success: 2,
            latency: 10,
            activeStreams: 0,
            user: "admin",
          }),
      );
    if (path === "keys" && method === "GET")
      return Promise.resolve(json({ data: options.keys ?? [] }));
    if (path === "keys" && method === "POST")
      return Promise.resolve(
        options.keyPost?.() ??
          json({ key: "hnq_new_secret", id: 1, prefix: "hnq_new" }),
      );
    if (path.startsWith("keys/") && method === "POST")
      return Promise.resolve(json({ ok: true }));
    if (path === "requests") return Promise.resolve(json({ data: [] }));
    if (path === "usage")
      return Promise.resolve(json({ data: options.usage ?? [] }));
    if (path === "audit") return Promise.resolve(json({ data: [] }));
    if (path === "models" && method === "GET")
      return Promise.resolve(json(options.catalog ?? { data: [] }));
    if (path === "models/sync" && method === "POST")
      return Promise.resolve(
        options.syncCatalog?.() ?? json(options.catalog ?? { data: [] }),
      );
    if (path === "upstream")
      return Promise.resolve(json({ ok: true, status: 200 }));
    return Promise.resolve(rejected(404));
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

async function signIn(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Username"), "admin");
  await user.type(
    screen.getByLabelText("Password"),
    "correct horse battery staple",
  );
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByRole("heading", { name: "Gateway status" });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("admin session boundaries", () => {
  it("never shows a created key after logout and a subsequent login", async () => {
    installApi();
    const user = userEvent.setup();
    render(<App />);
    await signIn(user);
    await user.type(screen.getByLabelText("Key name"), "one-time key");
    await user.click(screen.getByRole("button", { name: "Create key" }));
    await screen.findByText("hnq_new_secret");
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByRole("heading", { name: "Control room" });
    expect(screen.queryByText("hnq_new_secret")).toBeNull();
    await signIn(user);
    expect(screen.queryByText("hnq_new_secret")).toBeNull();
  });

  it("ignores a deferred key response from a logged-out session even when fetch ignores abort", async () => {
    let resolveKey!: (response: Response) => void;
    const deferred = new Promise<Response>((resolve) => {
      resolveKey = resolve;
    });
    installApi({ keyPost: () => deferred });
    const user = userEvent.setup();
    render(<App />);
    await signIn(user);
    await user.type(screen.getByLabelText("Key name"), "slow key");
    await user.click(screen.getByRole("button", { name: "Create key" }));
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await signIn(user);
    await act(async () => {
      resolveKey(
        json({ key: "hnq_old_session_secret", id: 9, prefix: "hnq_old" }),
      );
    });
    await waitFor(() =>
      expect(screen.queryByText("hnq_old_session_secret")).toBeNull(),
    );
  });

  it("clears the session immediately when one endpoint returns 401 while another never settles", async () => {
    installApi({
      initialSession: true,
      overview: () => rejected(),
      usage: [],
    });
    const originalFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    originalFetch.mockImplementation(
      (input: string | URL | Request, init?: RequestInit) => {
        const path = String(input).replace("/admin/api/", "");
        if (path === "session")
          return Promise.resolve(
            json({ user: { username: "admin" }, csrfToken: "restored" }),
          );
        if (path === "overview") return Promise.resolve(rejected());
        if (path === "usage") return new Promise<Response>(() => {});
        if (init?.signal?.aborted)
          return Promise.reject(new DOMException("Aborted", "AbortError"));
        return Promise.resolve(json({ data: [] }));
      },
    );
    render(<App />);
    await screen.findByText("Your admin session ended. Sign in again.");
    expect(screen.queryByText("Gateway status")).toBeNull();
  });

  it("renders strict model lists and preserves nullable token fields", async () => {
    installApi({
      keys: [
        {
          id: 1,
          name: "restricted",
          prefix: "hnq_test",
          allow_all_models: 0,
          rpm_limit: 4,
          concurrency_limit: 2,
          created_at: "2026-01-01T00:00:00.000Z",
          models: ["gpt-6-luna", "gpt-6-sol"],
        },
      ],
      usage: [
        {
          day: "2026-01-01",
          keyId: 1,
          keyName: "restricted",
          model: "gpt-6-luna",
          requests: 1,
          totalTokens: 10,
          inputTokens: null,
          outputTokens: 0,
          unknownUsage: 0,
        },
      ],
    });
    const user = userEvent.setup();
    render(<App />);
    await signIn(user);
    await screen.findByText(
      (_, element) =>
        element?.tagName === "SMALL" &&
        (element.textContent?.includes("Restricted: gpt-6-luna, gpt-6-sol") ??
          false),
    );
    await user.click(screen.getByRole("tab", { name: "Usage" }));
    expect(
      await screen.findByText("10 total · — input · 0 output"),
    ).not.toBeNull();
  });

  it("shows cached, reasoning, and cache-rate token metrics when complete", async () => {
    installApi({
      usage: [
        {
          day: "2026-01-01",
          keyId: 1,
          keyName: "tracked",
          model: "gpt-6-luna",
          requests: 1,
          totalTokens: 12,
          inputTokens: 10,
          outputTokens: 2,
          cachedTokens: 8,
          reasoningTokens: 1,
          unknownUsage: 0,
          unknownCachedUsage: 0,
          unknownReasoningUsage: 0,
        },
      ],
    });
    const user = userEvent.setup();
    render(<App />);
    await signIn(user);
    await user.click(screen.getByRole("tab", { name: "Usage" }));
    expect(
      await screen.findByText("8 cached (80.0% of input) · 1 reasoning"),
    ).not.toBeNull();
  });

  it("shows synced Cockpit models and uses them to help create a strict key", async () => {
    const catalog = {
      lastSyncedAt: "2026-01-01T00:00:00.000Z",
      lastCount: 1,
      data: [
        {
          model_id: "gpt-catalog-a",
          object_type: "model",
          owned_by: "cockpit",
          available: 1,
          first_seen_at: "2026-01-01T00:00:00.000Z",
          last_seen_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    installApi({ catalog, syncCatalog: () => json({ ...catalog, count: 1 }) });
    const user = userEvent.setup();
    render(<App />);
    await signIn(user);
    await screen.findByText("Available Cockpit models");
    expect(screen.getAllByText("gpt-catalog-a").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Sync from Cockpit" }));
    await screen.findByText("Synced 1 model from Cockpit.");
    await user.click(
      screen.getByRole("checkbox", { name: /Allow every upstream model/ }),
    );
    await user.click(screen.getByRole("button", { name: "gpt-catalog-a" }));
    expect(
      (screen.getByLabelText("Allowed models") as HTMLTextAreaElement).value,
    ).toBe("gpt-catalog-a");
  });
});
