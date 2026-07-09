import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, jest } from '@jest/globals';
import {
  loadSchemas,
  loadMinionSchemaMap,
  validateMinionOutput,
  runWithContract,
  type ContractViolation,
} from '../output-contract.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// packages/framework-core/src/__tests__ -> repo root is four levels up.
const REPO_ROOT = path.resolve(here, '../../../../');
const SCHEMAS_DIR = path.join(REPO_ROOT, 'schemas');

const REAL_SCHEMAS = loadSchemas(SCHEMAS_DIR);
const REAL_SCHEMA_MAP = loadMinionSchemaMap(REPO_ROOT);

const VALID_TICKET_OUTPUT = {
  ticket_id: 'TCK-1',
  title: 'Login broken',
  status: 'open',
  summary: 'User cannot log in with SSO.',
};

const INVALID_TICKET_OUTPUT = {
  ticket_id: 'TCK-1',
  // missing required "title", "status", "summary"
};

describe('loadSchemas', () => {
  it('compiles all eight real schema files (schemas/*-output.json plus intent.json) without error', () => {
    const files = fs.readdirSync(SCHEMAS_DIR).filter((f) => f.endsWith('.json'));
    expect(files.length).toBe(8);
    const result = loadSchemas(SCHEMAS_DIR);
    for (const file of files) {
      expect(result.validators.has(file)).toBe(true);
      expect(typeof result.validators.get(file)).toBe('function');
    }
    expect(result.validators.size).toBe(8);
  });

  it('throws with the filename and reason when a schema file is not valid JSON', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'output-contract-badjson-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'broken.json'), '{ not valid json');
      expect(() => loadSchemas(tmpDir)).toThrow(/broken\.json is not valid JSON/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws with the filename and reason when a schema file fails to compile as a JSON Schema', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'output-contract-badschema-'));
    try {
      // "type": "not-a-real-type" fails ajv strict-mode compilation.
      fs.writeFileSync(
        path.join(tmpDir, 'malformed.json'),
        JSON.stringify({
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'not-a-real-type',
        })
      );
      expect(() => loadSchemas(tmpDir)).toThrow(/malformed\.json failed to compile/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('loadMinionSchemaMap', () => {
  it('maps every real minion_type from agents/*.md frontmatter to its output_schema, matching schemas/', () => {
    expect(REAL_SCHEMA_MAP.get('ticket_analyst')).toBe('schemas/ticket-analyst-output.json');
    expect(REAL_SCHEMA_MAP.get('code_explorer')).toBe('schemas/code-explorer-output.json');
    expect(REAL_SCHEMA_MAP.get('code_reviewer')).toBe('schemas/code-reviewer-output.json');
    expect(REAL_SCHEMA_MAP.get('code_writer')).toBe('schemas/code-writer-output.json');
    expect(REAL_SCHEMA_MAP.get('security_auditor')).toBe('schemas/security-auditor-output.json');
    expect(REAL_SCHEMA_MAP.get('test_writer')).toBe('schemas/test-writer-output.json');
    expect(REAL_SCHEMA_MAP.get('pr_create')).toBe('schemas/pr-crafter-output.json');
    expect(REAL_SCHEMA_MAP.get('orchestrator')).toBe('schemas/intent.json');
    expect(REAL_SCHEMA_MAP.size).toBe(8);
  });
});

describe('validateMinionOutput', () => {
  it('returns {valid: true} for output that satisfies the real ticket-analyst schema', () => {
    const result = validateMinionOutput('ticket_analyst', VALID_TICKET_OUTPUT, REAL_SCHEMA_MAP, REAL_SCHEMAS);
    expect(result).toEqual({ valid: true });
  });

  it('returns {valid: false, errors} listing the missing-required-property failures', () => {
    const result = validateMinionOutput('ticket_analyst', INVALID_TICKET_OUTPUT, REAL_SCHEMA_MAP, REAL_SCHEMAS);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.includes('title'))).toBe(true);
    }
  });

  it('is invalid with a descriptive error for a minion type with no registered schema', () => {
    const result = validateMinionOutput('nonexistent_minion', {}, REAL_SCHEMA_MAP, REAL_SCHEMAS);
    expect(result).toEqual({
      valid: false,
      errors: ['no output_schema is registered for minion type "nonexistent_minion"'],
    });
  });

  it('is invalid with a descriptive error when the mapped schema file was not compiled', () => {
    const schemaMap = new Map([['ghost_minion', 'schemas/ghost-output.json']]);
    const result = validateMinionOutput('ghost_minion', {}, schemaMap, REAL_SCHEMAS);
    expect(result).toEqual({
      valid: false,
      errors: ['schema file "ghost-output.json" for minion type "ghost_minion" was not compiled by loadSchemas'],
    });
  });
});

describe('runWithContract (retry_once_with_feedback)', () => {
  it('valid output on the first attempt passes with attempts: 1 and runMinion is called exactly once', async () => {
    const runMinion = jest.fn().mockResolvedValue(VALID_TICKET_OUTPUT);

    const result = await runWithContract(runMinion, {
      minionType: 'ticket_analyst',
      schemaMap: REAL_SCHEMA_MAP,
      schemas: REAL_SCHEMAS,
    });

    expect(runMinion).toHaveBeenCalledTimes(1);
    expect(runMinion).toHaveBeenCalledWith();
    expect(result).toEqual({ status: 'valid', output: VALID_TICKET_OUTPUT, attempts: 1 });
  });

  it('invalid-then-valid triggers EXACTLY ONE retry, and the retry receives the first attempt\'s validation errors', async () => {
    const runMinion = jest
      .fn()
      .mockResolvedValueOnce(INVALID_TICKET_OUTPUT)
      .mockResolvedValueOnce(VALID_TICKET_OUTPUT);

    const result = await runWithContract(runMinion, {
      minionType: 'ticket_analyst',
      schemaMap: REAL_SCHEMA_MAP,
      schemas: REAL_SCHEMAS,
    });

    expect(runMinion).toHaveBeenCalledTimes(2);
    expect(runMinion).toHaveBeenNthCalledWith(1);
    const secondCallArgs = runMinion.mock.calls[1];
    expect(secondCallArgs).toHaveLength(1);
    const feedback = secondCallArgs[0] as string[];
    expect(Array.isArray(feedback)).toBe(true);
    expect(feedback.length).toBeGreaterThan(0);
    expect(feedback.some((e) => e.includes('title'))).toBe(true);
    expect(result).toEqual({ status: 'valid', output: VALID_TICKET_OUTPUT, attempts: 2 });
  });

  it('invalid-twice yields a typed ContractViolation (not a throw) after exactly one retry', async () => {
    const runMinion = jest.fn().mockResolvedValue(INVALID_TICKET_OUTPUT);

    const result = await runWithContract(runMinion, {
      minionType: 'ticket_analyst',
      schemaMap: REAL_SCHEMA_MAP,
      schemas: REAL_SCHEMAS,
    });

    expect(runMinion).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('contract_violation');
    const violation = result as ContractViolation;
    expect(violation.minionType).toBe('ticket_analyst');
    expect(violation.attempts).toBe(2);
    expect(violation.errors.length).toBeGreaterThan(0);
    expect(violation.lastOutput).toEqual(INVALID_TICKET_OUTPUT);
  });

  it('does not swallow an error thrown by runMinion itself (a different failure mode than invalid output)', async () => {
    const runMinion = jest.fn().mockRejectedValue(new Error('network down'));

    await expect(
      runWithContract(runMinion, {
        minionType: 'ticket_analyst',
        schemaMap: REAL_SCHEMA_MAP,
        schemas: REAL_SCHEMAS,
      })
    ).rejects.toThrow('network down');
    expect(runMinion).toHaveBeenCalledTimes(1);
  });
});
