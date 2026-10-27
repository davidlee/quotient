// Caught values as text: the one rendering every diagnostic and refusal detail uses.

/** One line from a caught value, for a diagnostic or a refusal's detail. Total:
 *  a value that cannot be printed (`Object.create(null)`) must not stop the
 *  settlement that reports it. */
export function messageOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'a value that cannot be printed';
  }
}
