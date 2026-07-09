/* eslint-disable no-undef */

/**
 * Minimal k6 load-test skeleton for the Minions Agent Framework.
 *
 * Run locally with:
 *   k6 run -e BASE_URL=https://localhost:3001 test/performance/load-test.js
 *
 * This script is intentionally lightweight and is not executed in CI.
 * It provides a starting point for staging performance validation.
 */

const baseUrl = __ENV.BASE_URL || 'http://localhost:3001';

export const options = {
  stages: [
    { duration: '30s', target: 10 },
    { duration: '1m', target: 50 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<5000'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const res = http.get(`${baseUrl}/health`);

  check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 500ms': (r) => r.timings.duration < 500,
  });
}
