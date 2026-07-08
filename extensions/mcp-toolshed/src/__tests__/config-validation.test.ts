import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfigAtRoot, ORCHESTRATOR_EXEMPTION } from '../config-validation.js';
import { loadAllowlists, isToolAllowed } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// extensions/mcp-toolshed/src/__tests__ -> repo root is four levels up.
const REPO_ROOT = path.resolve(here, '../../../../');

function writeFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

describe('validateConfigAtRoot against the real repository', () => {
  it('reports zero errors against the checked-in config (the C4 fix holds)', () => {
    const result = validateConfigAtRoot(REPO_ROOT);
    expect(result.errors).toEqual([]);
  });

  it('warns (does not error) that rules/intents.yaml does not exist yet, per check (f)', () => {
    const result = validateConfigAtRoot(REPO_ROOT);
    expect(
      result.warnings.some((w) => w.includes('intents.yaml') && w.includes('does not exist yet'))
    ).toBe(true);
  });

  it('proves the C4 fix: isToolAllowed(allowlists, "ticket_analyst", "jira", "jira_get_issue") is true using the real loaded YAML', () => {
    const allowlists = loadAllowlists(path.join(REPO_ROOT, 'rules', 'allowlists.yaml'));
    expect(isToolAllowed(allowlists, 'ticket_analyst', 'jira', 'jira_get_issue')).toBe(true);
  });

  it('exempts the orchestrator from the allowlist cross-check', () => {
    expect(ORCHESTRATOR_EXEMPTION).toContain('orchestrator');
  });
});

describe('validateConfigAtRoot against fixture trees', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-config-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedMinimalValidTree(root: string): void {
    writeFile(
      path.join(root, 'agents', 'ticket-analyst.md'),
      [
        '---',
        'name: ticket-analyst',
        'minion_type: ticket_analyst',
        'output_schema: schemas/ticket-analyst-output.json',
        '---',
        '# Ticket Analyst',
      ].join('\n')
    );
    writeFile(
      path.join(root, 'agents', 'orchestrator.md'),
      [
        '---',
        'name: orchestrator',
        'minion_type: orchestrator',
        'output_schema: schemas/intent.json',
        '---',
        '# Orchestrator',
      ].join('\n')
    );
    writeFile(path.join(root, 'schemas', 'ticket-analyst-output.json'), '{}');
    writeFile(
      path.join(root, 'schemas', 'intent.json'),
      JSON.stringify({ properties: { intent: { enum: ['ticket_lookup'] } } })
    );
    writeFile(
      path.join(root, 'rules', 'allowlists.yaml'),
      [
        'allowlists:',
        '  ticket_analyst:',
        '    jira:',
        '      - jira_get_issue',
        'path_scopes:',
        '  ticket_analyst:',
        '    mode: none',
      ].join('\n')
    );
    writeFile(
      path.join(root, 'rules', 'tool-registry.yaml'),
      ['registry:', '  jira:', '    - jira_get_issue'].join('\n')
    );
    writeFile(
      path.join(root, 'rules', 'governance.yaml'),
      ['governance:', '  destructive_actions: []'].join('\n')
    );
  }

  it('passes on a minimal, internally consistent tree', () => {
    seedMinimalValidTree(tmpDir);
    const result = validateConfigAtRoot(tmpDir);
    expect(result.errors).toEqual([]);
  });

  it('skips an agents/*.md file that has no frontmatter block at all', () => {
    seedMinimalValidTree(tmpDir);
    writeFile(path.join(tmpDir, 'agents', 'plain-notes.md'), '# Just notes\n\nNo frontmatter here.\n');
    const result = validateConfigAtRoot(tmpDir);
    expect(result.errors).toEqual([]);
  });

  it('skips an agents/*.md file whose frontmatter omits minion_type', () => {
    seedMinimalValidTree(tmpDir);
    writeFile(
      path.join(tmpDir, 'agents', 'no-minion-type.md'),
      ['---', 'name: no-minion-type', '---', '# No Minion Type'].join('\n')
    );
    const result = validateConfigAtRoot(tmpDir);
    expect(result.errors).toEqual([]);
  });

  it('(a) reports an agent whose minion_type has no allowlists entry', () => {
    seedMinimalValidTree(tmpDir);
    writeFile(
      path.join(tmpDir, 'agents', 'ticket-analyst.md'),
      [
        '---',
        'name: ticket-analyst',
        'minion_type: ticket_lookup',
        'output_schema: schemas/ticket-analyst-output.json',
        '---',
        '# Ticket Analyst',
      ].join('\n')
    );
    const result = validateConfigAtRoot(tmpDir);
    expect(result.errors.some((e) => e.includes('ticket_lookup') && e.includes('no allowlists entry'))).toBe(true);
  });

  it('does not flag the orchestrator for lacking an allowlists entry', () => {
    seedMinimalValidTree(tmpDir);
    const result = validateConfigAtRoot(tmpDir);
    expect(result.errors.some((e) => e.includes('orchestrator'))).toBe(false);
  });

  it('(b) reports a path_scopes key with no matching allowlists key', () => {
    seedMinimalValidTree(tmpDir);
    writeFile(
      path.join(tmpDir, 'rules', 'allowlists.yaml'),
      [
        'allowlists:',
        '  ticket_analyst:',
        '    jira:',
        '      - jira_get_issue',
        'path_scopes:',
        '  ticket_analyst:',
        '    mode: none',
        '  ghost_minion:',
        '    mode: none',
      ].join('\n')
    );
    const result = validateConfigAtRoot(tmpDir);
    expect(result.errors.some((e) => e.includes('ghost_minion') && e.includes('path_scopes'))).toBe(true);
  });

  it('(c) reports a missing output_schema file', () => {
    seedMinimalValidTree(tmpDir);
    writeFile(
      path.join(tmpDir, 'agents', 'ticket-analyst.md'),
      [
        '---',
        'name: ticket-analyst',
        'minion_type: ticket_analyst',
        'output_schema: schemas/does-not-exist.json',
        '---',
        '# Ticket Analyst',
      ].join('\n')
    );
    const result = validateConfigAtRoot(tmpDir);
    expect(result.errors.some((e) => e.includes('does-not-exist.json'))).toBe(true);
  });

  it('(d) reports an allowlisted tool granted under a server alias entirely absent from the registry', () => {
    seedMinimalValidTree(tmpDir);
    writeFile(
      path.join(tmpDir, 'rules', 'allowlists.yaml'),
      [
        'allowlists:',
        '  ticket_analyst:',
        '    servicenow:',
        '      - servicenow_get_incident',
        'path_scopes:',
        '  ticket_analyst:',
        '    mode: none',
      ].join('\n')
    );
    const result = validateConfigAtRoot(tmpDir);
    expect(
      result.errors.some((e) => e.includes('servicenow.servicenow_get_incident') && e.includes('absent from'))
    ).toBe(true);
  });

  it('treats an empty (whitespace-only) YAML config file the same as an absent one', () => {
    seedMinimalValidTree(tmpDir);
    writeFile(path.join(tmpDir, 'rules', 'tool-registry.yaml'), '   \n');
    const result = validateConfigAtRoot(tmpDir);
    expect(result.errors.some((e) => e.includes('jira_get_issue'))).toBe(true);
  });

  it('treats an empty (whitespace-only) agents/*.md frontmatter block as having no fields', () => {
    seedMinimalValidTree(tmpDir);
    writeFile(path.join(tmpDir, 'agents', 'empty-frontmatter.md'), ['---', '   ', '---', '# Empty'].join('\n'));
    const result = validateConfigAtRoot(tmpDir);
    expect(result.errors).toEqual([]);
  });

  it('(d) reports an allowlisted tool absent from the tool registry', () => {
    seedMinimalValidTree(tmpDir);
    writeFile(
      path.join(tmpDir, 'rules', 'allowlists.yaml'),
      [
        'allowlists:',
        '  ticket_analyst:',
        '    jira:',
        '      - jira_get_issue',
        '      - jira_delete_everything',
        'path_scopes:',
        '  ticket_analyst:',
        '    mode: none',
      ].join('\n')
    );
    const result = validateConfigAtRoot(tmpDir);
    expect(result.errors.some((e) => e.includes('jira_delete_everything'))).toBe(true);
  });

  it('(d) warns when the registry lists a tool no allowlist grants', () => {
    seedMinimalValidTree(tmpDir);
    writeFile(
      path.join(tmpDir, 'rules', 'tool-registry.yaml'),
      ['registry:', '  jira:', '    - jira_get_issue', '    - jira_add_comment'].join('\n')
    );
    const result = validateConfigAtRoot(tmpDir);
    expect(result.warnings.some((w) => w.includes('jira_add_comment'))).toBe(true);
  });

  it('(e) reports a destructive_actions entry naming a tool absent from the registry', () => {
    seedMinimalValidTree(tmpDir);
    writeFile(
      path.join(tmpDir, 'rules', 'governance.yaml'),
      [
        'governance:',
        '  destructive_actions:',
        '    - server_alias: jira',
        '      tool_name: jira_nuke_everything',
      ].join('\n')
    );
    const result = validateConfigAtRoot(tmpDir);
    expect(result.errors.some((e) => e.includes('jira_nuke_everything'))).toBe(true);
  });

  it('(e) reports a destructive_actions entry naming a server alias absent from the registry', () => {
    seedMinimalValidTree(tmpDir);
    writeFile(
      path.join(tmpDir, 'rules', 'governance.yaml'),
      [
        'governance:',
        '  destructive_actions:',
        '    - server_alias: nonexistent_server',
        '      tool_name: whatever',
      ].join('\n')
    );
    const result = validateConfigAtRoot(tmpDir);
    expect(result.errors.some((e) => e.includes('nonexistent_server'))).toBe(true);
  });

  it('(f) warns (does not error) on an intent enum value when rules/intents.yaml does not exist', () => {
    seedMinimalValidTree(tmpDir);
    const result = validateConfigAtRoot(tmpDir);
    // intent.json enum contains "ticket_lookup" with no rules/intents.yaml present at all.
    expect(result.errors.some((e) => e.includes('ticket_lookup'))).toBe(false);
    expect(result.warnings.some((w) => w.includes('ticket_lookup') && w.includes('intents.yaml'))).toBe(true);
  });

  it('(f) becomes an error once rules/intents.yaml exists and omits an intent enum value', () => {
    seedMinimalValidTree(tmpDir);
    writeFile(path.join(tmpDir, 'rules', 'intents.yaml'), ['intents:', '  something_else: []'].join('\n'));
    const result = validateConfigAtRoot(tmpDir);
    expect(result.errors.some((e) => e.includes('ticket_lookup') && e.includes('intents.yaml'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('ticket_lookup'))).toBe(false);
  });

  it('(f) passes once rules/intents.yaml exists and covers every intent enum value', () => {
    seedMinimalValidTree(tmpDir);
    writeFile(path.join(tmpDir, 'rules', 'intents.yaml'), ['intents:', '  ticket_lookup:', '    - ticket_analyst'].join('\n'));
    const result = validateConfigAtRoot(tmpDir);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('rejects a cache_policy entry that marks a destructive tool cacheable', () => {
    seedMinimalValidTree(tmpDir);
    writeFile(
      path.join(tmpDir, 'rules', 'governance.yaml'),
      [
        'governance:',
        '  destructive_actions:',
        '    - server_alias: jira',
        '      tool_name: jira_get_issue',
        '  cache_policy:',
        '    jira_get_issue:',
        '      cacheable: true',
      ].join('\n')
    );
    const result = validateConfigAtRoot(tmpDir);
    expect(result.errors.some((e) => e.includes('jira_get_issue') && e.includes('cacheable'))).toBe(true);
  });

  it('(g) reports a path_checked_tools tool name absent from every server in the registry', () => {
    seedMinimalValidTree(tmpDir);
    writeFile(
      path.join(tmpDir, 'rules', 'governance.yaml'),
      ['governance:', '  destructive_actions: []', '  path_checked_tools:', '    delete_everything:', '      - path'].join('\n')
    );
    const result = validateConfigAtRoot(tmpDir);
    expect(
      result.errors.some((e) => e.includes('delete_everything') && e.includes('path_checked_tools'))
    ).toBe(true);
  });

  it('(g) passes when a path_checked_tools tool name appears under some registry server alias (e.g. shell.execute)', () => {
    seedMinimalValidTree(tmpDir);
    writeFile(
      path.join(tmpDir, 'rules', 'tool-registry.yaml'),
      ['registry:', '  jira:', '    - jira_get_issue', '  shell:', '    - execute'].join('\n')
    );
    writeFile(
      path.join(tmpDir, 'rules', 'governance.yaml'),
      ['governance:', '  destructive_actions: []', '  path_checked_tools:', '    execute:', '      - cwd'].join('\n')
    );
    const result = validateConfigAtRoot(tmpDir);
    expect(result.errors.some((e) => e.includes('path_checked_tools'))).toBe(false);
  });

  it('(g) passes against the real, shipped rules/governance.yaml path_checked_tools (execute + the five filesystem tools)', () => {
    const result = validateConfigAtRoot(REPO_ROOT);
    expect(result.errors.some((e) => e.includes('path_checked_tools'))).toBe(false);
  });

  it('prints file and key information in every error message', () => {
    seedMinimalValidTree(tmpDir);
    writeFile(
      path.join(tmpDir, 'agents', 'ticket-analyst.md'),
      [
        '---',
        'name: ticket-analyst',
        'minion_type: ticket_lookup',
        'output_schema: schemas/ticket-analyst-output.json',
        '---',
        '# Ticket Analyst',
      ].join('\n')
    );
    const result = validateConfigAtRoot(tmpDir);
    expect(result.errors[0]).toMatch(/agents[\\/]ticket-analyst\.md/);
  });
});
