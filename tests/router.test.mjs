import assert from "node:assert/strict";
import { test } from "node:test";
import { HaRouter, parseConfig, isTransportError } from "../src/router.ts";

const rawConfig = () => ({
  endpoints: [
    { provider: "lan", model: "test-model", label: "LAN", healthPath: "/health", timeoutMs: 30 },
    { provider: "remote", model: "test-model", label: "Tailscale", healthPath: "/health", timeoutMs: 200 },
  ],
  cacheTtlMs: 1000,
});
const model = (provider, baseUrl = `http://${provider}.test:8000/v1`) => ({
  provider, baseUrl, id: "test-model", name: "Test model", api: "openai-completions", reasoning: true,
  contextWindow: 65536, maxTokens: 4096, input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
function registry() {
  const models = new Map(["lan", "remote"].map(p => [p, model(p)]));
  return {
    models,
    find(provider, id) { const m = models.get(provider); return m?.id === id ? m : undefined; },
    async getApiKeyAndHeaders(m) { return { ok: true, apiKey: `test-${m.provider}`, headers: { "X-Endpoint": m.provider } }; },
  };
}
const healthy = () => Response.json({ status: "ok", model: "test-model" });
const modelsResponse = () => Response.json({ data: [{ id: "test-model" }] });
const request = { reason: "user" };
function waitForAbort(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
function delayedResponse(ms, signal, response = healthy) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(response()); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function failedRequest(r, errorMessage, stopReason = "error") {
  return { reason: "retry", failed: { model: r.models.get("lan"), message: { stopReason, errorMessage } } };
}

test("config has lightweight defaults and copies offered thinking levels", () => {
  const input = rawConfig();
  delete input.cacheTtlMs;
  delete input.endpoints[0].healthPath;
  delete input.endpoints[0].timeoutMs;
  const parsed = parseConfig(input);
  assert.equal(parsed.id, "auto");
  assert.equal(parsed.cacheTtlMs, 10000);
  assert.equal(parsed.endpoints[0].timeoutMs, 100);
  assert.equal(parsed.endpoints[0].healthPath, "/v1/models");
  assert(parsed.thinkingLevels.includes("max"));
});

for (const [label, patch] of [
  ["one endpoint", c => { c.endpoints.pop(); }],
  ["negative cache", c => { c.cacheTtlMs = -1; }],
  ["infinite deadline", c => { c.probeTimeoutMs = Infinity; }],
  ["zero deadline", c => { c.endpoints[0].timeoutMs = 0; }],
  ["duplicate refs", c => { c.endpoints[1] = { ...c.endpoints[0] }; }],
  ["virtual endpoint", c => { c.endpoints[0].provider = "pi-ha"; }],
  ["external probe", c => { c.endpoints[0].healthPath = "https://other.test/health"; }],
  ["protocol-relative probe", c => { c.endpoints[0].healthPath = "//other.test/health"; }],
  ["backslash probe", c => { c.endpoints[0].healthPath = "/\\other.test/health"; }],
  ["invalid thinking", c => { c.thinkingLevels = ["extreme"]; }],
  ["invalid inputs", c => { c.input = ["audio"]; }],
]) {
  test(`rejects ${label}`, () => {
    const c = rawConfig(); patch(c); assert.throws(() => parseConfig(c), /pi-ha:/);
  });
}

test("prefers LAN, caches success, and returns the original physical model", async () => {
  const r = registry(); const calls = [];
  const router = new HaRouter(parseConfig(rawConfig()), async (url, options) => {
    calls.push({ url: String(url), options }); return healthy();
  });
  const chosen = await router.choose(r, request);
  assert.equal(chosen.model, r.models.get("lan"));
  assert.equal(chosen.label, "LAN");
  await router.choose(r, { reason: "continuation" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.get("Authorization"), "Bearer test-lan");
  assert.equal(calls[0].options.headers.get("X-Endpoint"), "lan");
  assert.equal(calls[0].options.body, undefined);
  assert.equal(chosen.model.maxTokens, 4096);
  assert.match(router.status(), /LAN: healthy/);
});

test("uses short LAN timeout, then a separate remote budget", async () => {
  const calls = [];
  const router = new HaRouter(parseConfig(rawConfig()), async (url, options) => {
    calls.push(String(url));
    return url.hostname === "lan.test" ? waitForAbort(options.signal) : delayedResponse(50, options.signal);
  });
  const chosen = await router.choose(registry(), request);
  assert.equal(chosen.label, "Tailscale");
  assert.equal(calls.length, 2);
  assert.match(router.status(), /LAN: probe timed out/);
  await router.choose(registry(), request);
  assert.equal(calls.length, 2, "negative and positive results are cached");
});

test("prefers recovered LAN after negative cache expiry", async () => {
  let clock = 0, lanUp = false; const calls = [];
  const router = new HaRouter(parseConfig(rawConfig()), async url => {
    calls.push(url.hostname);
    return url.hostname === "lan.test" && !lanUp ? new Response(null, { status: 503 }) : healthy();
  }, () => clock);
  assert.equal((await router.choose(registry(), request)).label, "Tailscale");
  lanUp = true; clock = 999;
  assert.equal((await router.choose(registry(), request)).label, "Tailscale");
  clock = 1000;
  assert.equal((await router.choose(registry(), request)).label, "LAN");
  assert.deepEqual(calls, ["lan.test", "remote.test", "lan.test"]);
});

test("does not send prompts when all checks fail", async () => {
  const router = new HaRouter(parseConfig(rawConfig()), async () => new Response(null, { status: 503 }));
  await assert.rejects(router.choose(registry(), request), /no reachable endpoint.*LAN: HTTP 503.*Tailscale: HTTP 503/);
});

test("health 404 falls back to models at the provider's path prefix", async () => {
  const r = registry(); r.models.get("lan").baseUrl = "http://lan.test/proxy/v1/";
  const calls = [];
  const router = new HaRouter(parseConfig(rawConfig()), async (url, options) => {
    calls.push({ url: String(url), signal: options.signal });
    return url.pathname === "/health" ? new Response(null, { status: 404 }) : modelsResponse();
  });
  assert.equal((await router.choose(r, request)).label, "LAN");
  assert.deepEqual(calls.map(c => c.url), ["http://lan.test/health", "http://lan.test/proxy/v1/models"]);
  assert.equal(calls[0].signal, calls[1].signal, "fallback shares the same deadline");
});

test("health-to-models fallback does not get a fresh timeout", async () => {
  const calls = [];
  const router = new HaRouter(parseConfig(rawConfig()), async (url, options) => {
    calls.push(url.pathname);
    if (url.hostname === "remote.test") return healthy();
    if (url.pathname === "/health") return delayedResponse(20, options.signal, () => new Response(null, { status: 405 }));
    return delayedResponse(20, options.signal, modelsResponse);
  });
  assert.equal((await router.choose(registry(), request)).label, "Tailscale");
  assert.deepEqual(calls, ["/health", "/v1/models", "/health"]);
});

test("rejects a models response that omits the selected model", async () => {
  const c = rawConfig(); c.endpoints[0].healthPath = "/v1/models";
  const router = new HaRouter(parseConfig(c), async url => url.hostname === "lan.test" ? Response.json({ data: [{ id: "other-model" }] }) : healthy());
  assert.equal((await router.choose(registry(), request)).label, "Tailscale");
  assert.match(router.status(), /LAN: model not served/);
});

test("rejects a health response advertising another model", async () => {
  const router = new HaRouter(parseConfig(rawConfig()), async url => url.hostname === "lan.test" ? Response.json({ model: "other-model" }) : healthy());
  assert.equal((await router.choose(registry(), request)).label, "Tailscale");
});

test("includes response-body reading in the probe deadline", async () => {
  const router = new HaRouter(parseConfig(rawConfig()), async (url, options) => {
    if (url.hostname === "remote.test") return healthy();
    const body = new ReadableStream({ start(c) { options.signal.addEventListener("abort", () => c.error(options.signal.reason), { once: true }); } });
    return new Response(body, { headers: { "Content-Type": "application/json" } });
  });
  assert.equal((await router.choose(registry(), request)).label, "Tailscale");
  assert.match(router.status(), /probe timed out/);
});

test("honors cancellation, never probes fallback, and does not poison the cache", async () => {
  const controller = new AbortController(); let calls = 0;
  const router = new HaRouter(parseConfig(rawConfig()), async (_url, options) => ++calls === 1 ? waitForAbort(options.signal) : healthy());
  const pending = router.choose(registry(), { reason: "user", signal: controller.signal });
  setTimeout(() => controller.abort(new DOMException("user stop", "AbortError")), 5);
  await assert.rejects(pending, /user stop/);
  assert.equal(calls, 1);
  assert.equal((await router.choose(registry(), request)).label, "LAN");
  assert.equal(calls, 2);
  await assert.rejects(router.choose(registry(), { reason: "user", signal: controller.signal }), /user stop/);
  assert.equal(calls, 2);
});

test("transport retry invalidates health without replaying tools", async () => {
  const r = registry(); const calls = [];
  const router = new HaRouter(parseConfig(rawConfig()), async url => { calls.push(url.hostname); return healthy(); });
  await router.choose(r, request);
  assert.equal((await router.choose(r, failedRequest(r, "Connection error."))).label, "Tailscale");
  assert.deepEqual(calls, ["lan.test", "remote.test"]);
  assert.equal((await router.choose(r, request)).label, "Tailscale");
  assert.equal(calls.length, 2);
});

test("a transport retry skips the failed endpoint even with caching disabled", async () => {
  const c = rawConfig(); c.cacheTtlMs = 0;
  const router = new HaRouter(parseConfig(c), async () => healthy());
  const r = registry();
  assert.equal((await router.choose(r, failedRequest(r, "ECONNREFUSED"))).label, "Tailscale");
});

for (const error of ["HTTP 401 invalid API key", "429 rate limit", "context_length_exceeded", "500 internal server error"]) {
  test(`does not switch on ${error}`, async () => {
    const r = registry(); let calls = 0;
    const router = new HaRouter(parseConfig(rawConfig()), async () => { calls++; return healthy(); });
    assert.equal((await router.choose(r, failedRequest(r, error))).label, "LAN");
    assert.equal(calls, 0);
  });
}

test("credentials use auth baseUrl and preserve custom Authorization", async () => {
  const r = registry(); let checked;
  r.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "unused", headers: { authorization: "Custom test" }, baseUrl: "https://override.test/v1" });
  const router = new HaRouter(parseConfig(rawConfig()), async (url, options) => { checked = { url, options }; return healthy(); });
  await router.choose(r, request);
  assert.equal(checked.url.origin, "https://override.test");
  assert.equal(checked.options.headers.get("Authorization"), "Custom test");
});

test("null header overrides suppress defaults rather than sending the string null", async () => {
  const r = registry(); let checked;
  r.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "must-not-be-sent", headers: { Authorization: null, "X-Drop": null, "X-Keep": "ok" } });
  const router = new HaRouter(parseConfig(rawConfig()), async (_url, options) => { checked = options.headers; return healthy(); });
  await router.choose(r, request);
  assert.equal(checked.has("Authorization"), false);
  assert.equal(checked.has("X-Drop"), false);
  assert.equal(checked.get("X-Keep"), "ok");
});

test("missing credentials are not sent and fall back safely", async () => {
  const r = registry(); const getAuth = r.getApiKeyAndHeaders;
  r.getApiKeyAndHeaders = m => m.provider === "lan" ? Promise.resolve({ ok: false, error: "redacted credential error" }) : getAuth(m);
  const calls = [];
  const router = new HaRouter(parseConfig(rawConfig()), async url => { calls.push(url.hostname); return healthy(); });
  assert.equal((await router.choose(r, request)).label, "Tailscale");
  assert.deepEqual(calls, ["remote.test"]);
  assert(!router.status().includes("redacted credential error"));
});

test("catalog baseUrl changes invalidate positive health", async () => {
  const r = registry(); const calls = [];
  const router = new HaRouter(parseConfig(rawConfig()), async url => { calls.push(url.hostname); return healthy(); });
  await router.choose(r, request);
  r.models.get("lan").baseUrl = "http://changed.test/v1";
  await router.choose(r, request);
  assert.deepEqual(calls, ["lan.test", "changed.test"]);
  router.reset(); assert.match(router.status(), /not routed yet/);
  await router.choose(r, request); assert.equal(calls.length, 3);
});

test("unconfigured physical models fall back with a clear status", async () => {
  const r = registry(); r.models.delete("lan");
  const router = new HaRouter(parseConfig(rawConfig()), async () => healthy());
  assert.equal((await router.choose(r, request)).label, "Tailscale");
  r.models.delete("remote");
  await assert.rejects(router.choose(r, request), /physical model not configured/);
});

test("rejects URL credentials and non-HTTP endpoints before fetching", async () => {
  const r = registry(); let calls = 0;
  const router = new HaRouter(parseConfig(rawConfig()), async () => { calls++; return healthy(); });
  for (const url of ["http://user:password@lan.test/v1", "file:///private/v1"]) {
    r.models.get("lan").baseUrl = url;
    await assert.rejects(router.choose(r, request), /HTTP\(S\) without URL credentials/);
  }
  assert.equal(calls, 0);
});

test("transport matching is limited to network failures", () => {
  for (const error of ["ECONNRESET", "fetch failed", "connect timeout", "socket hang up", "Connection error."]) assert(isTransportError(error));
  for (const error of ["context_length_exceeded", "invalid API key", "rate limit"]) assert(!isTransportError(error));
});
