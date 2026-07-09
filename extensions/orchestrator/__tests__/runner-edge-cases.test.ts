import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrchestratorRunner, type ToolshedInvoker } from '../src/runner.js';
import { createFakeGooseClient } from '../src/fake-goose-client.js';
import { createInMemoryTestStore } from './test-helpers.js';

const SECRET = 'test-signing-secret';

function writeFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function makeToolshed(): ToolshedInvoker {
  return {
    verifyAndExecuteTool: jest.fn(async () => ({ status: 'success', data: {} })),
  };
}

function makeRequest() {
  return {
    platform: 'slack' as const,
    teamId: 'T1',
    channelId: 'C1',
    userId: 'U1',
    text: 'hello',
    threadId: 'ts1',
    sessionId: 'sess_T1:slack:ts1',
    correlationRoot: 'corr_root1',
  };
}

/** Seeds a minimal repo tree (agents/, schemas/, rules/intents.yaml) for edge-case tests that need to control the DAG/agent files directly, independent of the real shipped config. */
function seedTree(root: string): void {
  writeFile(
    path.join(root, 'agents', 'orchestrator.md'),
    ['---', 'name: orchestrator', 'minion_type: orchestrator', 'output_schema: schemas/intent.json', '---', '# Orchestrator'].join('\n')
  );
  writeFile(
    path.join(root, 'schemas', 'intent.json'),
    JSON.stringify({
      type: 'object',
      properties: {
        intent: { type: 'string', enum: ['ticket_lookup', 'orphan_intent'] },
        complexity: { type: 'string' },
        platform: { type: 'string' },
      },
      required: ['intent', 'complexity', 'platform'],
    })
  );
  writeFile(
    path.join(root, 'agents', 'ticket-analyst.md'),
    ['---', 'name: ticket-analyst', 'minion_type: ticket_analyst', 'output_schema: schemas/ticket-analyst-output.json', '---', '# Ticket Analyst'].join('\n')
  );
  writeFile(
    path.join(root, 'schemas', 'ticket-analyst-output.json'),
    JSON.stringify({ type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] })
  );
}

describe('createOrchestratorRunner edge cases', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-runner-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('replies gracefully when the classified intent has no DAG entry in rules/intents.yaml', async () => {
    seedTree(tmpDir);
    writeFile(path.join(tmpDir, 'rules', 'intents.yaml'), ['intents:', '  ticket_lookup:', '    - ticket_analyst'].join('\n'));

    const store = createInMemoryTestStore();
    const toolshed = makeToolshed();
    const goose = createFakeGooseClient({
      toolshed,
      secret: SECRET,
      script: {
        orchestrator: { output: { intent: 'orphan_intent', complexity: 'simple', platform: 'slack' } },
      },
    });

    const runner = createOrchestratorRunner({ goose, store, toolshed, secret: SECRET, repoRoot: tmpDir });
    const response = await runner.run(makeRequest());

    expect(response.text).toMatch(/no minion DAG is configured/i);
  });

  it('parses a minion output that Goose fenced in a ```json code block', async () => {
    seedTree(tmpDir);
    writeFile(path.join(tmpDir, 'rules', 'intents.yaml'), ['intents:', '  ticket_lookup:', '    - ticket_analyst'].join('\n'));

    const store = createInMemoryTestStore();
    const toolshed = makeToolshed();
    // A hand-rolled GooseClient (not the Fake) so the raw response can be
    // exactly the fenced-code-block shape a real model sometimes returns.
    const goose = {
      classifyIntent: async () => ({
        raw: JSON.stringify({ intent: 'ticket_lookup', complexity: 'simple', platform: 'slack' }),
      }),
      runMinion: async () => ({ raw: '```json\n{"summary": "fenced output"}\n```' }),
    };

    const runner = createOrchestratorRunner({ goose, store, toolshed, secret: SECRET, repoRoot: tmpDir });
    const response = await runner.run(makeRequest());

    expect(response.text).toContain('fenced output');
  });

  it('falls back to JSON.stringify when the final minion output has no "summary" field', async () => {
    seedTree(tmpDir);
    writeFile(
      path.join(tmpDir, 'schemas', 'ticket-analyst-output.json'),
      JSON.stringify({ type: 'object', properties: { note: { type: 'string' } }, required: ['note'] })
    );
    writeFile(path.join(tmpDir, 'rules', 'intents.yaml'), ['intents:', '  ticket_lookup:', '    - ticket_analyst'].join('\n'));

    const store = createInMemoryTestStore();
    const toolshed = makeToolshed();
    const goose = createFakeGooseClient({
      toolshed,
      secret: SECRET,
      script: {
        orchestrator: { output: { intent: 'ticket_lookup', complexity: 'simple', platform: 'slack' } },
        ticket_analyst: { output: { note: 'no summary field here' } },
      },
    });

    const runner = createOrchestratorRunner({ goose, store, toolshed, secret: SECRET, repoRoot: tmpDir });
    const response = await runner.run(makeRequest());

    expect(response.text).toContain('no summary field here');
  });

  it('skips an agents/*.md file with no frontmatter block while scanning for a minion_type', async () => {
    seedTree(tmpDir);
    writeFile(path.join(tmpDir, 'agents', 'plain-notes.md'), '# Just notes\n\nNo frontmatter here.\n');
    writeFile(path.join(tmpDir, 'rules', 'intents.yaml'), ['intents:', '  ticket_lookup:', '    - ticket_analyst'].join('\n'));

    const store = createInMemoryTestStore();
    const toolshed = makeToolshed();
    const goose = createFakeGooseClient({
      toolshed,
      secret: SECRET,
      script: {
        orchestrator: { output: { intent: 'ticket_lookup', complexity: 'simple', platform: 'slack' } },
        ticket_analyst: { output: { summary: 'skipped the frontmatter-less file fine', ticket_id: 'T1', title: 't', status: 'open' } },
      },
    });

    const runner = createOrchestratorRunner({ goose, store, toolshed, secret: SECRET, repoRoot: tmpDir });
    const response = await runner.run(makeRequest());

    expect(response.text).toContain('skipped the frontmatter-less file fine');
  });

  it('treats an empty rules/intents.yaml (parses to null) the same as an empty DAG map', async () => {
    seedTree(tmpDir);
    writeFile(path.join(tmpDir, 'rules', 'intents.yaml'), '');

    const store = createInMemoryTestStore();
    const toolshed = makeToolshed();
    const goose = createFakeGooseClient({
      toolshed,
      secret: SECRET,
      script: {
        orchestrator: { output: { intent: 'ticket_lookup', complexity: 'simple', platform: 'slack' } },
      },
    });

    const runner = createOrchestratorRunner({ goose, store, toolshed, secret: SECRET, repoRoot: tmpDir });
    const response = await runner.run(makeRequest());

    expect(response.text).toMatch(/no minion DAG is configured/i);
  });

  it('throws a descriptive error when no agents/*.md file declares the requested minion_type', async () => {
    seedTree(tmpDir);
    writeFile(path.join(tmpDir, 'rules', 'intents.yaml'), ['intents:', '  ticket_lookup:', '    - ghost_minion'].join('\n'));

    const store = createInMemoryTestStore();
    const toolshed = makeToolshed();
    const goose = createFakeGooseClient({
      toolshed,
      secret: SECRET,
      script: {
        orchestrator: { output: { intent: 'ticket_lookup', complexity: 'simple', platform: 'slack' } },
      },
    });

    const runner = createOrchestratorRunner({ goose, store, toolshed, secret: SECRET, repoRoot: tmpDir });
    await expect(runner.run(makeRequest())).rejects.toThrow(/ghost_minion/);
  });

  it('records a contract_violation when a fenced code block does not contain valid JSON either', async () => {
    seedTree(tmpDir);
    writeFile(path.join(tmpDir, 'rules', 'intents.yaml'), ['intents:', '  ticket_lookup:', '    - ticket_analyst'].join('\n'));

    const store = createInMemoryTestStore();
    const toolshed = makeToolshed();
    const goose = {
      classifyIntent: async () => ({
        raw: JSON.stringify({ intent: 'ticket_lookup', complexity: 'simple', platform: 'slack' }),
      }),
      runMinion: async () => ({ raw: '```json\nnot actually json\n```' }),
    };

    const runner = createOrchestratorRunner({ goose, store, toolshed, secret: SECRET, repoRoot: tmpDir });
    const response = await runner.run(makeRequest());

    expect(response.text).toMatch(/schema/i);
    const runs = store.listMinionRunsBySession('sess_T1:slack:ts1');
    expect(runs[0].status).toBe('contract_violation');
  });

  it('replies with an unparseable-output message when Goose returns text that is not JSON and has no fenced block', async () => {
    seedTree(tmpDir);
    writeFile(path.join(tmpDir, 'rules', 'intents.yaml'), ['intents:', '  ticket_lookup:', '    - ticket_analyst'].join('\n'));

    const store = createInMemoryTestStore();
    const toolshed = makeToolshed();
    const goose = {
      classifyIntent: async () => ({
        raw: JSON.stringify({ intent: 'ticket_lookup', complexity: 'simple', platform: 'slack' }),
      }),
      runMinion: async () => ({ raw: 'not json at all, just prose' }),
    };

    const runner = createOrchestratorRunner({ goose, store, toolshed, secret: SECRET, repoRoot: tmpDir });
    const response = await runner.run(makeRequest());

    expect(response.text).toMatch(/schema/i);
    const runs = store.listMinionRunsBySession('sess_T1:slack:ts1');
    expect(runs[0].status).toBe('contract_violation');
  });
});
