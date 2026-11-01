// What comes from outside (JSON files, model servers, the window, the SDK) is
// `unknown` until it is narrowed here. Reading a field of something else than an
// object gives undefined, as `?.` did: a malformed answer is an empty one.

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isString = (v: unknown): v is string => typeof v === 'string';
export const isNumber = (v: unknown): v is number => typeof v === 'number';
export const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
export const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);

/** Its fields, none if it is not an object. */
export const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});
/** Its items, none if it is not a list. */
export const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
export const num = (v: unknown, fallback = 0): number => (typeof v === 'number' ? v : fallback);

export const parseJson = (text: string): unknown => JSON.parse(text);

/** The message of what was thrown (anything can be). */
export const errorMessage = (e: unknown): string => {
  const { message } = rec(e);
  return typeof message === 'string' ? message : String(e);
};
export const errorName = (e: unknown): string => str(rec(e).name);
export const errorCode = (e: unknown): string => str(rec(e).code);
