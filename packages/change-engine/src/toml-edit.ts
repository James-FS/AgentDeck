import TOML from '@iarna/toml';
import { ChangeEngineError } from './types.js';

interface Line { text: string; start: number; end: number; newline: string }
interface Header { line: number; keys: string[]; array: boolean }

function invalid(message = 'The Codex TOML configuration is invalid or unsupported.'): never {
  throw new ChangeEngineError('INVALID_CONFIG', message);
}

function parserView(text: string): string {
  const withoutBom = text.replace(/^\uFEFF/, '');
  if (/\r(?!\n)/.test(withoutBom)) return invalid('The Codex TOML file uses an unsupported line ending.');
  return withoutBom.replace(/\r\n/g, '\n');
}

function ambiguous(message = 'The requested independent MCP table is missing, duplicated, or not safely addressable.'): never {
  throw new ChangeEngineError('AMBIGUOUS_TARGET', message);
}

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '\n' && text[i] !== '\r') continue;
    const end = i;
    let newline = text[i] ?? '';
    if (newline === '\r' && text[i + 1] === '\n') { newline = '\r\n'; i += 1; }
    lines.push({ text: text.slice(start, end), start, end: i + 1, newline });
    start = i + 1;
  }
  if (start <= text.length) lines.push({ text: text.slice(start), start, end: text.length, newline: '' });
  return lines;
}

function decodeBasicKey(raw: string): string | null {
  let output = '';
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i] ?? '';
    if (char !== '\\') { output += char; continue; }
    const escape = raw[++i];
    if (escape === undefined) return null;
    const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
    if (Object.prototype.hasOwnProperty.call(simple, escape)) { output += simple[escape]; continue; }
    const digits = escape === 'u' ? 4 : escape === 'U' ? 8 : 0;
    if (digits === 0) return null;
    const hex = raw.slice(i + 1, i + 1 + digits);
    if (hex.length !== digits || !/^[0-9a-fA-F]+$/.test(hex)) return null;
    const codepoint = Number.parseInt(hex, 16);
    if (codepoint > 0x10ffff || (codepoint >= 0xd800 && codepoint <= 0xdfff)) return null;
    output += String.fromCodePoint(codepoint);
    i += digits;
  }
  return output;
}

function readKey(input: string, start: number): { key: string; end: number } | null {
  const first = input[start];
  if (first === '"' || first === "'") {
    const quote = first;
    let cursor = start + 1;
    let escaped = false;
    for (; cursor < input.length; cursor += 1) {
      const char = input[cursor] ?? '';
      if (quote === '"' && char === '\\' && !escaped) { escaped = true; continue; }
      if (char === quote && !escaped) {
        const raw = input.slice(start + 1, cursor);
        return { key: quote === '"' ? (decodeBasicKey(raw) ?? '') : raw, end: cursor + 1 };
      }
      escaped = false;
    }
    return null;
  }
  let cursor = start;
  while (cursor < input.length && /[A-Za-z0-9_-]/.test(input[cursor] ?? '')) cursor += 1;
  if (cursor === start) return null;
  return { key: input.slice(start, cursor), end: cursor };
}

function parseHeader(line: string): { keys: string[]; array: boolean } | null {
  const text = line.trim();
  if (!text.startsWith('[')) return null;
  const array = text.startsWith('[[');
  let cursor = array ? 2 : 1;
  const closing = array ? ']]' : ']';
  const keys: string[] = [];
  while (cursor < text.length) {
    while (text[cursor] === ' ' || text[cursor] === '\t') cursor += 1;
    const parsed = readKey(text, cursor);
    if (!parsed || parsed.key.length === 0) return null;
    keys.push(parsed.key);
    cursor = parsed.end;
    while (text[cursor] === ' ' || text[cursor] === '\t') cursor += 1;
    if (text[cursor] === '.') { cursor += 1; continue; }
    if (!text.startsWith(closing, cursor)) return null;
    cursor += closing.length;
    while (text[cursor] === ' ' || text[cursor] === '\t') cursor += 1;
    return cursor === text.length || text[cursor] === '#' ? { keys, array } : null;
  }
  return null;
}

function headerList(text: string): Header[] {
  const lines = linesOf(text);
  const headers: Header[] = [];
  let multiline: 'basic' | 'literal' | null = null;
  let squareDepth = 0;
  let curlyDepth = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]?.text ?? '';
    if (multiline === null && squareDepth === 0 && curlyDepth === 0) {
      const parsed = parseHeader(line.replace(/^\uFEFF/, ''));
      if (parsed) { headers.push({ line: lineIndex, ...parsed }); continue; }
    }
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i] ?? '';
      if (multiline === 'basic') {
        if (char === '\\') { i += 1; continue; }
        if (line.slice(i, i + 3) === '"""') { multiline = null; i += 2; }
        continue;
      }
      if (multiline === 'literal') {
        if (line.slice(i, i + 3) === "'''") { multiline = null; i += 2; }
        continue;
      }
      if (char === '#') break;
      if (char === '"') {
        if (line.slice(i, i + 3) === '"""') { multiline = 'basic'; i += 2; continue; }
        for (i += 1; i < line.length; i += 1) {
          if (line[i] === '\\') { i += 1; continue; }
          if (line[i] === '"') break;
        }
        continue;
      }
      if (char === "'") {
        if (line.slice(i, i + 3) === "'''") { multiline = 'literal'; i += 2; continue; }
        for (i += 1; i < line.length && line[i] !== "'"; i += 1) { /* literal string */ }
        continue;
      }
      if (char === '[') squareDepth += 1;
      else if (char === ']') squareDepth = Math.max(0, squareDepth - 1);
      else if (char === '{') curlyDepth += 1;
      else if (char === '}') curlyDepth = Math.max(0, curlyDepth - 1);
    }
  }
  return headers;
}

function assignmentKey(line: string): { key: string; equals: number } | null {
  let quote: 'basic' | 'literal' | null = null;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i] ?? '';
    if (quote === 'basic') {
      if (char === '\\' && !escaped) { escaped = true; continue; }
      if (char === '"' && !escaped) quote = null;
      escaped = false;
      continue;
    }
    if (quote === 'literal') { if (char === "'") quote = null; continue; }
    if (char === '#') return null;
    if (char === '"') quote = 'basic';
    else if (char === "'") quote = 'literal';
    else if (char === '=') {
      const lhs = line.slice(0, i).trim();
      const parsed = readKey(lhs, 0);
      return parsed && parsed.end === lhs.length ? { key: parsed.key, equals: i } : null;
    }
  }
  return null;
}

function booleanValue(text: string): boolean | null {
  const withoutComment = text.replace(/\s+#.*$/, '').trim();
  if (withoutComment === 'true') return true;
  if (withoutComment === 'false') return false;
  return null;
}

interface LexState { multiline: 'basic' | 'literal' | null; square: number; curly: number }

function advanceLexState(line: string, state: LexState): void {
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i] ?? '';
    if (state.multiline === 'basic') {
      if (char === '\\') { i += 1; continue; }
      if (line.slice(i, i + 3) === '"""') { state.multiline = null; i += 2; }
      continue;
    }
    if (state.multiline === 'literal') {
      if (line.slice(i, i + 3) === "'''") { state.multiline = null; i += 2; }
      continue;
    }
    if (char === '#') break;
    if (char === '"') {
      if (line.slice(i, i + 3) === '"""') { state.multiline = 'basic'; i += 2; continue; }
      for (i += 1; i < line.length; i += 1) {
        if (line[i] === '\\') { i += 1; continue; }
        if (line[i] === '"') break;
      }
      continue;
    }
    if (char === "'") {
      if (line.slice(i, i + 3) === "'''") { state.multiline = 'literal'; i += 2; continue; }
      for (i += 1; i < line.length && line[i] !== "'"; i += 1) { /* literal string */ }
      continue;
    }
    if (char === '[') state.square += 1;
    else if (char === ']') state.square = Math.max(0, state.square - 1);
    else if (char === '{') state.curly += 1;
    else if (char === '}') state.curly = Math.max(0, state.curly - 1);
  }
}

export interface EditedToml { text: string; previousEnabled: boolean | null; hadEnabledField: boolean }

export function editIndependentMcpEnabled(original: string, serverName: string, desired: boolean): EditedToml {
  let parsed: Record<string, unknown>;
  try { parsed = TOML.parse(parserView(original)) as Record<string, unknown>; }
  catch { return invalid(); }
  const mcpServers = parsed.mcp_servers;
  if (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers)
    || !Object.prototype.hasOwnProperty.call(mcpServers, serverName)) return ambiguous();
  const target = (mcpServers as Record<string, unknown>)[serverName];
  if (!target || typeof target !== 'object' || Array.isArray(target)) return ambiguous('The requested MCP declaration is not a regular table.');
  const before = (target as Record<string, unknown>).enabled;
  if (before !== undefined && typeof before !== 'boolean') return invalid('The enabled field is not a TOML boolean.');
  const previousEnabled = before === undefined ? true : before;

  const lines = linesOf(original);
  const headers = headerList(original);
  const matches = headers.filter((header) => !header.array && header.keys.length === 2 && header.keys[0] === 'mcp_servers' && header.keys[1] === serverName);
  if (matches.length !== 1) return ambiguous();
  const targetHeader = matches[0];
  if (!targetHeader) return ambiguous();
  const nextHeader = headers.find((header) => header.line > targetHeader.line);
  const sectionEndLine = nextHeader?.line ?? lines.length;
  const stateAssignments: Array<{ line: number; equals: number; value: boolean }> = [];
  const lexState: LexState = { multiline: null, square: 0, curly: 0 };
  for (let index = targetHeader.line + 1; index < sectionEndLine; index += 1) {
    const currentLine = lines[index]?.text ?? '';
    if (lexState.multiline === null && lexState.square === 0 && lexState.curly === 0) {
      const assignment = assignmentKey(currentLine);
      if (assignment?.key === 'enabled') {
        const value = booleanValue(currentLine.slice(assignment.equals + 1));
        if (value === null) return invalid('The enabled field could not be safely edited as a single-line TOML boolean.');
        stateAssignments.push({ line: index, equals: assignment.equals, value });
      }
    }
    advanceLexState(currentLine, lexState);
  }
  if (stateAssignments.length > 1) return ambiguous('The target table declares enabled more than once.');

  if (stateAssignments.length === 1) {
    const found = stateAssignments[0];
    if (!found) return ambiguous();
    const line = lines[found.line];
    if (!line) return ambiguous();
    const valueStart = found.equals + 1;
    const valueTail = line.text.slice(valueStart);
    const match = /^(\s*)(true|false)(\s*(?:#.*)?)$/.exec(valueTail);
    if (!match) return invalid('The enabled field could not be safely edited as a single-line TOML boolean.');
    const tokenStart = valueStart + (match[1]?.length ?? 0);
    const tokenEnd = tokenStart + (match[2]?.length ?? 0);
    const updatedLine = line.text.slice(0, tokenStart) + String(desired) + line.text.slice(tokenEnd);
    const updated = original.slice(0, line.start) + updatedLine + line.newline + original.slice(line.end);
    validateEditedToml(updated, serverName, desired);
    return { text: updated, previousEnabled, hadEnabledField: true };
  }

  const newline = lines.find((line) => line.newline !== '')?.newline ?? '\n';
  const insertionLine = nextHeader?.line ?? lines.length;
  const insertionOffset = insertionLine < lines.length ? (lines[insertionLine]?.start ?? original.length) : original.length;
  const prefix = insertionOffset > 0 && !original.slice(0, insertionOffset).endsWith('\n') && !original.slice(0, insertionOffset).endsWith('\r')
    ? newline : '';
  const keepFinalNewline = insertionOffset === original.length && /(?:\r\n|\n|\r)$/.test(original);
  const inserted = `${prefix}enabled = ${String(desired)}${insertionOffset < original.length || keepFinalNewline ? newline : ''}`;
  const updated = original.slice(0, insertionOffset) + inserted + original.slice(insertionOffset);
  validateEditedToml(updated, serverName, desired);
  return { text: updated, previousEnabled, hadEnabledField: false };
}

function validateEditedToml(text: string, serverName: string, desired: boolean): void {
  try {
    const result = TOML.parse(parserView(text)) as Record<string, unknown>;
    const servers = result.mcp_servers as Record<string, unknown> | undefined;
    const target = servers?.[serverName] as Record<string, unknown> | undefined;
    if (!target || target.enabled !== desired) invalid('The edited Codex TOML did not preserve the requested table structure.');
  } catch (error) {
    if (error instanceof ChangeEngineError) throw error;
    invalid('The edited Codex TOML did not pass syntax validation.');
  }
}
