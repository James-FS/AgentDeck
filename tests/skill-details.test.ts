import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readSkillDetails } from '../packages/core/src/skill-details.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(item => rm(item, { recursive: true, force: true }))); });

describe('Skill details', () => {
  it('keeps long descriptions, parses common metadata and auxiliary OpenAI metadata', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-skill-details-'));
    temporary.push(root);
    const longDescription = 'Long description. '.repeat(60);
    await mkdir(path.join(root, 'agents'), { recursive: true });
    await mkdir(path.join(root, 'references'));
    await writeFile(path.join(root, 'SKILL.md'), `---\nname: demo\ndescription: "${longDescription.trim()}"\nauthor: Ada\nversion: 2.1\nlicense: MIT\ncompatibility: Node 22\nallowed-tools: [Read, Search]\nmetadata:\n  dependencies: [tool-x]\n---\n# Guide\n\nUse this skill safely.`);
    await writeFile(path.join(root, 'agents', 'openai.yaml'), 'interface:\n  short_description: Helpful summary\n  default_prompt: Run this for a task\ndependencies:\n  tools:\n    - type: internal\n      name: browser');
    await writeFile(path.join(root, 'references', 'guide.md'), 'Reference content');
    const detail = await readSkillDetails(root);
    expect(detail.description).toBe(longDescription.trim());
    expect(detail.author).toBe('Ada');
    expect(detail.version).toBe('2.1');
    expect(detail.license).toBe('MIT');
    expect(detail.environment).toBe('Node 22');
    expect(detail.invocation).toBe('Run this for a task');
    expect(detail.dependencies).toContain('Read');
    expect(detail.dependencies).toContain('tool-x');
    expect(detail.supports).toContain(path.join('references', 'guide.md'));
    expect(detail.body).toContain('# Guide');
  });

  it('retains a malformed manifest as a safe text preview with explicit issues', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-skill-details-'));
    temporary.push(root);
    await writeFile(path.join(root, 'SKILL.md'), '---\nname: [broken\n---\n<script>alert(1)</script>\napi_key=ABCDEFGHIJKLMNOPQRST');
    const detail = await readSkillDetails(root);
    expect(detail.metadataIssues.length).toBeGreaterThan(0);
    expect(detail.body).toContain('<script>');
    expect(detail.body).toContain('api_key=[redacted]');
    expect(detail.body).not.toContain('ABCDEFGHIJKLMNOPQRST');
  });
});
