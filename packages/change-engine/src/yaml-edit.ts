import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { ChangeEngineError, type DshToggleTarget } from './types.js';

/** Native manager writes disabled = !enabled. Only a unique, static user row is addressable here. */
export function editDshEnabled(original: string, desired: boolean, target: DshToggleTarget) {
  const refuse = (message: string): never => { throw new ChangeEngineError('AMBIGUOUS_TARGET', message); };
  const document = parseDocument(original, { schema: 'core', customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: () => null }] });
  if (document.errors.length || !isSeq(document.contents)) return refuse('DSH 开关文件必须是有效的静态 YAML 行序列。');
  if (!target.id || !target.name || document.contents.items.length > 300) return refuse('DSH 行身份无效或文件超出控制上限。');
  const plain = (node: unknown): string | boolean | null => isScalar(node) && !node.tag && !node.anchor
    && (typeof node.value === 'string' || typeof node.value === 'boolean') ? node.value : null;
  const rows = document.contents.items;
  // Unknown identities and multiple patches may address the same entry; never choose one by position.
  for (const row of rows) {
    if (!isMap(row) || row.has('insert') || isAlias(row)) return refuse('DSH 插入层或非静态行不能直接控制。');
    if (plain(row.get('id', true)) === null) return refuse('DSH 文件包含未确定的行身份，不能安全定位开关。');
  }
  const matches = rows.filter(row => isMap(row) && plain(row.get('id', true)) === target.id);
  if (matches.length !== 1 || !isMap(matches[0])) return refuse('DSH 行身份缺失或重复，不能安全启停。');
  const row = matches[0];
  if (row.anchor || row.has('<<') || plain(row.get('name', true)) !== target.name || row.has('group')) return refuse('DSH 行名称或结构发生变化，不能安全启停。');
  const flag = row.get('disabled', true);
  if (!row.has('disabled')) {
    const eol = original.includes('\r\n') ? '\r\n' : '\n';
    let text: string;
    if (row.flow && row.range && original[row.range[1] - 1] === '}') {
      const offset = row.range[1] - 1;
      text = original.slice(0, offset) + `, disabled: ${!desired}` + original.slice(offset);
    } else {
      const namePair = row.items.find(pair => isScalar(pair.key) && pair.key.value === 'name');
      const key = namePair?.key;
      const value = namePair?.value;
      if (!isScalar(key) || !key.range || !isScalar(value) || !value.range) return refuse('DSH 缺省开关无法安全插入。');
      const lineStart = original.lastIndexOf('\n', key.range[0] - 1) + 1;
      const indent = original.slice(lineStart, key.range[0]);
      if (!/^ +$/.test(indent) || original.slice(value.range[0], value.range[1]).includes('\n')) return refuse('DSH 缺省开关的行格式不受支持。');
      const newline = original.indexOf('\n', value.range[1]);
      const offset = newline === -1 ? original.length : newline + 1;
      text = original.slice(0, offset) + (newline === -1 ? eol : '') + `${indent}disabled: ${!desired}${eol}` + original.slice(offset);
    }
    const checked = parseDocument(text, { schema: 'core', customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: () => null }] });
    if (checked.errors.length) return refuse('DSH 缺省开关插入后结构无效。');
    return { text, previousEnabled: null, hadEnabledField: false };
  }
  if (!isScalar(flag) || typeof plain(flag) !== 'boolean' || !flag.range) return refuse('DSH 仅开放已有静态 disabled 布尔开关。');
  const previousEnabled = !flag.value;
  const text = previousEnabled === desired ? original
    : original.slice(0, flag.range[0]) + String(!desired) + original.slice(flag.range[1]);
  return { text, previousEnabled, hadEnabledField: true };
}
