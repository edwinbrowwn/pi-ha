import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { testEnvironment } from "./test-env.mjs";

test("CLI fixtures override personal Pi paths and do not mutate the parent environment", t => {
  const overrides = {
    PI_HA_MODELS: "should-not-be-read.json",
    PI_CODING_AGENT_DIR: "should-not-be-used",
    PI_CODING_AGENT_SESSION_DIR: "should-not-be-used",
    PI_TEST_SENTINEL: "should-not-reach-child",
  };
  const saved = new Map(Object.keys(overrides).map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  Object.assign(process.env, overrides);
  const dir = join(tmpdir(), "pi-ha-env-test");
  const env = testEnvironment(dir);
  assert.equal(env.PI_HA_MODELS, join(dir, "models.json"));
  assert.equal(env.PI_CODING_AGENT_DIR, dir);
  assert.equal(env.PI_CODING_AGENT_SESSION_DIR, join(dir, "sessions"));
  assert.equal(env.PI_OFFLINE, "1");
  assert.equal(env.PI_TEST_SENTINEL, undefined);
  assert.equal(process.env.PI_HA_MODELS, overrides.PI_HA_MODELS);
});
