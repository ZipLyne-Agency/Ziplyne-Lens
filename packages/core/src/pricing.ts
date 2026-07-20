import type { CostSource, UsageInput } from "./types.js";

interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheCreatePerMillion?: number;
  cacheReadPerMillion?: number;
}

const FALLBACK_PRICE: ModelPrice = {
  inputPerMillion: 3,
  outputPerMillion: 15,
  cacheCreatePerMillion: 3.75,
  cacheReadPerMillion: 0.3,
};

export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-opus-4-8": {
    inputPerMillion: 15,
    outputPerMillion: 75,
    cacheCreatePerMillion: 18.75,
    cacheReadPerMillion: 1.5,
  },
  "claude-opus-4-7": {
    inputPerMillion: 15,
    outputPerMillion: 75,
    cacheCreatePerMillion: 18.75,
    cacheReadPerMillion: 1.5,
  },
  "claude-fable-5": {
    inputPerMillion: 20,
    outputPerMillion: 100,
    cacheCreatePerMillion: 25,
    cacheReadPerMillion: 2,
  },
  "claude-sonnet-5": {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheCreatePerMillion: 3.75,
    cacheReadPerMillion: 0.3,
  },
  "claude-sonnet-4-6": {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheCreatePerMillion: 3.75,
    cacheReadPerMillion: 0.3,
  },
  "claude-haiku-4-5-20251001": {
    inputPerMillion: 0.8,
    outputPerMillion: 4,
    cacheCreatePerMillion: 1,
    cacheReadPerMillion: 0.08,
  },
  "gpt-5.5": {
    inputPerMillion: 1.25,
    outputPerMillion: 10,
    cacheCreatePerMillion: 1.25,
    cacheReadPerMillion: 0.125,
  },
  "gpt-5.4-mini": {
    inputPerMillion: 0.25,
    outputPerMillion: 2,
    cacheCreatePerMillion: 0.25,
    cacheReadPerMillion: 0.025,
  },
  "gpt-5-codex": {
    inputPerMillion: 1.25,
    outputPerMillion: 10,
    cacheCreatePerMillion: 1.25,
    cacheReadPerMillion: 0.125,
  },
  "glm-5.2": {
    inputPerMillion: 0.6,
    outputPerMillion: 2.5,
    cacheCreatePerMillion: 0.6,
    cacheReadPerMillion: 0.06,
  },
  // Kimi Code and Grok CLI don't publish per-token rates for the CLI-bundled
  // models; these are estimates from the providers' current API rate cards.
  "kimi-code/k2": {
    inputPerMillion: 0.55,
    outputPerMillion: 2.2,
    cacheCreatePerMillion: 0.55,
    cacheReadPerMillion: 0.15,
  },
  "kimi-code/k3": {
    inputPerMillion: 0.95,
    outputPerMillion: 4,
    cacheCreatePerMillion: 0.95,
    cacheReadPerMillion: 0.19,
  },
  "kimi-code/kimi-for-coding": {
    inputPerMillion: 0.95,
    outputPerMillion: 4,
    cacheCreatePerMillion: 0.95,
    cacheReadPerMillion: 0.19,
  },
  "grok-4.5": {
    inputPerMillion: 2,
    outputPerMillion: 6,
    cacheCreatePerMillion: 2,
    cacheReadPerMillion: 0.5,
  },
  "grok-4": {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheCreatePerMillion: 3,
    cacheReadPerMillion: 0.75,
  },
  "grok-3": {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheCreatePerMillion: 3,
    cacheReadPerMillion: 0.75,
  },
  "grok-code-fast-1": {
    inputPerMillion: 0.2,
    outputPerMillion: 1.5,
    cacheCreatePerMillion: 0.2,
    cacheReadPerMillion: 0.2,
  },
};

export function calculateCost(input: UsageInput): number {
  const price = MODEL_PRICES[normalizeModel(input.model)] ?? FALLBACK_PRICE;
  const outputLikeTokens = input.outputTokens + input.reasoningTokens;
  const cost =
    (input.inputTokens * price.inputPerMillion) / 1_000_000 +
    (outputLikeTokens * price.outputPerMillion) / 1_000_000 +
    (input.cacheCreationTokens *
      (price.cacheCreatePerMillion ?? price.inputPerMillion)) /
      1_000_000 +
    (input.cacheReadTokens *
      (price.cacheReadPerMillion ?? price.inputPerMillion)) /
      1_000_000;
  return roundCost(cost);
}

export function costSourceFor(model: string): CostSource {
  return MODEL_PRICES[normalizeModel(model)] ? "calculated" : "missing-pricing";
}

export function normalizeModel(model: string): string {
  return model.replace(/\[1m\]$/u, "").replace(/-fast$/u, "");
}

export function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
