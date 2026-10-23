import { defineComponent, h, type VNodeChild } from 'vue';

function safeHref(value: string): string | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) && !value.startsWith('//') ? value : null;
  } catch { return null; }
}

function inline(source: string): VNodeChild[] {
  if (source.length > 4_096) return [h('span', { class: 'md-plain-fallback' }, source)];
  let syntaxMarkers = 0;
  for (const char of source) {
    if ('[]!*_`<>'.includes(char) && ++syntaxMarkers > 64) return [h('span', { class: 'md-plain-fallback' }, source)];
  }
  const pieces: VNodeChild[] = [];
  const pattern = /(!?\[[^\]]*\]\([^\s)]+(?:\s+[^)]*)?\)|\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*]+\*|_[^_]+_|<[^>]*>)/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) pieces.push(source.slice(cursor, index));
    const token = match[0];
    const image = /^!\[([^\]]*)\]\(([^\s)]+)(?:\s+[^)]*)?\)$/.exec(token);
    const link = /^\[([^\]]*)\]\(([^\s)]+)(?:\s+[^)]*)?\)$/.exec(token);
    if (image) pieces.push(h('span', { class: 'md-image-alt' }, `[图片已隐藏：${image[1]}]`));
    else if (link) {
      const href = safeHref(link[2]!);
      pieces.push(href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer nofollow' }, inline(link[1]!)) : h('span', { class: 'md-unsafe-link' }, inline(link[1]!)));
    } else if (/^\*\*/.test(token) || /^__/.test(token)) pieces.push(h('strong', token.slice(2, -2)));
    else if (/^`/.test(token)) pieces.push(h('code', { class: 'md-inline-code' }, token.slice(1, -1)));
    else if (/^\*/.test(token) || /^_/.test(token)) pieces.push(h('em', token.slice(1, -1)));
    else pieces.push(token); // HTML is rendered as a text node, never parsed.
    cursor = index + token.length;
  }
  if (cursor < source.length) pieces.push(source.slice(cursor));
  return pieces;
}

function renderBlocks(markdown: string): VNodeChild[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const nodes: VNodeChild[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) { index += 1; continue; }
    const fence = /^\s*```([^`]*)$/.exec(line);
    if (fence) {
      const content: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index]!)) content.push(lines[index++]!);
      if (index < lines.length) index += 1;
      const language = fence[1]!.trim();
      nodes.push(h('pre', { class: 'md-code-block' }, [h('code', language ? { 'data-language': language } : {}, content.join('\n'))]));
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) { nodes.push(h(`h${heading[1]!.length}`, inline(heading[2]!))); index += 1; continue; }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index]!)) quote.push(lines[index++]!.replace(/^\s*>\s?/, ''));
      nodes.push(h('blockquote', [h('p', quote.flatMap((item, i) => [...(i ? [h('br')] : []), ...inline(item)]))]));
      continue;
    }
    const unordered = /^\s*[-+*]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      const orderedList = Boolean(ordered);
      const tag = orderedList ? 'ol' : 'ul';
      const items: VNodeChild[] = [];
      while (index < lines.length) {
        const item = orderedList ? /^\s*\d+[.)]\s+(.+)$/.exec(lines[index]!) : /^\s*[-+*]\s+(.+)$/.exec(lines[index]!);
        if (!item) break;
        items.push(h('li', inline(item[1]!)));
        index += 1;
      }
      nodes.push(h(tag, items));
      continue;
    }
    if (/^\s*([-*_]\s*){3,}$/.test(line)) { nodes.push(h('hr')); index += 1; continue; }
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index]!.trim() && !/^(\s*```|#{1,6}\s|\s*>|\s*[-+*]\s+|\s*\d+[.)]\s+)/.test(lines[index]!)) {
      paragraph.push(lines[index]!.trim());
      index += 1;
    }
    nodes.push(h('p', paragraph.flatMap((part, i) => [...(i ? [' '] : []), ...inline(part)])));
  }
  return nodes;
}

export default defineComponent({
  name: 'SkillMarkdown',
  props: { source: { type: String, required: true } },
  setup(props) { return () => h('div', { class: 'safe-markdown' }, renderBlocks(props.source)); },
});
