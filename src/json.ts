// Guards over parsed JSON: the one place untrusted, decoded values are
// narrowed before a reader looks inside them.

/** VALUE is a JSON object: non-null and not an array. A `null`, a boolean, a
 *  number, a string or an array is not a record, whoever is asking. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The value at PATH inside VALUE: each step a key of a record or an index of an
 *  array, own properties only. Undefined when a step finds nothing to step into,
 *  so a reader narrows the one value it wants instead of every hop to it. */
export function at(value: unknown, ...path: readonly (string | number)[]): unknown {
  let here = value;
  for (const step of path) {
    here = child(here, step);
    if (here === undefined) {return undefined;}
  }
  return here;
}

function child(value: unknown, step: string | number): unknown {
  if (typeof step === 'number') {
    if (!Array.isArray(value)) {return undefined;}
    const items: readonly unknown[] = value;
    return items[step];
  }
  return isRecord(value) && Object.hasOwn(value, step) ? value[step] : undefined;
}

/** VALUE is one of TOKENS: the one narrowing a decoded value to a declared
 *  vocabulary goes through, so no member is ever claimed by a type assertion. */
export function isMember<T extends string>(tokens: readonly T[], value: unknown): value is T {
  return tokens.some((token) => token === value);
}
