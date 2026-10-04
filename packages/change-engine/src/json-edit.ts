import { applyEdits, findNodeAtLocation, modify, parseTree, type Node, type ParseError } from 'jsonc-parser';
import { ChangeEngineError, type JsonToggleTarget } from './types.js';

/** Change one boolean only; preserve JSON comments, unrelated values, formatting and BOM. */
export function editJsonEnabled(original: string, desired: boolean, target: JsonToggleTarget) {
  const invalid = (message: string): never => { throw new ChangeEngineError('INVALID_CONFIG', message); };
  if (!target.path.length || target.path.length > 6 || target.path.some(key => !key || key.length > 4096 || ['__proto__', 'constructor', 'prototype'].includes(key))) invalid('开关路径无效。');
  const bom = original.startsWith('\uFEFF') ? '\uFEFF' : '';
  const text = original.slice(bom.length);
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true });
  if (!tree || tree.type !== 'object' || errors.length) return invalid('开关配置不是有效 JSON 对象。');
  function check(node: Node) {
    if (node.type === 'object') {
      const keys = new Set<string>();
      for (const property of node.children ?? []) {
        const key = property.children?.[0]?.value as string;
        if (keys.has(key)) throw new ChangeEngineError('AMBIGUOUS_TARGET', '配置存在重复键，不能安全修改。');
        keys.add(key);
      }
    }
    for (const child of node.children ?? []) check(child);
  }
  check(tree);
  for (let i = 1; i < target.path.length; i++) {
    const parent = findNodeAtLocation(tree, target.path.slice(0, i));
    if (parent && parent.type !== 'object') invalid('开关所在配置项不是对象，不能覆盖其他设置。');
  }
  const node = findNodeAtLocation(tree, target.path);
  if (node && node.type !== 'boolean') invalid('已有开关不是布尔值，不能自动覆盖。');
  const previousEnabled = node ? node.value as boolean : null;
  if (node?.value === desired) return { text: original, previousEnabled, hadEnabledField: true };
  const updated = node ? text.slice(0, node.offset) + String(desired) + text.slice(node.offset + node.length)
    : applyEdits(text, modify(text, target.path, desired, { formattingOptions: { insertSpaces: !/^\t/m.test(text), tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' } }));
  return { text: bom + updated, previousEnabled, hadEnabledField: Boolean(node) };
}
