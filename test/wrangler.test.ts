import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

const config = JSON.parse(stripJsonc(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")));

describe("wrangler.jsonc", () => {
  it("sends / to the Worker first on testnet, so /?network=mainnet can redirect", () => {
    expect(config.env.testnet.assets.run_worker_first).toEqual(
      expect.arrayContaining(["/", "/keys", "/keys.html", "/admin", "/admin.html"]),
    );
  });
});
