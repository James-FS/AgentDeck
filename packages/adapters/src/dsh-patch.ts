import { isAlias, isMap, isPair, isScalar, isSeq, parseDocument } from 'yaml';

/**
 * Static-only Cordis patch row helpers shared by the DSH user-profile and
 * bundled-inventory scanners. Expressions marked `!!js` never evaluate here;
 * they only ever mark a value unknown.
 */

export interface YNode {
  items?: unknown[];
  value?: unknown;
  tag?: string;
  source?: string;
}

export const DYNAMIC_MARKER = Object.freeze({ agentDeckDynamicExpression: true });
export const CUSTOM_TAGS = [{
  tag: 'tag:yaml.org,2002:js',
  resolve: () => DYNAMIC_MARKER,
}];

export function scalar(node: unknown): unknown {
  if (!isScalar(node)) return undefined;
  const value = node as YNode;
  if (value.tag === 'tag:yaml.org,2002:js') return undefined;
  return value.value;
}

export function isDynamic(node: unknown): boolean {
  if (!node || typeof node !== 'object' || isAlias(node)) return true;
  const value = node as YNode;
  if (value.tag === 'tag:yaml.org,2002:js') return true;
  if (value.source !== undefined && value.value === undefined && !Array.isArray(value.items)) return true;
  const raw = scalar(node);
  return raw !== null && typeof raw === 'object';
}

export function mapValue(node: unknown, key: string): unknown {
  if (!isMap(node)) return undefined;
  const items = (node as YNode).items;
  if (!Array.isArray(items)) return undefined;
  for (const item of items) {
    if (!isPair(item)) continue;
    const pair = item as { key?: unknown; value?: unknown };
    if (scalar(pair.key) === key) return pair.value;
  }
  return undefined;
}

export function rowSequence(root: unknown): unknown[] {
  if (!isSeq(root)) return [];
  return ((root as YNode).items ?? []).slice(0, 300).flatMap(row => {
    const insert = mapValue(row, 'insert');
    // Static insert declarations are inventory evidence, not an applied Cordis tree.
    return isSeq(insert) ? ((insert as YNode).items ?? []).slice(0, 300) : [row];
  }).slice(0, 300);
}

export function staticString(node: unknown): string | null {
  const value = scalar(node);
  return typeof value === 'string' && !isDynamic(node) ? value : null;
}

export function staticBoolean(node: unknown): boolean | null {
  const value = scalar(node);
  return typeof value === 'boolean' && !isDynamic(node) ? value : null;
}

export function parseStaticPatchRows(sourceText: string): unknown[] | null {
  const document = parseDocument(sourceText, { customTags: CUSTOM_TAGS, schema: 'core' });
  if (document.errors.length > 0) return null;
  if (!isSeq(document.contents)) return null;
  return rowSequence(document.contents);
}
