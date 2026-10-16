import { parseConfig, type HaConfig } from "./router.ts";

/** Match Pi's JSONC/BOM support without importing internal modules or a parser dependency. */
export function parseModelsJson(content: string): unknown {
  const json = content.replace(/^\uFEFF/, "").replace(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, match =>
    match.startsWith('"') ? match : match.replace(/[^\r\n]/g, " "));
  return JSON.parse(json);
}

export function readHaModels(value: unknown): Map<string, HaConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("pi-ha: models.json must be an object");
  const providers = (value as { providers?: unknown }).providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) throw new Error("pi-ha: models.json needs providers");
  const configs = new Map<string, HaConfig>();
  for (const [provider, raw] of Object.entries(providers)) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.models)) continue;
    for (const model of raw.models) {
      if (!model || model.ha === undefined || model.ha === false) continue;
      const key = `${provider}/${model.id}`;
      if (!model.ha || typeof model.ha !== "object" || Array.isArray(model.ha)) throw new Error(`pi-ha: ${key}.ha must be an object or false`);
      if ((model.api ?? raw.api) !== "openai-completions") throw new Error(`pi-ha: ${key} requires openai-completions`);
      const ha = model.ha;
      if (!Array.isArray(ha.fallbackUrls) || !ha.fallbackUrls.length) throw new Error(`pi-ha: ${key}.ha.fallbackUrls must be a nonempty array`);
      const baseUrl = model.baseUrl ?? raw.baseUrl;
      if (typeof baseUrl !== "string" || !baseUrl) throw new Error(`pi-ha: ${key} needs a baseUrl`);
      const primaryUrl = new URL(baseUrl).href.replace(/\/$/, "");
      const config = parseConfig({
        id: model.id, name: key, cacheTtlMs: ha.cacheTtlMs ?? 10000, probeTimeoutMs: ha.probeTimeoutMs ?? 100,
        endpoints: [
          { provider, model: model.id, label: ha.primaryLabel ?? "Primary", healthPath: ha.healthPath ?? "/v1/models" },
          ...ha.fallbackUrls.map((entry: unknown, index: number) => {
            const fallback = typeof entry === "string" ? { baseUrl: entry } : entry as Record<string, unknown>;
            if (!fallback || typeof fallback !== "object" || Array.isArray(fallback) || typeof fallback.baseUrl !== "string") throw new Error(`pi-ha: ${key} has an invalid fallback URL`);
            if (new URL(fallback.baseUrl).href.replace(/\/$/, "") === primaryUrl) throw new Error(`pi-ha: ${key} repeats its primary URL as a fallback`);
            return {
              provider, model: model.id, baseUrl: fallback.baseUrl, label: fallback.label ?? `Fallback ${index + 1}`,
              healthPath: fallback.healthPath ?? ha.healthPath ?? "/v1/models", timeoutMs: fallback.timeoutMs ?? ha.fallbackTimeoutMs ?? 1000,
            };
          }),
        ],
      });
      if (configs.has(key)) throw new Error(`pi-ha: duplicate HA model ${key}`);
      configs.set(key, config);
    }
  }
  return configs;
}
