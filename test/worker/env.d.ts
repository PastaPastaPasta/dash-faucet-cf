import type { Env as FaucetEnv } from "../../src/config";

// `cloudflare:test` types its `env` as `Cloudflare.Env`; teach that namespace
// the bindings this Worker actually declares.
declare global {
  namespace Cloudflare {
    interface Env extends FaucetEnv {}
  }
}

export {};
