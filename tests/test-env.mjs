import { join } from "node:path";

// Keep CLI tests away from the developer's agent directory and HA config,
// even when PI_* overrides are set in the shell running npm test.
export function testEnvironment(dir) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("PI_")));
  return {
    ...env,
    PI_CODING_AGENT_DIR: dir,
    PI_CODING_AGENT_SESSION_DIR: join(dir, "sessions"),
    PI_HA_MODELS: join(dir, "models.json"),
    PI_OFFLINE: "1",
  };
}
