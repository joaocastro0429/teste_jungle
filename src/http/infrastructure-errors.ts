/** Unknown failures are internal errors; only known transient failures invite retry. */
export function isTransientInfrastructureError(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const value = current as {
      code?: unknown;
      name?: unknown;
      cause?: unknown;
      $metadata?: { httpStatusCode?: number };
    };
    const code = typeof value.code === 'string' ? value.code : '';
    if (
      [
        'ECONNREFUSED',
        'ECONNRESET',
        'ECONNABORTED',
        'ETIMEDOUT',
        'EPIPE',
        'EAI_AGAIN',
        'ENETUNREACH',
        'EHOSTUNREACH',
        '40001',
        '40P01',
        '55P03',
        '53300',
        '57P01',
        '57P02',
        '57P03',
      ].includes(code) ||
      /^08[0-9A-Z]{3}$/.test(code)
    )
      return true;
    if (
      [
        'TimeoutError',
        'RequestTimeout',
        'RequestTimeoutException',
        'Throttling',
        'ThrottlingException',
        'RequestThrottled',
        'ServiceUnavailable',
        'ServiceUnavailableException',
      ].includes(String(value.name))
    )
      return true;
    const status = value.$metadata?.httpStatusCode;
    if (status === 429 || (typeof status === 'number' && status >= 500 && status <= 599))
      return true;
    current = value.cause;
  }
  return false;
}
