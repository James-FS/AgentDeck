import { createSSRApp, h } from '../apps/web/node_modules/vue/index.mjs';
import { renderToString } from '../apps/web/node_modules/vue/server-renderer/index.mjs';
import { describe, expect, it } from 'vitest';
import SkillMarkdown from '../apps/web/src/components/SkillMarkdown.ts';

describe('safe Skill Markdown preview', () => {
  it('renders basic Markdown while keeping HTML, unsafe links and external images inert', async () => {
    const source = '# Heading\n\n- one\n- two\n\n```ts\nconst safe = true;\n```\n\n<script>window.__xss = true</script>\n[jump](javascript:alert(1))\n![tracker](https://tracker.example/pixel.png)';
    const html = await renderToString(createSSRApp({ render: () => h(SkillMarkdown, { source }) }));
    expect(html).toContain('<h1>Heading</h1>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<pre class="md-code-block"><code data-language="ts">const safe = true;</code></pre>');
    expect(html).toContain('&lt;script&gt;window.__xss = true&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('<img');
    expect(html).toContain('[图片已隐藏：tracker]');
  });

  it('falls back to escaped text quickly for a long line with an unclosed Markdown marker', async () => {
    const source = '['.repeat(60_000);
    const started = performance.now();
    const html = await renderToString(createSSRApp({ render: () => h(SkillMarkdown, { source }) }));
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(750);
    expect(html).toContain('class="md-plain-fallback"');
    expect(html).not.toContain('<script');
  });
});
