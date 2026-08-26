/** Shared HTTP helpers: client IP handling, CORS, and error shapes. */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS, ...headers },
  });
}

/**
 * Error body carrying both the flat shape and FastAPI's nested `detail`, so
 * clients written against the old Python faucet keep working unchanged.
 */
export function errorJson(
  status: number,
  error: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  const payload = { error, ...extra };
  return json({ ...payload, detail: payload }, status, headers);
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

/**
 * Normalise a client IP for rate limiting.
 *
 * IPv4 is used as-is. IPv6 is truncated to its /48 prefix, because a single
 * subscriber is routinely handed a whole /48 or /64 and could otherwise walk
 * through addresses to reset the limit.
 */
export function normalizeIp(ip: string): string {
  if (!ip.includes(":")) return ip;

  const zone = ip.indexOf("%");
  const addr = zone === -1 ? ip : ip.slice(0, zone);

  // Expand "::" so the first three hextets can be read positionally.
  const halves = addr.split("::");
  let groups: string[];
  if (halves.length === 2) {
    const head = halves[0] ? halves[0].split(":") : [];
    const tail = halves[1] ? halves[1].split(":") : [];
    const fill = Array(Math.max(0, 8 - head.length - tail.length)).fill("0");
    groups = [...head, ...fill, ...tail];
  } else {
    groups = addr.split(":");
  }
  if (groups.length !== 8) return ip; // not something we recognise; use verbatim

  const prefix = groups.slice(0, 3).map((g) => (g === "" ? "0" : g));
  return `${prefix.join(":")}::/48`;
}

export function clientIp(request: Request): string {
  return normalizeIp(rawClientIp(request));
}

/** Unmodified client address for Turnstile's remoteip binding. */
export function rawClientIp(request: Request): string {
  const cf = request.headers.get("CF-Connecting-IP");
  if (cf) return cf.trim();

  const forwarded = request.headers.get("X-Forwarded-For");
  if (forwarded) return forwarded.split(",")[0].trim();

  const real = request.headers.get("X-Real-IP");
  if (real) return real.trim();

  return "unknown";
}

export interface TurnstileOutcome {
  ok: boolean;
  reason?: string;
}

/**
 * Verify a Turnstile token. When no secret is configured the check is skipped,
 * matching how the old faucet behaved with CAP unconfigured.
 */
export async function verifyTurnstile(
  secret: string,
  token: string | undefined,
  ip: string,
  expected?: { hostname: string; action: string },
): Promise<TurnstileOutcome> {
  if (!secret) return { ok: true };
  if (!token) return { ok: false, reason: "Captcha token required" };

  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip && ip !== "unknown" && !ip.includes("/")) form.append("remoteip", ip);

  try {
    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body: form, signal: AbortSignal.timeout(5000) },
    );
    const body = (await res.json()) as {
      success?: boolean;
      hostname?: string;
      action?: string;
      "error-codes"?: string[];
    };
    if (body.success && expected) {
      if (body.hostname !== expected.hostname || body.action !== expected.action) {
        return { ok: false, reason: "Captcha token was issued for another request" };
      }
    }
    if (body.success) return { ok: true };
    return {
      ok: false,
      reason: `Invalid captcha token (${(body["error-codes"] ?? []).join(", ") || "rejected"})`,
    };
  } catch {
    return { ok: false, reason: "Captcha verification unavailable" };
  }
}
