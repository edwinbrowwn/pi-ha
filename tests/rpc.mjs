import { spawn } from "node:child_process";
import { once } from "node:events";
import { testEnvironment } from "./test-env.mjs";

export function rpcClient(t, { dir, extension }) {
  const child = spawn(process.env.PI_EXECUTABLE ?? "pi", [
    "--offline", "--mode", "rpc", "--no-session", "--no-extensions", "-e", extension,
    "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-tools",
  ], { cwd: dir, env: testEnvironment(dir), stdio: ["pipe", "pipe", "pipe"] });
  const records = [], pending = new Map();
  let buffer = "", stderr = "", sequence = 0;
  child.stderr.on("data", data => { stderr += data; });
  child.stdout.on("data", data => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const record = JSON.parse(line); records.push(record);
      if (record.type === "response") {
        const request = pending.get(record.id);
        if (!request) continue;
        clearTimeout(request.timer); pending.delete(record.id);
        if (record.success) request.resolve(record); else request.reject(new Error(record.error));
      }
    }
  });
  child.on("error", error => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear();
  });
  t.after(async () => {
    if (child.exitCode !== null) return;
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    await once(child, "close"); clearTimeout(timer);
  });
  return {
    records,
    command(payload) {
      const id = String(++sequence);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC command timed out: ${stderr}`)); }, 5000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ ...payload, id }) + "\n");
      });
    },
  };
}
