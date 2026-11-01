/**
 * not in legacy: a relative web path is safe to redirect to after sign-in.
 * Starts with a single `/`; no `//`, backslash or control characters (browsers
 * read `/\host` like `//host`).
 */
export function isSafeNextPath(next: unknown): next is string {
  return (
    typeof next === 'string' &&
    next.length > 0 &&
    next.length <= 2000 &&
    next.startsWith('/') &&
    !next.startsWith('//') &&
    // eslint-disable-next-line no-control-regex
    !/[\\\u0000-\u001f\u007f]/.test(next)
  );
}
