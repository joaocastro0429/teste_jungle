import { expect, test } from 'bun:test';
import { isTransientInfrastructureError } from '../../src/http/infrastructure-errors';

test('connection outages and wrapped PostgreSQL concurrency errors allow retry', () => {
  expect(isTransientInfrastructureError({ code: 'ECONNREFUSED' })).toBe(true);
  expect(isTransientInfrastructureError({ cause: { code: '40001' } })).toBe(true);
  expect(isTransientInfrastructureError({ code: '08006' })).toBe(true);
  expect(isTransientInfrastructureError({ $metadata: { httpStatusCode: 503 } })).toBe(true);
});

test('programming errors, constraints and permanent AWS errors are not temporary', () => {
  expect(isTransientInfrastructureError(new TypeError('unexpected'))).toBe(false);
  expect(isTransientInfrastructureError({ code: '23514' })).toBe(false);
  expect(
    isTransientInfrastructureError({
      name: 'AccessDeniedException',
      $metadata: { httpStatusCode: 403 },
    }),
  ).toBe(false);
  expect(isTransientInfrastructureError(null)).toBe(false);
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  expect(isTransientInfrastructureError(cycle)).toBe(false);
});
