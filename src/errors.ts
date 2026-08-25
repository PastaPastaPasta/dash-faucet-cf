/** Render an unknown thrown value as a message string. */
export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
