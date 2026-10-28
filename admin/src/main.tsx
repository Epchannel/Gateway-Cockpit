import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type Key = {
  id: number;
  name: string;
  prefix: string;
  allow_all_models: number;
  rpm_limit: number;
  concurrency_limit: number;
  created_at: string;
  expires_at?: string | null;
  revoked_at?: string | null;
  last_used_at?: string | null;
  models?: string[];
};
type RequestEvent = {
  id: number;
  request_id: string;
  endpoint: string;
  model?: string | null;
  status: number;
  streamed: number;
  duration_ms: number;
  usage_json?: string | null;
  error_code?: string | null;
  created_at: string;
  key_name?: string | null;
  key_prefix?: string | null;
};
type AuditEvent = {
  id: number;
  action: string;
  target_type: string;
  target_id: string;
  metadata_json?: string | null;
  created_at: string;
};
type Usage = {
  day: string;
  keyId?: number | null;
  keyName?: string | null;
  keyPrefix?: string | null;
  model?: string | null;
  requests: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  cachedTokens?: number | null;
  reasoningTokens?: number | null;
  unknownUsage?: number | null;
  unknownCachedUsage?: number | null;
  unknownReasoningUsage?: number | null;
};
type Overview = {
  total?: number;
  success?: number;
  latency?: number;
  activeStreams?: number;
  user?: string;
};
type Session = { csrfToken?: string; user: { username: string } };
type Upstream = { ok: boolean; status: number | null };
type CatalogModel = {
  model_id: string;
  object_type?: string | null;
  owned_by?: string | null;
  upstream_created?: number | null;
  available: number;
  first_seen_at: string;
  last_seen_at: string;
  unavailable_at?: string | null;
};
type ModelCatalog = {
  data: CatalogModel[];
  lastSyncedAt?: string | null;
  lastCount?: number;
};
type Tab = "overview" | "requests" | "usage" | "audit";

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
async function api<T>(
  path: string,
  init: RequestInit = {},
  csrf?: string,
): Promise<T> {
  const response = await fetch(`/admin/api/${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new ApiError(
      body?.error?.message ?? response.statusText,
      response.status,
    );
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}
const formatDate = (value?: string | null) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
};
const formatUsage = (value?: string | null) => {
  if (!value) return "Usage unavailable";
  try {
    const usage = JSON.parse(value) as Record<string, unknown>;
    const values = [
      ["total", usage.total_tokens ?? usage.totalTokens],
      ["input", usage.input_tokens ?? usage.prompt_tokens],
      ["output", usage.output_tokens ?? usage.completion_tokens],
      ["cached", usage.cached_tokens],
      ["reasoning", usage.reasoning_tokens],
    ].filter(([, token]) => typeof token === "number") as Array<
      [string, number]
    >;
    return values.length
      ? values
          .map(([label, token]) => `${token.toLocaleString()} ${label}`)
          .join(" · ")
      : "Usage unavailable";
  } catch {
    return "Usage unavailable";
  }
};
const formatAggregateUsage = (row: Usage) => {
  const cacheRate =
    row.cachedTokens != null && row.inputTokens != null && row.inputTokens > 0
      ? ` (${((row.cachedTokens / row.inputTokens) * 100).toFixed(1)}% of input)`
      : "";
  return `${row.cachedTokens == null ? "Unavailable cache" : `${row.cachedTokens.toLocaleString()} cached${cacheRate}`} · ${row.reasoningTokens == null ? "Unavailable reasoning" : `${row.reasoningTokens.toLocaleString()} reasoning`}`;
};
function Notice({
  message,
  tone = "error",
}: {
  message: string;
  tone?: "error" | "success";
}) {
  return (
    <p className={`notice ${tone}`} role="status">
      {message}
    </p>
  );
}

function Login({
  onLogin,
  notice,
}: {
  onLogin: (session: Session) => void;
  notice?: string;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main className="login-shell">
      <section className="login-card" aria-labelledby="login-heading">
        <p className="eyebrow">API HNQ / ADMIN</p>
        <h1 id="login-heading">Control room</h1>
        <p>Manage gateway access without exposing upstream credentials.</p>
        <form
          className="stack"
          onSubmit={async (event) => {
            event.preventDefault();
            setError("");
            setBusy(true);
            try {
              const session = await api<Session>("session", {
                method: "POST",
                body: JSON.stringify({ username, password }),
              });
              setPassword("");
              onLogin(session);
            } catch (reason) {
              setError((reason as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Username
            <input
              autoComplete="username"
              autoFocus
              maxLength={64}
              onChange={(event) => setUsername(event.target.value)}
              required
              value={username}
            />
          </label>
          <label>
            Password
            <input
              autoComplete="current-password"
              maxLength={1024}
              minLength={1}
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </label>
          {(error || notice) && <Notice message={error || notice!} />}
          <button disabled={busy} type="submit">
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}
function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <article className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {hint && <small>{hint}</small>}
    </article>
  );
}

function KeyForm({
  csrf,
  signal,
  isSessionActive,
  onCreated,
  catalogModels,
}: {
  csrf: string;
  signal?: AbortSignal;
  isSessionActive: () => boolean;
  onCreated: (key: string, message: string) => void;
  catalogModels: CatalogModel[];
}) {
  const [name, setName] = useState("");
  const [allowAll, setAllowAll] = useState(true);
  const [models, setModels] = useState("");
  const [rpm, setRpm] = useState("60");
  const [concurrency, setConcurrency] = useState("4");
  const [expiry, setExpiry] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const selectedModels = models
    .split(/[\n,]/)
    .map((model) => model.trim())
    .filter(Boolean);
  return (
    <article className="panel key-form">
      <div className="panel-heading">
        <div>
          <h2>Create API key</h2>
          <p>
            The complete key is shown once. Copy it before closing this panel.
          </p>
        </div>
      </div>
      <form
        className="stack"
        onSubmit={async (event) => {
          event.preventDefault();
          const parsedRpm = Number(rpm);
          const parsedConcurrency = Number(concurrency);
          if (!name.trim()) return setError("A key name is required.");
          if (
            !Number.isInteger(parsedRpm) ||
            parsedRpm < 1 ||
            !Number.isInteger(parsedConcurrency) ||
            parsedConcurrency < 1
          )
            return setError("Limits must be positive whole numbers.");
          if (!allowAll && selectedModels.length === 0)
            return setError("Add at least one model or allow all models.");
          let expiresAt: string | null = null;
          if (expiry) {
            const parsed = new Date(expiry);
            if (
              Number.isNaN(parsed.getTime()) ||
              parsed.getTime() <= Date.now()
            )
              return setError("Expiry must be in the future.");
            expiresAt = parsed.toISOString();
          }
          setBusy(true);
          setError("");
          try {
            const created = await api<{ key: string }>(
              "keys",
              {
                method: "POST",
                signal,
                body: JSON.stringify({
                  name: name.trim(),
                  allowAllModels: allowAll,
                  models: selectedModels,
                  rpmLimit: parsedRpm,
                  concurrencyLimit: parsedConcurrency,
                  expiresAt,
                }),
              },
              csrf,
            );
            if (!isSessionActive()) return;
            setName("");
            setModels("");
            setExpiry("");
            onCreated(
              created.key,
              `Created ${name.trim()}. Save the key now; it cannot be displayed again.`,
            );
          } catch (reason) {
            if (!signal?.aborted && isSessionActive())
              setError((reason as Error).message);
          } finally {
            if (isSessionActive()) setBusy(false);
          }
        }}
      >
        <label>
          Key name
          <input
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            placeholder="Production client"
            required
            value={name}
          />
        </label>
        <div className="form-grid">
          <label>
            Requests per minute
            <input
              inputMode="numeric"
              min="1"
              onChange={(event) => setRpm(event.target.value)}
              required
              type="number"
              value={rpm}
            />
          </label>
          <label>
            Concurrent requests
            <input
              inputMode="numeric"
              min="1"
              onChange={(event) => setConcurrency(event.target.value)}
              required
              type="number"
              value={concurrency}
            />
          </label>
          <label>
            Expiry <span className="optional">optional</span>
            <input
              onChange={(event) => setExpiry(event.target.value)}
              type="datetime-local"
              value={expiry}
            />
          </label>
        </div>
        <label className="toggle">
          <input
            checked={allowAll}
            onChange={(event) => setAllowAll(event.target.checked)}
            type="checkbox"
          />
          <span>
            <b>Allow every upstream model</b>
            <small>Turn this off to create a strict model allowlist.</small>
          </span>
        </label>
        {!allowAll && (
          <>
            <label>
              Allowed models
              <textarea
                aria-describedby="models-help"
                onChange={(event) => setModels(event.target.value)}
                placeholder={"gpt-6-luna\ngpt-6.1-sol"}
                value={models}
              />
            </label>
            <small id="models-help">
              One model per line or comma-separated. The proxy rejects other
              model IDs.
            </small>
            {catalogModels.length > 0 && (
              <div className="model-picker" aria-label="Synced Cockpit models">
                <small>
                  Click a synced model to add or remove it from this key.
                </small>
                <div className="model-chip-list">
                  {catalogModels.map((model) => {
                    const selected = selectedModels.includes(model.model_id);
                    return (
                      <button
                        className={
                          selected ? "model-chip selected" : "model-chip"
                        }
                        key={model.model_id}
                        onClick={() => {
                          const next = selected
                            ? selectedModels.filter(
                                (id) => id !== model.model_id,
                              )
                            : [...selectedModels, model.model_id];
                          setModels(next.join("\n"));
                        }}
                        type="button"
                      >
                        {model.model_id}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
        {error && <Notice message={error} />}
        <button disabled={busy} type="submit">
          {busy ? "Creating…" : "Create key"}
        </button>
      </form>
    </article>
  );
}
function ModelCatalogPanel({
  csrf,
  signal,
  isSessionActive,
  catalog,
  onSynced,
}: {
  csrf: string;
  signal?: AbortSignal;
  isSessionActive: () => boolean;
  catalog: ModelCatalog;
  onSynced: (catalog: ModelCatalog, message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [panelError, setPanelError] = useState("");
  const active = catalog.data.filter((model) => model.available === 1);
  return (
    <article className="panel model-catalog">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">MODEL CATALOG</p>
          <h2>Available Cockpit models</h2>
          <p>
            {catalog.lastSyncedAt
              ? `Last synced ${formatDate(catalog.lastSyncedAt)}.`
              : "Not synced yet."}
          </p>
        </div>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setPanelError("");
            try {
              const synced = await api<ModelCatalog & { count: number }>(
                "models/sync",
                { method: "POST", signal, body: "{}" },
                csrf,
              );
              if (!isSessionActive()) return;
              onSynced(
                synced,
                `Synced ${synced.count} model${synced.count === 1 ? "" : "s"} from Cockpit.`,
              );
            } catch (reason) {
              if (!signal?.aborted && isSessionActive())
                setPanelError((reason as Error).message);
            } finally {
              if (isSessionActive()) setBusy(false);
            }
          }}
          type="button"
        >
          {busy ? "Syncing…" : "Sync from Cockpit"}
        </button>
      </div>
      {panelError && <Notice message={panelError} />}
      {active.length === 0 ? (
        <p className="empty">Sync the catalog to load models from Cockpit.</p>
      ) : (
        <ul className="catalog-list">
          {active.map((model) => (
            <li key={model.model_id}>
              <code>{model.model_id}</code>
              <small>
                {[model.object_type, model.owned_by]
                  .filter(Boolean)
                  .join(" · ") || "Cockpit model"}
              </small>
            </li>
          ))}
        </ul>
      )}
      <p className="subtle">
        Future aliases can map public model names to these upstream IDs. Syncing
        does not change public API model IDs today.
      </p>
    </article>
  );
}
function KeySecret({
  secret,
  message,
  onClose,
}: {
  secret: string;
  message: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const dismiss = useRef<HTMLButtonElement>(null);
  useEffect(() => dismiss.current?.focus(), []);
  return (
    <section
      aria-label="New API key"
      aria-live="polite"
      className="secret-card"
      tabIndex={-1}
    >
      <div>
        <p className="eyebrow">NEW KEY</p>
        <h2>Store this key now</h2>
        <p>{message}</p>
      </div>
      <code>{secret}</code>
      <div className="action-row">
        <button
          className="quiet"
          onClick={async () => {
            setCopyError("");
            if (!navigator.clipboard?.writeText) {
              setCopyError(
                "Clipboard access is unavailable. Select and copy the key manually.",
              );
              return;
            }
            try {
              await navigator.clipboard.writeText(secret);
              setCopied(true);
            } catch {
              setCopyError(
                "The browser could not copy this key. Select and copy it manually.",
              );
            }
          }}
        >
          {copied ? "Copied" : "Copy key"}
        </button>
        <button onClick={onClose} ref={dismiss}>
          I stored it
        </button>
      </div>
      {copyError && <Notice message={copyError} />}
    </section>
  );
}

function KeyList({
  csrf,
  signal,
  isSessionActive,
  keys,
  onRefresh,
}: {
  csrf: string;
  signal?: AbortSignal;
  isSessionActive: () => boolean;
  keys: Key[];
  onRefresh: () => Promise<void>;
}) {
  const [pending, setPending] = useState<number>();
  const [error, setError] = useState("");
  const [confirmId, setConfirmId] = useState<number>();
  const revoke = async (id: number) => {
    setPending(id);
    setError("");
    try {
      await api(
        `keys/${id}/revoke`,
        { method: "POST", body: "{}", signal },
        csrf,
      );
      if (!isSessionActive()) return;
      await onRefresh();
      if (!isSessionActive()) return;
      setConfirmId(undefined);
    } catch (reason) {
      if (!signal?.aborted && isSessionActive())
        setError((reason as Error).message);
    } finally {
      if (isSessionActive()) setPending(undefined);
    }
  };
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>API keys</h2>
          <p>
            {keys.length} issued key{keys.length === 1 ? "" : "s"}. Revocation
            takes effect on the next request.
          </p>
        </div>
      </div>
      {error && <Notice message={error} />}
      <div className="key-list">
        {keys.length === 0 ? (
          <p className="empty">No API keys have been issued.</p>
        ) : (
          keys.map((key) => {
            const revoked = Boolean(key.revoked_at);
            const expired = Boolean(
              key.expires_at && new Date(key.expires_at) <= new Date(),
            );
            return (
              <article className="key-row" key={key.id}>
                <div className="key-name">
                  <b>{key.name}</b>
                  <small>
                    {key.prefix}… ·{" "}
                    {key.allow_all_models
                      ? "All models"
                      : key.models?.length
                        ? `Restricted: ${key.models.join(", ")}`
                        : "Restricted models"}
                  </small>
                </div>
                <div className="key-meta">
                  <span>{key.rpm_limit} RPM</span>
                  <span>{key.concurrency_limit} concurrent</span>
                  <span>Expires {formatDate(key.expires_at)}</span>
                  <span>Last used {formatDate(key.last_used_at)}</span>
                </div>
                <div className="key-actions">
                  {revoked ? (
                    <span className="badge muted">Revoked</span>
                  ) : expired ? (
                    <span className="badge warn">Expired</span>
                  ) : confirmId === key.id ? (
                    <>
                      <button
                        className="quiet"
                        onClick={() => setConfirmId(undefined)}
                      >
                        Cancel
                      </button>
                      <button
                        className="danger"
                        disabled={pending === key.id}
                        onClick={() => void revoke(key.id)}
                      >
                        {pending === key.id ? "Revoking…" : "Confirm revoke"}
                      </button>
                    </>
                  ) : (
                    <button
                      className="danger"
                      onClick={() => setConfirmId(key.id)}
                    >
                      Revoke
                    </button>
                  )}
                </div>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
function Requests({ rows }: { rows: RequestEvent[] }) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Recent requests</h2>
          <p>
            Metadata only. Prompts, completions and authorization values are
            never stored.
          </p>
        </div>
      </div>
      <div className="data-table">
        <div className="data-head">
          <span>Request</span>
          <span>Result</span>
          <span>Usage</span>
          <span>Time</span>
        </div>
        {rows.length === 0 ? (
          <p className="empty">No request metadata yet.</p>
        ) : (
          rows.map((row) => (
            <article className="data-row" key={row.id}>
              <div data-label="Request">
                <b>{row.endpoint}</b>
                <small>
                  {row.model ?? "No model"} ·{" "}
                  {row.key_name ?? row.key_prefix ?? "Unknown key"}
                </small>
              </div>
              <div data-label="Result">
                <span className={`badge ${row.status >= 400 ? "bad" : "good"}`}>
                  {row.status}
                </span>
                <small>
                  {row.duration_ms} ms · {row.streamed ? "Stream" : "JSON"}
                  {row.error_code ? ` · ${row.error_code}` : ""}
                </small>
              </div>
              <div data-label="Usage">
                <small>{formatUsage(row.usage_json)}</small>
              </div>
              <div data-label="Time">
                <small>{formatDate(row.created_at)}</small>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
function UsageTable({ rows }: { rows: Usage[] }) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Usage by day, key and model</h2>
          <p>
            Token totals remain unavailable when the upstream does not return
            usage; unavailable values are never treated as zero. Cache rate is
            cached input tokens divided by input tokens, not a request hit rate.
          </p>
        </div>
      </div>
      <div className="data-table">
        <div className="data-head usage-head">
          <span>Day</span>
          <span>Key</span>
          <span>Model</span>
          <span>Requests</span>
          <span>Token usage</span>
        </div>
        {rows.length === 0 ? (
          <p className="empty">No aggregated usage yet.</p>
        ) : (
          rows.map((row, index) => (
            <article
              className="data-row usage-row"
              key={`${row.day}-${row.keyId ?? "none"}-${row.model ?? "none"}-${index}`}
            >
              <div data-label="Day">
                <b>{row.day}</b>
              </div>
              <div data-label="Key">
                <small>{row.keyName ?? row.keyPrefix ?? "Unknown key"}</small>
              </div>
              <div data-label="Model">
                <small>{row.model ?? "No model"}</small>
              </div>
              <div data-label="Requests">
                <b>{row.requests}</b>
                <small>
                  {row.unknownUsage
                    ? `${row.unknownUsage} unavailable`
                    : "All reported"}
                </small>
                <small>
                  {(row.unknownCachedUsage ?? 0) === 0 &&
                  (row.unknownReasoningUsage ?? 0) === 0
                    ? "All cache/reasoning reported"
                    : `${row.unknownCachedUsage ?? 0} cache unavailable; ${row.unknownReasoningUsage ?? 0} reasoning unavailable`}
                </small>
              </div>
              <div data-label="Token usage">
                <small>
                  {row.totalTokens == null
                    ? "Usage unavailable"
                    : `${row.totalTokens.toLocaleString()} total · ${row.inputTokens == null ? "—" : row.inputTokens.toLocaleString()} input · ${row.outputTokens == null ? "—" : row.outputTokens.toLocaleString()} output`}
                </small>
                <small>{formatAggregateUsage(row)}</small>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
function Audit({ rows }: { rows: AuditEvent[] }) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Admin audit</h2>
          <p>
            Security-relevant administrative actions retained independently from
            request metadata.
          </p>
        </div>
      </div>
      <div className="data-table">
        <div className="data-head">
          <span>Action</span>
          <span>Target</span>
          <span>Time</span>
          <span>Safe metadata</span>
        </div>
        {rows.length === 0 ? (
          <p className="empty">No audit events yet.</p>
        ) : (
          rows.map((row) => (
            <article className="data-row audit-row" key={row.id}>
              <div data-label="Action">
                <b>{row.action}</b>
              </div>
              <div data-label="Target">
                <small>
                  {row.target_type} · {row.target_id}
                </small>
              </div>
              <div data-label="Time">
                <small>{formatDate(row.created_at)}</small>
              </div>
              <div data-label="Safe metadata">
                <small>{row.metadata_json || "—"}</small>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

export function App() {
  const [session, setSession] = useState<Session>();
  const [csrf, setCsrf] = useState("");
  const [overview, setOverview] = useState<Overview>();
  const [upstream, setUpstream] = useState<Upstream>();
  const [keys, setKeys] = useState<Key[]>([]);
  const [requests, setRequests] = useState<RequestEvent[]>([]);
  const [usage, setUsage] = useState<Usage[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalog>({ data: [] });
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loginError, setLoginError] = useState("");
  const [secret, setSecret] = useState("");
  const [secretMessage, setSecretMessage] = useState("");
  const refreshController = useRef<AbortController | null>(null);
  const refreshGeneration = useRef(0);
  const sessionController = useRef<AbortController | null>(null);
  const sessionGeneration = useRef(0);
  const activeCsrf = useRef("");
  const clearSensitive = useCallback((notice = "") => {
    refreshGeneration.current += 1;
    sessionGeneration.current += 1;
    refreshController.current?.abort();
    sessionController.current?.abort();
    sessionController.current = null;
    activeCsrf.current = "";
    setSession(undefined);
    setCsrf("");
    setOverview(undefined);
    setUpstream(undefined);
    setKeys([]);
    setRequests([]);
    setUsage([]);
    setAudit([]);
    setCatalog({ data: [] });
    setSecret("");
    setSecretMessage("");
    setTab("overview");
    setError("");
    setNotice("");
    setLoginError(notice);
  }, []);
  const activateSession = useCallback(
    (next: Session) => {
      const token = next.csrfToken ?? "";
      if (!token) {
        setLoginError(
          "The server did not provide a session token. Sign in again after the server is updated.",
        );
        return;
      }
      clearSensitive();
      activeCsrf.current = token;
      sessionController.current = new AbortController();
      setLoginError("");
      setCsrf(token);
      setSession(next);
    },
    [clearSensitive],
  );
  const refresh = useCallback(async () => {
    if (!csrf || activeCsrf.current !== csrf) return;
    refreshController.current?.abort();
    const controller = new AbortController();
    refreshController.current = controller;
    const generation = ++refreshGeneration.current;
    setError("");
    const request = <T,>(path: string) =>
      api<T>(path, { signal: controller.signal }).catch((reason: unknown) => {
        if (
          reason instanceof ApiError &&
          reason.status === 401 &&
          generation === refreshGeneration.current
        )
          clearSensitive("Your admin session ended. Sign in again.");
        throw reason;
      });
    const results = await Promise.allSettled([
      request<Overview>("overview"),
      request<{ data: Key[] }>("keys"),
      request<{ data: RequestEvent[] }>("requests"),
      request<{ data: Usage[] }>("usage"),
      request<{ data: AuditEvent[] }>("audit"),
      request<Upstream>("upstream"),
      request<ModelCatalog>("models"),
    ]);
    if (controller.signal.aborted || generation !== refreshGeneration.current)
      return;
    const labels = [
      "overview",
      "keys",
      "requests",
      "usage",
      "audit",
      "upstream",
      "models",
    ];
    const failed = results.flatMap((result, index) =>
      result.status === "rejected" ? [labels[index]] : [],
    );
    const [
      nextOverview,
      nextKeys,
      nextRequests,
      nextUsage,
      nextAudit,
      nextUpstream,
      nextCatalog,
    ] = results;
    if (nextOverview.status === "fulfilled") setOverview(nextOverview.value);
    if (nextKeys.status === "fulfilled") setKeys(nextKeys.value.data);
    if (nextRequests.status === "fulfilled")
      setRequests(nextRequests.value.data);
    if (nextUsage.status === "fulfilled") setUsage(nextUsage.value.data);
    if (nextAudit.status === "fulfilled") setAudit(nextAudit.value.data);
    if (nextUpstream.status === "fulfilled") setUpstream(nextUpstream.value);
    if (nextCatalog.status === "fulfilled") setCatalog(nextCatalog.value);
    if (failed.length)
      setError(`Some sections could not refresh: ${failed.join(", ")}.`);
  }, [clearSensitive, csrf]);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const restored = await api<Session>("session", {
          signal: controller.signal,
        });
        const token = restored.csrfToken ?? "";
        if (!token || controller.signal.aborted || activeCsrf.current) return;
        activateSession(restored);
      } catch {
        /* An anonymous visitor remains on the sign-in page. */
      }
    })();
    return () => controller.abort();
  }, [activateSession]);
  useEffect(() => {
    if (session && csrf) void refresh();
    return () => refreshController.current?.abort();
  }, [session, csrf, refresh]);
  const successRate = useMemo(
    () =>
      overview?.total
        ? Math.round(((overview.success ?? 0) / overview.total) * 100)
        : 0,
    [overview],
  );
  const sessionScope = useMemo(() => {
    const controller = sessionController.current;
    const generation = sessionGeneration.current;
    const token = csrf;
    return {
      signal: controller?.signal,
      isActive: () =>
        Boolean(token) &&
        activeCsrf.current === token &&
        sessionGeneration.current === generation &&
        !controller?.signal.aborted,
    };
  }, [csrf, session]);
  if (!session || !csrf)
    return (
      <Login
        notice={loginError}
        onLogin={(next) => {
          activateSession(next);
        }}
      />
    );
  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">API HNQ / ADMIN</p>
          <h1>Gateway status</h1>
          <p className="subtle">Signed in as {session.user.username}</p>
        </div>
        <div className="header-actions">
          <span
            className={`connection ${upstream?.ok ? "online" : "offline"}`}
            title={
              upstream?.ok
                ? `Upstream HTTP ${upstream.status}`
                : "Cockpit is unreachable"
            }
          >
            {upstream?.ok ? "Cockpit online" : "Cockpit unavailable"}
          </span>
          <button className="quiet" onClick={() => void refresh()}>
            Refresh
          </button>
          <button
            className="quiet"
            onClick={async () => {
              const token = csrf;
              clearSensitive();
              try {
                await api("session", { method: "DELETE" }, token);
              } catch {
                setLoginError(
                  "The browser cleared local admin data, but sign-out could not be confirmed by the server. Reload and sign in again before continuing.",
                );
              }
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      {error && <Notice message={error} />}
      {notice && <Notice message={notice} tone="success" />}
      <nav
        aria-label="Admin sections"
        className="tabs"
        role="tablist"
        onKeyDown={(event) => {
          const tabs: Tab[] = ["overview", "requests", "usage", "audit"];
          const current = tabs.indexOf(tab);
          const direction =
            event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
          if (!direction) return;
          event.preventDefault();
          const next = tabs[(current + direction + tabs.length) % tabs.length];
          setTab(next);
          document.getElementById(`${next}-tab`)?.focus();
        }}
      >
        {(["overview", "requests", "usage", "audit"] as Tab[]).map((item) => (
          <button
            aria-controls={`${item}-panel`}
            aria-selected={tab === item}
            className={tab === item ? "active" : "quiet"}
            id={`${item}-tab`}
            key={item}
            onClick={() => setTab(item)}
            role="tab"
            tabIndex={tab === item ? 0 : -1}
          >
            {item === "overview"
              ? "Overview"
              : item === "requests"
                ? "Requests"
                : item === "usage"
                  ? "Usage"
                  : "Audit"}
          </button>
        ))}
      </nav>
      {tab === "overview" && (
        <section
          aria-labelledby="overview-tab"
          id="overview-panel"
          role="tabpanel"
        >
          <section className="metrics">
            <Metric label="Requests · 24h" value={overview?.total ?? 0} />
            <Metric
              label="Successful"
              value={`${successRate}%`}
              hint={`${overview?.success ?? 0} completed`}
            />
            <Metric
              label="Average latency"
              value={`${Math.round(overview?.latency ?? 0)}ms`}
            />
            <Metric
              label="Active streams"
              value={overview?.activeStreams ?? 0}
            />
          </section>
          <section className="two-column">
            <KeyForm
              catalogModels={catalog.data.filter(
                (model) => model.available === 1,
              )}
              csrf={csrf}
              isSessionActive={sessionScope.isActive}
              onCreated={(nextSecret, message) => {
                setSecret(nextSecret);
                setSecretMessage(message);
                void refresh();
              }}
              signal={sessionScope.signal}
            />
            <article className="panel health-panel">
              <p className="eyebrow">UPSTREAM</p>
              <h2>
                {upstream?.ok
                  ? "Cockpit is available"
                  : "Cockpit needs attention"}
              </h2>
              <p>
                {upstream?.ok
                  ? `The last health probe returned HTTP ${upstream.status}.`
                  : "The last health probe did not reach a healthy upstream response."}
              </p>
              <button className="quiet" onClick={() => void refresh()}>
                Check again
              </button>
            </article>
          </section>
          <ModelCatalogPanel
            catalog={catalog}
            csrf={csrf}
            isSessionActive={sessionScope.isActive}
            onSynced={(nextCatalog, message) => {
              setCatalog(nextCatalog);
              setNotice(message);
            }}
            signal={sessionScope.signal}
          />
          {secret && (
            <KeySecret
              message={secretMessage}
              onClose={() => {
                setSecret("");
                setSecretMessage("");
              }}
              secret={secret}
            />
          )}
          <KeyList
            csrf={csrf}
            isSessionActive={sessionScope.isActive}
            keys={keys}
            onRefresh={refresh}
            signal={sessionScope.signal}
          />
        </section>
      )}
      {tab === "requests" && (
        <section
          aria-labelledby="requests-tab"
          id="requests-panel"
          role="tabpanel"
        >
          <Requests rows={requests} />
        </section>
      )}
      {tab === "usage" && (
        <section aria-labelledby="usage-tab" id="usage-panel" role="tabpanel">
          <UsageTable rows={usage} />
        </section>
      )}
      {tab === "audit" && (
        <section aria-labelledby="audit-tab" id="audit-panel" role="tabpanel">
          <Audit rows={audit} />
        </section>
      )}
    </main>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
