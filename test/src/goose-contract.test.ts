import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttpGooseClient, isGooseReplyResponsePayload } from 'orchestrator';

/**
 * Verifies the Goose wire contract `extensions/orchestrator/src/goose-client.ts`
 * depends on (review finding M5: "goose-runner is unverified against a real
 * Goose server and unused").
 *
 * Two modes, selected by `GOOSE_BASE_URL`:
 *
 * - SET: POSTs the runner's EXACT payload shape to a live `goose serve`
 *   process and asserts the response parses as a `GooseReplyResponsePayload`.
 *   This is the real verification the milestone asks for -- it requires an
 *   actual Goose binary running locally (see extensions/orchestrator/README.md
 *   for how to start one and record fresh fixtures from it). This repo's CI
 *   and this task's execution environment do not have one, so this branch is
 *   env-gated and SKIPPED by default -- it is not exercised by `pnpm test`
 *   or `pnpm test:e2e` here, and no claim of "verified against a live Goose"
 *   is made anywhere in the ExecPlan for this reason.
 * - UNSET (the default, and what actually runs in this environment / CI):
 *   replays the exact request/response pairs recorded in
 *   `test/fixtures/goose/*.json` through a fetch double and asserts the
 *   response parses. This is the "contract double" the milestone text
 *   describes -- it proves goose-client.ts's parsing/shape logic is
 *   self-consistent with the fixtures, but it does NOT prove a real Goose
 *   process actually returns this shape (see the fixtures' own `_comment`
 *   fields, which say so explicitly).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(here, '..', 'fixtures', 'goose');

interface GooseFixture {
  request: { messages: Array<{ role: string; content: string }>; session_id: string; correlation_id: string };
  response: { role: string; content: string };
}

function loadFixture(name: string): GooseFixture {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
  return JSON.parse(raw) as GooseFixture;
}

const FIXTURE_FILES = ['reply-classify-intent.json', 'reply-run-minion.json', 'reply-with-feedback.json'];

describe('Goose /reply contract', () => {
  const gooseBaseUrl = process.env.GOOSE_BASE_URL;

  describe.each(FIXTURE_FILES)('fixture %s', (fixtureFile) => {
    it('parses as a valid GooseReplyResponsePayload', () => {
      const fixture = loadFixture(fixtureFile);
      expect(isGooseReplyResponsePayload(fixture.response)).toBe(true);
    });

    it('round-trips through createHttpGooseClient against the recorded fixture (contract double, no network)', async () => {
      const fixture = loadFixture(fixtureFile);
      const fetchFn = async (url: string, init: RequestInit) => {
        expect(url).toBe('http://fixture.invalid/reply');
        const body = JSON.parse(init.body as string);
        expect(body).toEqual(fixture.request);
        return {
          ok: true,
          status: 200,
          json: async () => fixture.response,
          text: async () => JSON.stringify(fixture.response),
        } as unknown as Response;
      };

      const client = createHttpGooseClient({ baseUrl: 'http://fixture.invalid', fetch: fetchFn });
      const [firstMessage, ...rest] = fixture.request.messages;
      const feedbackMessage = rest.find((m) => m.content.includes('failed schema validation'));
      const result = feedbackMessage
        ? await client.runMinion({
            minionType: 'fixture-minion',
            systemPrompt: firstMessage.content,
            userContent: rest[0].content,
            sessionId: fixture.request.session_id,
            correlationId: fixture.request.correlation_id,
            // No X-Minion-Token header is asserted by this fixture-double
            // test (it only checks the JSON body against the recorded
            // fixture) -- goose-client.test.ts covers the header directly.
            minionToken: '',
            feedback: [feedbackMessage.content.split('\n')[1]],
          })
        : await client.classifyIntent({
            systemPrompt: firstMessage.content,
            userContent: rest[0]?.content ?? '',
            sessionId: fixture.request.session_id,
            correlationId: fixture.request.correlation_id,
          });

      expect(result.raw).toBe(fixture.response.content);
      expect(() => JSON.parse(result.raw)).not.toThrow();
    });
  });

  // Env-gated live path. Not run by default in this environment/CI (no
  // GOOSE_BASE_URL is set here) -- see the file-level doc comment.
  (gooseBaseUrl ? describe : describe.skip)('live goose serve (GOOSE_BASE_URL set)', () => {
    it('accepts the runner\'s exact payload shape and returns a parseable response', async () => {
      const client = createHttpGooseClient({ baseUrl: gooseBaseUrl! });
      const result = await client.classifyIntent({
        systemPrompt: 'You are a test probe for the Goose contract test.',
        userContent: 'Respond with any JSON object.',
        sessionId: 'goose-contract-test-session',
        correlationId: 'corr_goose_contract_test',
      });
      expect(typeof result.raw).toBe('string');
      expect(() => JSON.parse(result.raw)).not.toThrow();
    });
  });
});
