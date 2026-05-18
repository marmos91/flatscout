/** Thrown on Homegate 401/403; non-retryable, typically indicates bad credentials or stale app secret. */
export class HomegateAuthError extends Error {}
/** Thrown on Homegate 429 after the retry budget is exhausted. */
export class HomegateRateLimit extends Error {}
/** Thrown on any other non-2xx response (or after retries) when no more specific class applies. */
export class HomegateBadResponse extends Error {}
