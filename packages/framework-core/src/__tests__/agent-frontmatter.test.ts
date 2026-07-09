import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseFrontmatter,
  readAgentFrontmatter,
  buildMinionTypeToSchemaMap,
} from '../agent-frontmatter.js';

function writeFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

describe('parseFrontmatter', () => {
  it('parses a leading YAML frontmatter block', () => {
    const contents = ['---', 'minion_type: code_writer', 'output_schema: schemas/x.json', '---', '# Body'].join(
      '\n'
    );
    expect(parseFrontmatter(contents)).toEqual({
      minion_type: 'code_writer',
      output_schema: 'schemas/x.json',
    });
  });

  it('returns {} when there is no frontmatter block', () => {
    expect(parseFrontmatter('# Just notes\n\nNo frontmatter here.\n')).toEqual({});
  });

  it('returns {} when the frontmatter block is empty (yaml.load yields undefined)', () => {
    expect(parseFrontmatter(['---', '', '---', '# Body'].join('\n'))).toEqual({});
  });
});

describe('readAgentFrontmatter / buildMinionTypeToSchemaMap', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-frontmatter-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns [] when agents/ does not exist', () => {
    expect(readAgentFrontmatter(tmpDir)).toEqual([]);
  });

  it('reads minion_type and output_schema from every agents/*.md file, sorted by filename', () => {
    writeFile(
      path.join(tmpDir, 'agents', 'b-writer.md'),
      ['---', 'minion_type: code_writer', 'output_schema: schemas/code-writer-output.json', '---'].join('\n')
    );
    writeFile(
      path.join(tmpDir, 'agents', 'a-explorer.md'),
      ['---', 'minion_type: code_explorer', 'output_schema: schemas/code-explorer-output.json', '---'].join(
        '\n'
      )
    );

    const agents = readAgentFrontmatter(tmpDir);
    expect(agents).toEqual([
      {
        file: path.join('agents', 'a-explorer.md'),
        minionType: 'code_explorer',
        outputSchema: 'schemas/code-explorer-output.json',
      },
      {
        file: path.join('agents', 'b-writer.md'),
        minionType: 'code_writer',
        outputSchema: 'schemas/code-writer-output.json',
      },
    ]);
  });

  it('leaves minionType/outputSchema undefined when frontmatter omits them', () => {
    writeFile(path.join(tmpDir, 'agents', 'bare.md'), ['---', 'name: bare', '---'].join('\n'));
    const agents = readAgentFrontmatter(tmpDir);
    expect(agents).toEqual([{ file: path.join('agents', 'bare.md'), minionType: undefined, outputSchema: undefined }]);
  });

  it('skips a file with no frontmatter block at all', () => {
    writeFile(path.join(tmpDir, 'agents', 'plain.md'), '# Just notes\n');
    const agents = readAgentFrontmatter(tmpDir);
    expect(agents).toEqual([{ file: path.join('agents', 'plain.md'), minionType: undefined, outputSchema: undefined }]);
  });

  it('builds a minion_type -> output_schema map, skipping agents missing either field', () => {
    writeFile(
      path.join(tmpDir, 'agents', 'writer.md'),
      ['---', 'minion_type: code_writer', 'output_schema: schemas/code-writer-output.json', '---'].join('\n')
    );
    writeFile(path.join(tmpDir, 'agents', 'incomplete.md'), ['---', 'minion_type: no_schema', '---'].join('\n'));

    const map = buildMinionTypeToSchemaMap(tmpDir);
    expect(map.get('code_writer')).toBe('schemas/code-writer-output.json');
    expect(map.has('no_schema')).toBe(false);
    expect(map.size).toBe(1);
  });

  it('reflects the real repo tree: every real agents/*.md minion_type maps to an existing schema file', () => {
    // packages/framework-core/src/__tests__ -> repo root is four levels up.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, '../../../../');
    const map = buildMinionTypeToSchemaMap(repoRoot);
    expect(map.size).toBeGreaterThan(0);
    for (const [minionType, schemaPath] of map) {
      expect(fs.existsSync(path.join(repoRoot, schemaPath))).toBe(true);
      expect(typeof minionType).toBe('string');
    }
    expect(map.get('ticket_analyst')).toBe('schemas/ticket-analyst-output.json');
    expect(map.get('orchestrator')).toBe('schemas/intent.json');
  });
});
