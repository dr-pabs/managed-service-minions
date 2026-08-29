import http from 'node:http';
import { createMemoryStore, type SessionStore } from 'mcp-toolshed';
import { startDashboardServer, type SamplingQaStat } from '../src/dashboard.js';

function request(
  port: number,
  method: string,
  urlPath: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: 'localhost', port, path: urlPath, method, headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data });
          }
        });
      }
    );
    req.on('error', reject);
    if (body !== undefined) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

const SAMPLE_STATS: SamplingQaStat[] = [
  { effectType: 'crm.case_note.append', reviewed: 20, disagreed: 6, disagreementRate: 0.3, tripped: false },
  { effectType: 'payment.refund', reviewed: 4, disagreed: 3, disagreementRate: 0.75, tripped: true },
];

describe('sampling-QA routes (Milestone 19)', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = createMemoryStore();
  });

  it('GET /api/sampling-qa serves the injected disagreement-rate stats', async () => {
    const server = await startDashboardServer(store, 0, undefined, [], undefined, {
      samplingQaStats: () => SAMPLE_STATS,
    });
    try {
      const response = await request(server.port, 'GET', '/api/sampling-qa');
      expect(response.status).toBe(200);
      expect(response.body).toEqual(SAMPLE_STATS);
    } finally {
      await server.close();
    }
  });

  it('GET /api/sampling-qa returns [] when no stats provider is wired', async () => {
    const server = await startDashboardServer(store, 0);
    try {
      const response = await request(server.port, 'GET', '/api/sampling-qa');
      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('POST /api/sampling-qa/:effectType/reset invokes the reset callback with the decoded type', async () => {
    const resets: string[] = [];
    const server = await startDashboardServer(store, 0, undefined, [], undefined, {
      resetSamplingQa: (effectType) => resets.push(effectType),
    });
    try {
      const response = await request(server.port, 'POST', '/api/sampling-qa/payment.refund/reset');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ reset: 'payment.refund' });
      expect(resets).toEqual(['payment.refund']);
    } finally {
      await server.close();
    }
  });

  it('POST /api/sampling-qa/:effectType/reset 404s when no reset callback is wired', async () => {
    const server = await startDashboardServer(store, 0);
    try {
      const response = await request(server.port, 'POST', '/api/sampling-qa/payment.refund/reset');
      expect(response.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
