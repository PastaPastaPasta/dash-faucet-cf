/** Minimal Platform Explorer reads used to avoid wasting bearer invitations. */

const TIMEOUT_MS = 5000;

async function exists(url: string): Promise<boolean | null> {
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok) return true;
    if (response.status === 404) return false;
    return null;
  } catch {
    return null;
  }
}

export function platformIdentityExists(
  baseUrl: string,
  identityId: string,
): Promise<boolean | null> {
  return exists(`${baseUrl}/identity/${encodeURIComponent(identityId)}`);
}
