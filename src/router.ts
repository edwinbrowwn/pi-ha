import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRegistry, ModelRouteRequest } from "@earendil-works/pi-coding-agent";

export interface Endpoint {
  provider: string;
  model: string;
  label: string;
  healthPath: string;
  timeoutMs: number;
  baseUrl?: string;
}

export interface HaConfig {
  id: string;
  name: string;
  cacheTtlMs: number;
  endpoints: Endpoint[];
  contextWindow?: number;
  maxTokens?: number;
  input?: ("text" | "image")[];
  thinkingLevels: ModelThinkingLevel[];
}

const LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function parseConfig(value: unknown): HaConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("pi-ha: config must be an object");
  const config = value as Record<string, unknown>;
  const text = (value: unknown, field: string): string => {
    if (typeof value !== "string" || !value.trim()) throw new Error(`pi-ha: ${field} must be a nonempty string`);
    return value;
  };
  const number = (value: unknown, field: string, min = 1): number => {
    if (!Number.isSafeInteger(value) || (value as number) < min) throw new Error(`pi-ha: ${field} must be an integer >= ${min}`);
    return value as number;
  };
  if (!Array.isArray(config.endpoints) || config.endpoints.length < 2) throw new Error("pi-ha: configure at least two ordered endpoints");
  const timeoutMs = number(config.probeTimeoutMs ?? 100, "probeTimeoutMs");
  const endpoints = config.endpoints.map((value, index): Endpoint => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`pi-ha: endpoint ${index + 1} must be an object`);
    const endpoint = value as Record<string, unknown>;
    const provider = text(endpoint.provider, "endpoint provider");
    const model = text(endpoint.model, "endpoint model");
    const healthPath = text(endpoint.healthPath ?? "/v1/models", "healthPath");
    if (!healthPath.startsWith("/") || healthPath.startsWith("//") || healthPath.includes("\\") || healthPath.includes("#")) {
      throw new Error("pi-ha: healthPath must be an absolute same-origin path, e.g. /health or /v1/models");
    }
    if (provider === "pi-ha") throw new Error("pi-ha: endpoints must be physical models, not pi-ha aliases");
    let baseUrl: string | undefined;
    if (endpoint.baseUrl !== undefined) {
      const url = new URL(text(endpoint.baseUrl, "endpoint baseUrl"));
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("pi-ha: baseUrl must be HTTP(S) without URL credentials, query or fragment");
      baseUrl = url.href.replace(/\/$/, "");
    }
    return { provider, model, label: text(endpoint.label ?? provider, "label"), healthPath, timeoutMs: number(endpoint.timeoutMs ?? timeoutMs, "endpoint timeoutMs"), ...(baseUrl ? { baseUrl } : {}) };
  });
  if (new Set(endpoints.map(e => JSON.stringify([e.provider, e.model, e.baseUrl]))).size !== endpoints.length) throw new Error("pi-ha: duplicate endpoint model references");
  const thinkingLevels = config.thinkingLevels ?? LEVELS;
  if (!Array.isArray(thinkingLevels) || !thinkingLevels.length || thinkingLevels.some(level => !LEVELS.includes(level))) throw new Error("pi-ha: invalid thinkingLevels");
  if (config.input !== undefined && (!Array.isArray(config.input) || !config.input.length || config.input.some(input => input !== "text" && input !== "image"))) throw new Error("pi-ha: input must contain text and/or image");
  return {
    id: text(config.id ?? "auto", "id"), name: text(config.name ?? "HA (pi-ha)", "name"),
    cacheTtlMs: number(config.cacheTtlMs ?? 10_000, "cacheTtlMs", 0), endpoints,
    thinkingLevels: [...thinkingLevels] as ModelThinkingLevel[],
    ...(config.contextWindow !== undefined ? { contextWindow: number(config.contextWindow, "contextWindow") } : {}),
    ...(config.maxTokens !== undefined ? { maxTokens: number(config.maxTokens, "maxTokens") } : {}),
    ...(config.input !== undefined ? { input: [...config.input] as ("text" | "image")[] } : {}),
  };
}

type Registry = Pick<ModelRegistry, "find" | "getApiKeyAndHeaders">;
interface Health { healthy: boolean; reason: string; expiresAt: number; baseUrl: string }

// Only transport failures invalidate cached reachability. Auth, quota, request and
// context errors should keep Pi's normal handling; another address won't fix them.
export function isTransportError(message: string): boolean {
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|fetch failed|network error|connection (?:error|refused|reset|timed out|closed)|connect(?:ion)? timeout|socket hang up/i.test(message);
}

export class HaRouter {
  private health = new Map<string, Health>();
  private lastChoice?: string;
  private blockedNext?: string;

  readonly config: HaConfig;
  private fetcher: typeof fetch;
  private now: () => number;

  constructor(config: HaConfig, fetcher: typeof fetch = fetch, now: () => number = Date.now) {
    this.config = config;
    this.fetcher = fetcher;
    this.now = now;
  }

  reset(): void { this.health.clear(); this.lastChoice = undefined; this.blockedNext = undefined; }

  markFailed(endpoint: Endpoint, model: Model<Api>): void {
    const key = this.key(endpoint);
    this.blockedNext = key;
    this.health.set(key, { healthy: false, reason: "previous request had a transport error", expiresAt: this.now() + this.config.cacheTtlMs, baseUrl: model.baseUrl });
  }

  status(): string {
    const lines = [`${this.config.name}: ${this.lastChoice ?? "not routed yet"}`];
    for (const endpoint of this.config.endpoints) {
      const result = this.health.get(this.key(endpoint));
      const cached = result && result.expiresAt > this.now();
      lines.push(`${endpoint.label}: ${cached ? result.reason : "check due"} (${endpoint.timeoutMs} ms probe deadline)`);
    }
    return lines.join("\n");
  }

  private key(endpoint: Endpoint): string { return JSON.stringify([endpoint.provider, endpoint.model, endpoint.baseUrl]); }

  async choose(registry: Registry, request: Pick<ModelRouteRequest, "reason" | "failed" | "signal">): Promise<{ model: Model<Api>; label: string; endpoint: Endpoint }> {
    request.signal?.throwIfAborted();
    const failed = request.reason === "retry" ? request.failed : undefined;
    const failedEndpoint = failed && this.config.endpoints.find(e => e.provider === failed.model.provider && e.model === failed.model.id && (!e.baseUrl || e.baseUrl === failed.model.baseUrl));
    let blockedKey = this.blockedNext;
    this.blockedNext = undefined;
    if (failed && failedEndpoint) {
      if (failed.message.stopReason === "error" && isTransportError(failed.message.errorMessage ?? "")) {
        blockedKey = this.key(failedEndpoint);
        this.health.set(blockedKey, { healthy: false, reason: "previous request had a transport error", expiresAt: this.now() + this.config.cacheTtlMs, baseUrl: failed.model.baseUrl });
      } else {
        const model = registry.find(failedEndpoint.provider, failedEndpoint.model);
        if (model) {
          this.lastChoice = failedEndpoint.label;
          return { model, label: failedEndpoint.label, endpoint: failedEndpoint };
        }
      }
    }
    const failures: string[] = [];
    for (const endpoint of this.config.endpoints) {
      request.signal?.throwIfAborted();
      const source = registry.find(endpoint.provider, endpoint.model);
      const model = source && endpoint.baseUrl ? { ...source, baseUrl: endpoint.baseUrl } : source;
      if (!model || model.api === "pi-virtual") {
        failures.push(`${endpoint.label}: physical model not configured`);
        continue;
      }
      const key = this.key(endpoint);
      let result = this.health.get(key);
      // Invalidate on catalog endpoint changes (e.g. after editing models.json).
      if (result && result.baseUrl !== model.baseUrl) result = undefined;
      if (key === blockedKey && result?.baseUrl === model.baseUrl) {
        failures.push(`${endpoint.label}: previous request had a transport error`);
        continue;
      }
      if (!result || result.expiresAt <= this.now()) {
        result = await this.probe(model, endpoint, registry, request.signal);
        request.signal?.throwIfAborted();
        this.health.set(key, result);
      }
      if (result.healthy) {
        this.lastChoice = endpoint.label;
        return { model, label: endpoint.label, endpoint };
      }
      failures.push(`${endpoint.label}: ${result.reason}`);
    }
    this.lastChoice = undefined;
    throw new Error(`pi-ha: no reachable endpoint (${failures.join("; ")})`);
  }

  private async probe(model: Model<Api>, endpoint: Endpoint, registry: Registry, signal?: AbortSignal): Promise<Health> {
    const result = (healthy: boolean, reason: string): Health => ({ healthy, reason, expiresAt: this.now() + this.config.cacheTtlMs, baseUrl: model.baseUrl });
    const auth = await registry.getApiKeyAndHeaders(model);
    signal?.throwIfAborted();
    if (!auth.ok) return result(false, "credentials unavailable");
    const baseUrl = new URL(endpoint.baseUrl ?? auth.baseUrl ?? model.baseUrl);
    if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) throw new Error("pi-ha: endpoints must use HTTP(S) without URL credentials");
    let url = new URL(endpoint.healthPath, baseUrl);
    if (url.origin !== baseUrl.origin) throw new Error("pi-ha: health checks must stay on the configured endpoint");
    const modelsUrl = new URL(baseUrl);
    modelsUrl.pathname = `${baseUrl.pathname.replace(/\/$/, "")}/models`;
    modelsUrl.search = "";
    modelsUrl.hash = "";
    const headers = new Headers();
    for (const [name, value] of Object.entries(auth.headers ?? {})) {
      if (value !== null) headers.set(name, value);
    }
    // Pi uses a null header value to suppress an API default (including auth).
    const hasAuthOverride = Object.keys(auth.headers ?? {}).some(name => name.toLowerCase() === "authorization");
    if (auth.apiKey && !hasAuthOverride) headers.set("Authorization", `Bearer ${auth.apiKey}`);
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), endpoint.timeoutMs);
    let response: Response | undefined;
    try {
      const options = { method: "GET", headers, redirect: "error" as const, signal: controller.signal };
      response = await this.fetcher(url, options);
      // A server without /health can still be checked without inference. Both
      // requests share the original deadline, not a fresh timeout each.
      if ([404, 405].includes(response.status) && url.href !== modelsUrl.href) {
        await response.body?.cancel();
        url = modelsUrl;
        response = await this.fetcher(url, options);
      }
      if (!response.ok) return result(false, `HTTP ${response.status}`);
      const isModels = url.pathname.endsWith("/models");
      const data = isModels || response.headers.get("content-type")?.includes("json") ? await response.json() : undefined;
      if (data?.data !== undefined || isModels) {
        if (!Array.isArray(data?.data) || !data.data.some((entry: { id?: string }) => entry?.id === model.id)) return result(false, "model not served");
      } else if (typeof data?.model === "string" && data.model !== model.id) {
        return result(false, "model not served");
      }
      return result(true, "healthy");
    } catch {
      signal?.throwIfAborted();
      return result(false, controller.signal.aborted ? "probe timed out" : "probe failed");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
    }
  }
}
