import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { rpcClient } from "./rpc.mjs";
import { testEnvironment } from "./test-env.mjs";

const extension = fileURLToPath(new URL("../index.ts", import.meta.url));

async function fixture(t, { lanHealth = "up", remoteHealth = "up", tools = false, failLanInference = false, delayMs = 0 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-ha-test-"));
  const file = join(dir, "fixture.txt");
  await writeFile(file, "PI_HA_TOOL_FIXTURE\n");
  const calls = [];
  const servers = [];
  t.after(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await rm(dir, { recursive: true, force: true });
  });
  for (const [label, health] of [["LAN", lanHealth], ["Tailscale", remoteHealth]]) {
    const server = createServer(async (req, res) => {
      const call = { label, path: req.url, authorization: req.headers.authorization };
      calls.push(call);
      if (req.url === "/health") {
        if (health === "stall") return;
        if (health === "redirect") {
          res.writeHead(302, { Location: `${servers[1].url}/forbidden` }); res.end(); return;
        }
        res.writeHead(health === "up" ? 200 : 503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: health, model: "test-model" })); return;
      }
      if (req.url !== "/v1/chat/completions") { res.writeHead(404); res.end(); return; }
      let body = "";
      for await (const chunk of req) body += chunk;
      call.body = JSON.parse(body);
      if (label === "LAN" && failLanInference) { req.socket.destroy(); return; }
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
          id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "test-model",
          choices: [{ index: 0, delta, finish_reason }],
          ...(finish_reason ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}),
        })}\n\n`);
        const toolResult = call.body.messages.find(message => message.role === "tool");
        if (tools && !toolResult) {
          chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_read_fixture", type: "function", function: { name: "read", arguments: JSON.stringify({ path: file }) } }] });
          chunk({}, "tool_calls");
        } else {
          chunk({ role: "assistant", content: `OK-${label}` });
          chunk({}, "stop");
        }
        res.end("data: [DONE]\n\n");
      }, delayMs);
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    server.url = `http://127.0.0.1:${server.address().port}`;
    servers.push(server);
  }
  await writeFile(join(dir, "settings.json"), JSON.stringify({
    packages: [], defaultProvider: "test-lan", defaultModel: "test-model", defaultThinkingLevel: "max", quietStartup: true,
    enableInstallTelemetry: false, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: 0 } },
  }));
  await writeFile(join(dir, "models.json"), JSON.stringify({ providers: {
    "test-lan": {
      baseUrl: `${servers[0].url}/v1`, api: "openai-completions", apiKey: "test-lan-key",
      models: [
        { id: "test-model", name: "Test model", reasoning: true, thinkingLevelMap: { off: "none", max: "xhigh" }, input: ["text", "image"], contextWindow: 65536, maxTokens: 4096,
          samplingParams: { temperature: 0.4 },
          ha: { primaryLabel: "LAN", healthPath: "/health", probeTimeoutMs: 100, cacheTtlMs: 10000,
            fallbackUrls: [{ baseUrl: `${servers[1].url}/v1`, label: "Tailscale", timeoutMs: 1000 }] } },
        { id: "plain", name: "Plain", reasoning: false, input: ["text"], contextWindow: 65536, maxTokens: 4096 },
      ],
    },
  } }));
  async function run(args = [], list = false, modelId = "test-model") {
    const baseArgs = ["--offline", "--no-extensions", "-e", extension, "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-session"];
    const argv = list ? [...baseArgs, "--list-models", "test-model"] : [
      ...baseArgs, "--model", `test-lan/${modelId}`, "--thinking", "off", "--system-prompt", "You are a test assistant.",
      ...(tools ? ["--tools", "read"] : ["--no-tools"]), ...args, "--print", "Say OK.",
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(process.env.PI_EXECUTABLE ?? "pi", argv, {
        cwd: dir, env: testEnvironment(dir),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Pi CLI test timed out: ${stderr}`)); }, 15000);
      child.stdout.on("data", data => { stdout += data; });
      child.stderr.on("data", data => { stderr += data; });
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
  }
  return { calls, run, dir };
}

function generations(calls) { return calls.filter(call => call.path === "/v1/chat/completions"); }
function success(output, label) {
  assert.equal(output.code, 0, output.stderr || output.stdout);
  assert.match(output.stdout, new RegExp(`OK-${label}`));
  assert.doesNotMatch(output.stderr, /Failed to load extension|Extension error|Cannot find module|SyntaxError/);
}

test("Pi lists the real model without an HA alias or startup network requests", async t => {
  const f = await fixture(t);
  const output = await f.run([], true);
  assert.equal(output.code, 0, output.stderr);
  assert.match(output.stdout, /test-lan\s+test-model/);
  assert.doesNotMatch(output.stdout, /pi-ha\s+auto/);
  assert.equal(f.calls.length, 0, "factory has no networking, timers, or model calls");
});

test("real Pi dispatch prefers LAN and uses its own credentials", async t => {
  const f = await fixture(t);
  const output = await f.run(); success(output, "LAN");
  assert.deepEqual(f.calls.map(c => [c.label, c.path]), [["LAN", "/health"], ["LAN", "/v1/chat/completions"]]);
  for (const call of f.calls) assert.equal(call.authorization, "Bearer test-lan-key");
});

test("real Pi falls back after a 100 ms health timeout; inference can exceed that deadline", async t => {
  const f = await fixture(t, { lanHealth: "stall", delayMs: 250 });
  const output = await f.run(); success(output, "Tailscale");
  assert.deepEqual(f.calls.map(c => [c.label, c.path]), [
    ["LAN", "/health"], ["Tailscale", "/health"], ["Tailscale", "/v1/chat/completions"],
  ]);
  assert.equal(generations(f.calls)[0].authorization, "Bearer test-lan-key", "alternate address uses the same provider's resolved credentials");
});

test("real Pi completes a native read-tool roundtrip while reusing cached fallback health", async t => {
  const f = await fixture(t, { lanHealth: "down", tools: true });
  const output = await f.run(); success(output, "Tailscale");
  assert.equal(f.calls.filter(c => c.path === "/health").length, 2);
  const g = generations(f.calls);
  assert.equal(g.length, 2);
  assert(g.every(call => call.label === "Tailscale"));
  assert.match(JSON.stringify(g[1].body.messages.find(message => message.role === "tool")), /PI_HA_TOOL_FIXTURE/);
  assert.equal(g[1].body.messages.filter(message => message.role === "user").length, 1, "user turn isn't replayed");
});

test("real Pi native transport retry selects the fallback without replaying the user turn", async t => {
  const f = await fixture(t, { failLanInference: true });
  const output = await f.run(); success(output, "Tailscale");
  const g = generations(f.calls);
  assert.deepEqual(g.map(call => call.label), ["LAN", "Tailscale"]);
  assert.equal(g[1].body.messages.filter(message => message.role === "user").length, 1);
});

test("real Pi refuses health redirects and does not forward credentials to the redirect target", async t => {
  const f = await fixture(t, { lanHealth: "redirect" });
  const output = await f.run(); success(output, "Tailscale");
  assert(!f.calls.some(call => call.path === "/forbidden"));
});

test("fallback responses retain native provider/model identity, usage, and sampling metadata", async t => {
  const f = await fixture(t, { lanHealth: "down" });
  const output = await f.run(["--mode", "json"]); success(output, "Tailscale");
  const messages = output.stdout.trim().split("\n").map(line => JSON.parse(line)).filter(e => e.type === "message_end" && e.message.role === "assistant").map(e => e.message);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].provider, "test-lan");
  assert.equal(messages[0].model, "test-model");
  assert.equal(messages[0].api, "openai-completions");
  assert.equal(messages[0].usage.totalTokens, 15);
  assert.equal(generations(f.calls)[0].body.temperature, 0.4);
});

test("models without ha on the same provider keep native dispatch without health checks", async t => {
  const f = await fixture(t, { lanHealth: "down" });
  const output = await f.run([], false, "plain"); success(output, "LAN");
  assert.deepEqual(f.calls.map(c => c.path), ["/v1/chat/completions"]);
  assert.equal(generations(f.calls)[0].body.model, "plain");
});

test("native endpoint probes and inference honor CLI API-key overrides", async t => {
  const f = await fixture(t, { lanHealth: "down" });
  const output = await f.run(["--api-key", "test-cli-key"]); success(output, "Tailscale");
  assert(f.calls.every(c => c.authorization === "Bearer test-cli-key"));
});

test("RPC keeps the actual selected model, limits, vision, and thinking while checking HA", async t => {
  const f = await fixture(t, { lanHealth: "down" });
  const client = rpcClient(t, { dir: f.dir, extension });
  const state = (await client.command({ type: "get_state" })).data;
  assert.equal(state.model.provider, "test-lan");
  assert.equal(state.model.id, "test-model");
  assert.equal(state.model.name, "Test model");
  assert.equal(state.model.api, "openai-completions");
  assert.equal(state.model.contextWindow, 65536);
  assert.equal(state.model.maxTokens, 4096);
  assert.deepEqual(state.model.input, ["text", "image"]);
  assert.equal(state.model.reasoning, true);
  assert.equal(state.thinkingLevel, "max");
  assert.equal((await client.command({ type: "prompt", message: "/pi-ha check" })).data.disposition, "handled");
  assert(client.records.some(r => r.method === "notify" && r.message.includes("test-lan/test-model: Tailscale")));
  assert.equal(generations(f.calls).length, 0);
  assert(!client.records.some(r => r.type === "agent_start"));
  assert.deepEqual((await client.command({ type: "get_state" })).data.model, state.model);
  assert.equal((await client.command({ type: "prompt", message: "/pi-ha reset" })).data.disposition, "handled");
  assert.equal((await client.command({ type: "prompt", message: "/pi-ha status" })).data.disposition, "handled");
  assert(client.records.some(r => r.method === "notify" && r.message.includes("not routed yet")));
});

test("aborting a pending HA probe yields native cancellation without fallback or inference", async t => {
  const f = await fixture(t, { lanHealth: "stall" });
  const client = rpcClient(t, { dir: f.dir, extension });
  await client.command({ type: "get_state" });
  await client.command({ type: "prompt", message: "Say OK." });
  const deadline = Date.now() + 1000;
  while (!f.calls.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
  assert(f.calls.length, "primary probe started");
  await client.command({ type: "abort" });
  assert.equal(generations(f.calls).length, 0);
  assert(!f.calls.some(c => c.label === "Tailscale"));
  const aborted = client.records.find(r => r.type === "message_end" && r.message?.stopReason === "aborted");
  assert(aborted, "setup cancellation has an aborted terminal result");
  assert.equal(aborted.message.provider, "test-lan");
  assert.equal(aborted.message.model, "test-model");
});

test("real Pi fails clearly without inference when both endpoints are unhealthy", async t => {
  const f = await fixture(t, { lanHealth: "down", remoteHealth: "down" });
  const output = await f.run();
  assert.match(output.stderr + output.stdout, /pi-ha: no reachable endpoint/);
  assert.equal(generations(f.calls).length, 0);
});
