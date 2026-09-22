import { CoolifyError, type Capability, type CoolifyErrorKind } from "./types"

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Accepts what a human would paste — `coolify.example.com`,
 * `https://coolify.example.com`, or a URL that already ends in `/api/v1` — and
 * returns the canonical API base URL.
 */
export function normalizeEndpoint(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === "") throw new Error("Coolify endpoint is empty")
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  const url = new URL(withScheme)
  let path = url.pathname.replace(/\/+$/, "")
  if (!path.endsWith("/api/v1")) path = `${path}/api/v1`
  url.pathname = path
  url.search = ""
  url.hash = ""
  return url.toString().replace(/\/+$/, "")
}

export interface RequestSpec {
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
  readonly path: string
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>
  readonly body?: unknown
  /** The ability this endpoint needs, used to learn from a `403`. */
  readonly requires?: Capability
  readonly signal?: AbortSignal
}

export interface CoolifyClientOptions {
  readonly endpoint: string
  readonly token: string
  readonly fetch?: typeof globalThis.fetch
  readonly timeoutMs?: number
  /**
   * Bounded retries for idempotent GETs that hit `429` or a `5xx`. Writes are
   * never retried, because a repeated POST is not guaranteed to be idempotent.
   * Defaults to 2.
   */
  readonly retries?: number
  /**
   * Called when a request proves the token lacks an ability, so the plugin can
   * downgrade its capability report instead of repeatedly hitting `403`.
   */
  readonly onDenied?: (event: { capability: Capability; method: string; path: string }) => void
}

interface Outcome {
  readonly ok: boolean
  readonly status: number
  readonly payload: unknown
  readonly statusText: string
  readonly headers: Headers
}

const MAX_RETRY_DELAY_MS = 4_000

export class CoolifyClient {
  readonly endpoint: string
  readonly #token: string
  readonly #fetch: typeof globalThis.fetch
  readonly #timeoutMs: number
  readonly #retries: number
  readonly #onDenied: CoolifyClientOptions["onDenied"]

  constructor(options: CoolifyClientOptions) {
    this.endpoint = normalizeEndpoint(options.endpoint)
    this.#token = options.token
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#retries = options.retries ?? 2
    this.#onDenied = options.onDenied
  }

  get origin(): string {
    try {
      return new URL(this.endpoint).origin
    } catch {
      return this.endpoint
    }
  }

  async request<T = unknown>(spec: RequestSpec): Promise<T> {
    const retryable = spec.method === "GET"

    for (let attempt = 0; ; attempt += 1) {
      const outcome = await this.#send(spec)
      if (outcome.ok) return outcome.payload as T

      const kind = classify(outcome.status, outcome.payload)

      if (retryable && attempt < this.#retries && (outcome.status === 429 || outcome.status >= 500)) {
        await sleep(retryDelay(outcome.headers, attempt), spec.signal)
        continue
      }

      if ((kind === "forbidden" || kind === "missing_sensitive") && spec.requires) {
        const capability: Capability = kind === "missing_sensitive" ? "read:sensitive" : spec.requires
        if (capability !== "read") this.#onDenied?.({ capability, method: spec.method, path: spec.path })
      }

      throw new CoolifyError({
        kind,
        message: messageOf(outcome.payload) ?? `${outcome.status} ${outcome.statusText}`,
        method: spec.method,
        path: spec.path,
        status: outcome.status,
        body: outcome.payload,
        retryAfterSeconds: retryAfter(outcome.headers),
      })
    }
  }

  async #send(spec: RequestSpec): Promise<Outcome> {
    const url = new URL(`${this.endpoint}${spec.path}`)
    for (const [key, value] of Object.entries(spec.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const signals: AbortSignal[] = []
    if (spec.signal) signals.push(spec.signal)
    if (this.#timeoutMs > 0) signals.push(AbortSignal.timeout(this.#timeoutMs))

    let response: Response
    try {
      response = await this.#fetch(url, {
        method: spec.method,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          Accept: "application/json",
          ...(spec.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
        signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
      })
    } catch (cause) {
      throw new CoolifyError({
        kind: "network",
        message: `Cannot reach ${url.origin}: ${cause instanceof Error ? cause.message : String(cause)}`,
        method: spec.method,
        path: spec.path,
      })
    }

    const text = await response.text()
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      payload: parseBody(text),
      headers: response.headers,
    }
  }

  get<T = unknown>(path: string, options: Omit<RequestSpec, "method" | "path"> = {}): Promise<T> {
    return this.request<T>({ ...options, method: "GET", path })
  }

  post<T = unknown>(path: string, options: Omit<RequestSpec, "method" | "path"> = {}): Promise<T> {
    return this.request<T>({ ...options, method: "POST", path })
  }

  patch<T = unknown>(path: string, options: Omit<RequestSpec, "method" | "path"> = {}): Promise<T> {
    return this.request<T>({ ...options, method: "PATCH", path })
  }
}

function retryDelay(headers: Headers, attempt: number): number {
  const after = retryAfter(headers)
  if (after !== undefined) return Math.min(after * 1_000, MAX_RETRY_DELAY_MS)
  return Math.min(250 * 2 ** attempt, MAX_RETRY_DELAY_MS)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error("aborted"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function parseBody(text: string): unknown {
  if (text === "") return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function classify(status: number, payload: unknown): CoolifyErrorKind {
  if (status === 401) return "unauthorized"
  if (status === 403) {
    const message = messageOf(payload) ?? ""
    return /sensitive/i.test(message) ? "missing_sensitive" : "forbidden"
  }
  if (status === 404) return "not_found"
  if (status === 400 || status === 422) return "validation"
  if (status === 429) return "rate_limited"
  if (status >= 500) return "server"
  return "unknown"
}

function messageOf(payload: unknown): string | undefined {
  if (payload === undefined || payload === null) return undefined
  if (typeof payload === "string") return payload
  if (typeof payload !== "object") return String(payload)
  const record = payload as Record<string, unknown>
  for (const key of ["message", "error", "errors"]) {
    const value = record[key]
    if (typeof value === "string" && value !== "") return value
    if (value && typeof value === "object") {
      const nested = Object.values(value as Record<string, unknown>).flat()
      if (nested.length > 0) return nested.map(String).join(", ")
    }
  }
  return undefined
}

function retryAfter(headers: Headers): number | undefined {
  const raw = headers.get("retry-after")
  if (!raw) return undefined
  const seconds = Number(raw)
  return Number.isFinite(seconds) ? seconds : undefined
}
