import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPipeline, parsePipelineYaml } from '../src/pipeline-config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const RECIPES = path.resolve(here, '..', '..', '..', 'recipes');

function validRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    max_attempts: 2,
    on_failure: 'dead_letter',
    classify: { agent: 'refund_classifier', system_prompt: 'refund-classify.md' },
    act: { agent: 'refund_processor', system_prompt: 'refund-act.md', output_schema: 'refund-action-output.json' },
    verify: {
      verifier: 'composite:refund_request',
      schema: true,
      reconcile_checks: [
        {
          server_alias: 'payments',
          tool_name: 'payments_get_charge',
          params: { order_id: '$output.order_id' },
          assert: { read_field: 'amount_usd', output_field: 'amount_usd' },
        },
      ],
      judge: { agent: 'refund_judge', system_prompt: 'refund-judge.md', sample_percent: 0 },
    },
    commit: { effect_type: 'payment.refund', target_system: 'payments', reversibility: 'compensatable' },
    ...overrides,
  };
}

describe('loadPipeline', () => {
  it('loads the declarative refund_request recipe and compiles its act schema', () => {
    const loaded = loadPipeline(RECIPES, 'refund_request');
    expect(loaded.config.item_type).toBe('refund_request');
    expect(loaded.config.act.agent).toBe('refund_processor');
    expect(loaded.config.act.system_prompt).toContain('refund_processor');
    expect(loaded.config.classify?.agent).toBe('refund_classifier');
    expect(loaded.config.max_attempts).toBe(2);
    expect(loaded.config.on_failure).toBe('dead_letter');
    expect(loaded.config.commit.effect_type).toBe('payment.refund');
    expect(loaded.schemaMap.get('refund_processor')).toBe('refund-action-output.json');
    expect(loaded.schemas.validators.has('refund-action-output.json')).toBe(true);
  });

  it('throws when the recipe directory has no item-pipelines.yaml', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-'));
    expect(() => loadPipeline(dir, 'refund_request')).toThrow(/not found/);
  });

  it('throws when the yaml has no item_pipelines mapping', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-'));
    fs.writeFileSync(path.join(dir, 'item-pipelines.yaml'), 'foo: bar\n');
    expect(() => loadPipeline(dir, 'refund_request')).toThrow(/item_pipelines mapping/);
  });

  it('throws when the requested item type has no pipeline', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-'));
    fs.writeFileSync(path.join(dir, 'item-pipelines.yaml'), 'item_pipelines: {}\n');
    expect(() => loadPipeline(dir, 'refund_request')).toThrow(/no pipeline for item type/);
  });
});

describe('parsePipelineYaml', () => {
  it('parses a valid pipeline and resolves prompts to inline text', () => {
    const config = parsePipelineYaml(validRaw(), 'refund_request', RECIPES);
    expect(config.item_type).toBe('refund_request');
    expect(config.max_attempts).toBe(2);
    expect(config.on_failure).toBe('dead_letter');
    expect(config.classify).toBeDefined();
    expect(config.act.system_prompt).toContain('refund_processor');
    expect(config.verify.schema).toBe(true);
    expect(config.verify.reconcile_checks).toHaveLength(1);
    expect(config.verify.judge?.sample_percent).toBe(0);
    expect(config.commit.reversibility).toBe('compensatable');
  });

  it('defaults max_attempts to 1 and on_failure to dead_letter', () => {
    const config = parsePipelineYaml(validRaw({ max_attempts: undefined, on_failure: undefined }), 'refund_request', RECIPES);
    expect(config.max_attempts).toBe(1);
    expect(config.on_failure).toBe('dead_letter');
  });

  it('omits classify when no classify step is present', () => {
    const config = parsePipelineYaml(validRaw({ classify: undefined }), 'refund_request', RECIPES);
    expect(config.classify).toBeUndefined();
  });

  it('omits optional verify sections when absent', () => {
    const config = parsePipelineYaml(
      validRaw({ verify: { verifier: 'composite:refund_request' } }),
      'refund_request',
      RECIPES
    );
    expect(config.verify.schema).toBeUndefined();
    expect(config.verify.reconcile_checks).toBeUndefined();
    expect(config.verify.judge).toBeUndefined();
  });

  it('defaults judge sample_percent to 0 when omitted', () => {
    const config = parsePipelineYaml(
      validRaw({ verify: { verifier: 'composite:x', judge: { agent: 'a', system_prompt: 'refund-judge.md' } } }),
      'refund_request',
      RECIPES
    );
    expect(config.verify.judge?.sample_percent).toBe(0);
  });

  it('rejects a non-mapping pipeline', () => {
    expect(() => parsePipelineYaml('nope', 'refund_request', RECIPES)).toThrow(/must be a mapping/);
  });

  it.each([
    ['max_attempts non-number', { max_attempts: 'two' }, /max_attempts must be an integer/],
    ['max_attempts non-integer', { max_attempts: 1.5 }, /max_attempts must be an integer/],
    ['max_attempts below 1', { max_attempts: 0 }, /max_attempts must be >= 1/],
    ['on_failure invalid', { on_failure: 'retry' }, /on_failure must be/],
    ['on_failure escalate is valid', { on_failure: 'escalate' }, null],
  ])('%s', (_name, overrides, expected) => {
    if (expected) {
      expect(() => parsePipelineYaml(validRaw(overrides), 'refund_request', RECIPES)).toThrow(expected);
    } else {
      expect(parsePipelineYaml(validRaw(overrides), 'refund_request', RECIPES).on_failure).toBe('escalate');
    }
  });

  it('rejects a missing or non-string act.agent', () => {
    expect(() => parsePipelineYaml(validRaw({ act: {} }), 'refund_request', RECIPES)).toThrow(/act.agent/);
    expect(() =>
      parsePipelineYaml(validRaw({ act: { agent: 42, system_prompt: 'refund-act.md', output_schema: 'x.json' } }), 'refund_request', RECIPES)
    ).toThrow(/act.agent/);
    expect(() =>
      parsePipelineYaml(validRaw({ act: { agent: '', system_prompt: 'refund-act.md', output_schema: 'x.json' } }), 'refund_request', RECIPES)
    ).toThrow(/act.agent/);
  });

  it('rejects a missing prompt file', () => {
    expect(() =>
      parsePipelineYaml(validRaw({ act: { agent: 'a', system_prompt: 'nope.md', output_schema: 'x.json' } }), 'refund_request', RECIPES)
    ).toThrow(/prompt file not found/);
  });

  it('rejects a non-mapping or missing-field verify', () => {
    expect(() => parsePipelineYaml(validRaw({ verify: 'x' }), 'refund_request', RECIPES)).toThrow(/verify must be a mapping/);
    expect(() => parsePipelineYaml(validRaw({ verify: {} }), 'refund_request', RECIPES)).toThrow(/verify.verifier/);
    expect(() =>
      parsePipelineYaml(validRaw({ verify: { verifier: 'composite:x', schema: 'yes' } }), 'refund_request', RECIPES)
    ).toThrow(/verify.schema/);
  });

  it('rejects malformed reconcile_checks', () => {
    expect(() =>
      parsePipelineYaml(validRaw({ verify: { verifier: 'composite:x', reconcile_checks: 'x' } }), 'refund_request', RECIPES)
    ).toThrow(/reconcile_checks must be an array/);
    expect(() =>
      parsePipelineYaml(validRaw({ verify: { verifier: 'composite:x', reconcile_checks: ['x'] } }), 'refund_request', RECIPES)
    ).toThrow(/must be a mapping/);
    expect(() =>
      parsePipelineYaml(
        validRaw({ verify: { verifier: 'composite:x', reconcile_checks: [{ tool_name: 't' }] } }),
        'refund_request',
        RECIPES
      )
    ).toThrow(/server_alias/);
    expect(() =>
      parsePipelineYaml(
        validRaw({
          verify: {
            verifier: 'composite:x',
            reconcile_checks: [{ server_alias: 's', tool_name: 't', params: 'x', assert: { read_field: 'r', output_field: 'o' } }],
          },
        }),
        'refund_request',
        RECIPES
      )
    ).toThrow(/params must be a mapping/);
    expect(() =>
      parsePipelineYaml(
        validRaw({
          verify: {
            verifier: 'composite:x',
            reconcile_checks: [{ server_alias: 's', tool_name: 't', params: {}, assert: { output_field: 'o' } }],
          },
        }),
        'refund_request',
        RECIPES
      )
    ).toThrow(/read_field/);
    expect(() =>
      parsePipelineYaml(
        validRaw({
          verify: {
            verifier: 'composite:x',
            reconcile_checks: [{ server_alias: 's', tool_name: 't', params: {}, assert: { read_field: 'r' } }],
          },
        }),
        'refund_request',
        RECIPES
      )
    ).toThrow(/output_field/);
  });

  it('rejects a malformed judge', () => {
    expect(() =>
      parsePipelineYaml(validRaw({ verify: { verifier: 'composite:x', judge: 'x' } }), 'refund_request', RECIPES)
    ).toThrow(/judge must be a mapping/);
    expect(() =>
      parsePipelineYaml(
        validRaw({ verify: { verifier: 'composite:x', judge: { system_prompt: 'refund-judge.md', sample_percent: 0 } } }),
        'refund_request',
        RECIPES
      )
    ).toThrow(/judge.agent/);
    expect(() =>
      parsePipelineYaml(
        validRaw({ verify: { verifier: 'composite:x', judge: { agent: 'a', system_prompt: 'refund-judge.md', sample_percent: 101 } } }),
        'refund_request',
        RECIPES
      )
    ).toThrow(/sample_percent/);
    expect(() =>
      parsePipelineYaml(
        validRaw({ verify: { verifier: 'composite:x', judge: { agent: 'a', system_prompt: 'refund-judge.md', sample_percent: 'all' } } }),
        'refund_request',
        RECIPES
      )
    ).toThrow(/sample_percent/);
  });

  it('rejects a malformed classify', () => {
    expect(() => parsePipelineYaml(validRaw({ classify: 'x' }), 'refund_request', RECIPES)).toThrow(/classify must be a mapping/);
  });

  it('rejects a malformed commit', () => {
    expect(() => parsePipelineYaml(validRaw({ commit: 'x' }), 'refund_request', RECIPES)).toThrow(/commit must be a mapping/);
    expect(() =>
      parsePipelineYaml(validRaw({ commit: { target_system: 'payments', reversibility: 'compensatable' } }), 'refund_request', RECIPES)
    ).toThrow(/commit.effect_type/);
  });
});
