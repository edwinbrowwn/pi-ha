import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lazyStream, openAICompletionsApi, type Api, type AssistantMessage, type AssistantMessageEvent, type Model } from "@earendil-works/pi-ai/compat";
import { HaRouter, isTransportError, type HaConfig } from "./src/router.ts";
import { parseModelsJson, readHaModels } from "./src/models-config.ts";

function* aborted(model: Model<Api>, error: unknown): Generator<AssistantMessageEvent> {
  const message: AssistantMessage = {
    role: "assistant", provider: model.provider, model: model.id, api: model.api, content: [],
    timestamp: Date.now(), stopReason: "aborted", errorMessage: error instanceof Error ? error.message : "Request aborted",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  yield { type: "error", reason: "aborted", error: message };
}

export default function (pi: ExtensionAPI) {
  const path = process.env.PI_HA_MODELS ?? join(getAgentDir(), "models.json");
  const configs = existsSync(path) ? readHaModels(parseModelsJson(readFileSync(path, "utf8"))) : new Map<string, HaConfig>();
  const routers = new Map([...configs].map(([key, config]) => [key, new HaRouter(config)]));
  const api = openAICompletionsApi();
  const keyOf = (model: Model<Api>) => `${model.provider}/${model.id}`;

  // Override request dispatch only; omit models/apiKey/baseUrl so Pi retains all
  // original catalog metadata, authentication, provider and model identity.
  for (const provider of new Set([...configs.values()].map(config => config.endpoints[0].provider))) {
    pi.registerProvider(provider, {
      api: "openai-completions",
      streamSimple(model, context, options) {
        const router = routers.get(keyOf(model));
        if (!router) return api.streamSimple(model, context, options);
        return lazyStream(model, async () => {
          let choice;
          try {
            choice = await router.choose({
              find: (provider, id) => provider === model.provider && id === model.id ? model : undefined,
              // Pi has already resolved request-time auth, including CLI key overrides.
              getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: options?.apiKey, headers: options?.headers }),
            }, { reason: "direct", signal: options?.signal });
          } catch (error) {
            if (options?.signal?.aborted) return (async function* () { yield* aborted(model, error); })();
            throw error;
          }
          const selected = choice;
          // Native conversion, thinking/sampling, tools, usage and instrumentation
          // stay intact. Both URLs use this model/provider's resolved credentials.
          const inner = api.streamSimple(selected.model, context, options);
          return (async function* () {
            for await (const event of inner) {
              if (event.type === "error" && event.reason !== "aborted" && isTransportError(event.error.errorMessage ?? "")) {
                router.markFailed(selected.endpoint, selected.model);
              }
              yield event;
            }
          })();
        });
      },
    });
  }

  pi.registerCommand("pi-ha", {
    description: "High Availability status; /pi-ha check rechecks, /pi-ha reset clears cached health",
    async handler(args, ctx) {
      const action = args.trim();
      const router = ctx.model && routers.get(keyOf(ctx.model));
      if (action === "reset") {
        if (router) router.reset(); else for (const entry of routers.values()) entry.reset();
        ctx.ui.notify("pi-ha: health cache cleared", "info");
        return;
      }
      if (action === "check") {
        if (!router || !ctx.model) {
          ctx.ui.notify("Select a model with an ha field in models.json first.", "info");
          return;
        }
        router.reset();
        try { await router.choose(ctx.modelRegistry, { reason: "direct", signal: ctx.signal }); }
        catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); return; }
      } else if (action && action !== "status") {
        ctx.ui.notify("Usage: /pi-ha [status|check|reset]", "info");
        return;
      }
      ctx.ui.notify(router ? router.status() : [...routers.values()].map(entry => entry.status()).join("\n\n") || "No models have High Availability configured.", "info");
    },
  });

  // No custom footer or virtual model: keep Pi's native display unchanged.
  pi.on("session_start", (_event, ctx) => { if (ctx.hasUI) ctx.ui.setStatus("pi-ha", undefined); });
  pi.on("session_shutdown", (_event, ctx) => { for (const router of routers.values()) router.reset(); if (ctx.hasUI) ctx.ui.setStatus("pi-ha", undefined); });
}
