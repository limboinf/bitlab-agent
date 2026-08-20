/**
 * `@browser` — the user pointing at the page they have open.
 *
 * The token is a pointing gesture, not content: it never carries the page body.
 * Reading the page stays a `browser_tool` call, which the transcript shows and
 * the permission engine can gate.
 */

import { describe, expect, it } from 'bun:test';
import {
  formatBrowserDirective,
  parseMentions,
  resolveBrowserMentions,
} from '../index.ts';

describe('parseMentions — browser', () => {
  it('extracts the page url', () => {
    const parsed = parseMentions('what does [browser:https://example.com/a?b=1] say?', []);
    expect(parsed.browserPages).toEqual(['https://example.com/a?b=1']);
  });

  it('dedupes repeated mentions of the same page', () => {
    const parsed = parseMentions('[browser:https://x.dev/] and [browser:https://x.dev/]', []);
    expect(parsed.browserPages).toEqual(['https://x.dev/']);
  });

  it('keeps distinct pages in order', () => {
    const parsed = parseMentions('[browser:https://a.dev/] [browser:https://b.dev/]', []);
    expect(parsed.browserPages).toEqual(['https://a.dev/', 'https://b.dev/']);
  });

  it('is empty when nothing is mentioned', () => {
    expect(parseMentions('plain text', []).browserPages).toEqual([]);
  });

  it('does not swallow other mention types', () => {
    const parsed = parseMentions('[browser:https://a.dev/] [mcp:server-x] [file:src/a.ts]', []);
    expect(parsed.browserPages).toEqual(['https://a.dev/']);
    expect(parsed.mcpServers).toEqual(['server-x']);
    expect(parsed.files).toEqual(['src/a.ts']);
  });
});

describe('resolveBrowserMentions', () => {
  it('rewrites the token into prose naming the page', () => {
    expect(resolveBrowserMentions('summarize [browser:https://example.com/]')).toBe(
      'summarize [The page open in the browser: https://example.com/]',
    );
  });

  it('leaves text without mentions untouched', () => {
    expect(resolveBrowserMentions('no mentions here')).toBe('no mentions here');
  });
});

describe('formatBrowserDirective', () => {
  it('is empty when no page was mentioned', () => {
    expect(formatBrowserDirective([])).toBe('');
  });

  it('tells the agent to actually read the page, not guess from the url', () => {
    const directive = formatBrowserDirective(['https://example.com/']);
    expect(directive).toContain('https://example.com/');
    expect(directive).toContain('browser_tool');
    expect(directive).toContain('do not answer from the title or url alone');
  });

  it('marks whatever the page returns as untrusted', () => {
    expect(formatBrowserDirective(['https://example.com/'])).toContain('untrusted');
  });

  it('never inlines page body text', () => {
    // The directive is the whole contract: if body text ever starts riding
    // along here, the read stops being a visible, permissioned action.
    const directive = formatBrowserDirective(['https://example.com/']);
    expect(directive.length).toBeLessThan(500);
  });

  it('pluralizes for several pages', () => {
    const directive = formatBrowserDirective(['https://a.dev/', 'https://b.dev/']);
    expect(directive).toContain('these pages');
    expect(directive).toContain('https://a.dev/, https://b.dev/');
  });
});
