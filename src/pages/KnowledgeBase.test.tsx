/* @vitest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './KnowledgeBase';

describe('renderMarkdown', () => {
  it('escapes raw script HTML while preserving markdown styling when previewing user content', () => {
    // Given: user-controlled Markdown containing styleable Markdown and an XSS payload.
    const markdown = '# Title\n\n**bold** [[Doc <x>]] #tag\n\n<script>alert(1)</script>\n\n[jump](javascript:alert(1))';

    // When: the KnowledgeBase renderer converts it to preview markup.
    const markup = renderToStaticMarkup(<>{renderMarkdown(markdown)}</>);

    // Then: Markdown styling remains, but raw HTML and javascript links are inert text.
    expect(markup).toContain('class="text-2xl font-bold mb-4 pb-2"');
    expect(markup).toContain('Doc &lt;x&gt;');
    expect(markup).toContain('>#tag</span>');
    expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('javascript:alert');
  });
});
