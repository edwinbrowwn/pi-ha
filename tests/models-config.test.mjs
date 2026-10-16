import assert from "node:assert/strict";
import { test } from "node:test";
import { parseModelsJson, readHaModels } from "../src/models-config.ts";

const input = () => ({ providers: { local: {
  api: "openai-completions", baseUrl: "http://primary.test:8000/v1", apiKey: "must-not-be-copied",
  models: [{ id: "test-model", name: "Test model", reasoning: true, contextWindow: 65536, maxTokens: 4096,
    ha: { primaryLabel: "LAN", healthPath: "/health", probeTimeoutMs: 100, cacheTtlMs: 10000,
      fallbackUrls: [{ baseUrl: "http://fallback.test:8000/v1", label: "Tailscale", timeoutMs: 1000 }] } }],
} } });

test("ha is opt-in on the real model; no alias or credentials are copied", () => {
  const configs = readHaModels(input());
  assert.equal(configs.size, 1);
  const config = configs.get("local/test-model");
  assert.equal(config.id, "test-model");
  assert.equal(config.name, "local/test-model");
  assert.deepEqual(config.endpoints.map(e => [e.provider, e.model]), [["local", "test-model"], ["local", "test-model"]]);
  assert.equal(config.endpoints[0].baseUrl, undefined, "primary follows Pi's current model baseUrl");
  assert.equal(config.endpoints[0].timeoutMs, 100);
  assert.equal(config.endpoints[1].baseUrl, "http://fallback.test:8000/v1");
  assert.equal(config.endpoints[1].timeoutMs, 1000);
  assert(!JSON.stringify(config).includes("must-not-be-copied"));
});

test("string fallback URLs have a separate default remote deadline", () => {
  const raw = input(); raw.providers.local.models[0].ha = { fallbackUrls: ["http://remote.test:8000/v1/"] };
  const config = readHaModels(raw).get("local/test-model");
  assert.equal(config.endpoints[1].baseUrl, "http://remote.test:8000/v1");
  assert.equal(config.endpoints[1].timeoutMs, 1000);
  assert.equal(config.endpoints[0].healthPath, "/v1/models");
});

test("models without ha or with ha false are untouched", () => {
  const raw = input(); delete raw.providers.local.models[0].ha;
  assert.equal(readHaModels(raw).size, 0);
  raw.providers.local.models[0].ha = false;
  assert.equal(readHaModels(raw).size, 0);
});

test("JSONC and BOM parsing preserves URLs, comment-like strings and escaped quotes", () => {
  const raw = '\uFEFF{ // comment\n"providers": {}, /* block\ncomment */ "url": "http://example.test/v1", "text": "/* literal */ \\"quoted\\" // literal" }';
  const parsed = parseModelsJson(raw);
  assert.equal(parsed.url, "http://example.test/v1");
  assert.equal(parsed.text, '/* literal */ "quoted" // literal');
  assert.deepEqual(parsed.providers, {});
});

for (const [name, change, error] of [
  ["ha true without settings", m => { m.ha = true; }, /ha must be an object/],
  ["no fallback URLs", m => { m.ha.fallbackUrls = []; }, /nonempty array/],
  ["same primary URL", m => { m.ha.fallbackUrls = ["http://primary.test:8000/v1/"]; }, /repeats its primary/],
  ["duplicate fallback URLs", m => { m.ha.fallbackUrls = ["http://remote.test/v1", "http://remote.test/v1/"]; }, /duplicate endpoint/],
  ["URL credentials", m => { m.ha.fallbackUrls = ["http://user:secret@remote.test/v1"]; }, /without URL credentials/],
  ["non-HTTP URL", m => { m.ha.fallbackUrls = ["file:///private"]; }, /HTTP\(S\)/],
  ["missing fallback baseUrl", m => { m.ha.fallbackUrls = [{}]; }, /invalid fallback/],
  ["unsupported API", m => { m.api = "anthropic-messages"; }, /requires openai-completions/],
]) {
  test(`rejects ${name}`, () => { const raw = input(); change(raw.providers.local.models[0]); assert.throws(() => readHaModels(raw), error); });
}

test("model-level baseUrl and API take precedence over provider defaults", () => {
  const raw = input(); raw.providers.local.api = "anthropic-messages";
  const m = raw.providers.local.models[0]; m.api = "openai-completions"; m.baseUrl = "http://another-lan.test/v1";
  m.ha.fallbackUrls = ["http://another-lan.test/v1"];
  assert.throws(() => readHaModels(raw), /repeats its primary/);
});
