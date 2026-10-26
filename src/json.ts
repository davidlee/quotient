// Guards over parsed JSON: the one place untrusted, decoded values are
// narrowed before a reader looks inside them.

/** VALUE is a JSON object: non-null and not an array. A `null`, a boolean, a
 *  number, a string or an array is not a record, whoever is asking. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
