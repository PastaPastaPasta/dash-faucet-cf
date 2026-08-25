import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// dashtx's ESM entry (dashtx.mjs) reads a bare `window`, which is a
// ReferenceError anywhere that is not a browser — Node and workerd included.
// Its CommonJS build guards with `globalThis.window || {}`, so point at that
// instead. Mirrored by `alias` in wrangler.jsonc.
const alias = { dashtx: "./node_modules/dashtx/dashtx.js" };

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          // Pure logic — nothing here imports `cloudflare:workers`.
          include: ["test/*.test.ts"],
          environment: "node",
        },
      },
      {
        resolve: { alias },
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc", environment: "testnet" },
            miniflare: {
              bindings: {
                // Deterministic test key; holds nothing.
                FAUCET_WIF: "cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87f2krBRv7",
                PAYOUT_SATS: "10000000",
                RATE_LIMIT_PER_HOUR: "2",
                DAILY_BUDGET_SATS: "45000000",
                MIN_BALANCE_SATS: "0",
                POOL_MIN: "2",
                POOL_TARGET: "4",
                POOL_UTXO_SATS: "20000000",
                TURNSTILE_SITE_KEY: "",
                TURNSTILE_SECRET: "",
                DRY_RUN: "0",
              },
            },
          }),
        ],
        test: {
          name: "worker",
          include: ["test/worker/*.test.ts"],
        },
      },
    ],
  },
});
