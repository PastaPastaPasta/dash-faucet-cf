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
                // A tight 2/3/4 ladder so a single test can walk soft ->
                // turnstile -> hard and still hit the hard ceiling before the
                // 4-payout daily budget below takes over.
                RATE_LIMIT_PER_HOUR: "2",
                RATE_LIMIT_TURNSTILE_PER_HOUR: "3",
                RATE_LIMIT_HARD_PER_HOUR: "4",
                DAILY_BUDGET_SATS: "45000000",
                MIN_BALANCE_SATS: "0",
                POOL_MIN: "2",
                POOL_TARGET: "4",
                POOL_UTXO_SATS: "20000000",
                TURNSTILE_SITE_KEY: "",
                TURNSTILE_SECRET: "",
                CAP_C: "4",
                CAP_S: "32",
                CAP_D: "2",
                // Cheap challenges (4 x ~256 and 4 x ~4096 tries) so the tests
                // can actually brute-force one; production serves 100 x 16^4
                // and 50 x 16^6. What matters here is only that hard costs
                // strictly more work than soft, since that ordering is what
                // tier derivation reads. Never solve the real hard shape in a
                // test — 839M hashes is a quarter-hour of CPU.
                CAP_HARD_C: "4",
                CAP_HARD_S: "32",
                CAP_HARD_D: "3",
                CAP_SECRET: "test-cap-secret",
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
