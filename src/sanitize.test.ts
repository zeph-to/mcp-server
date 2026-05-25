import { describe, expect, it } from 'vitest';
import { sanitizeText, recoverActions } from './sanitize.js';

// The exact malformed zeph_ask body observed in the wild: the actions
// JSON leaked into the body because the `body` parameter was mis-closed.
const LEAKED_BODY = `# Tab back-gesture fix applied. Verify?

One-line change: AppShell.tsx NavLink + \`replace\`. Lint clean.

Commit now or test first?</body>
<parameter name="actions">[{"id":"commit","label":"Commit","style":"primary"},{"id":"test_first","label":"Test first"},{"id":"done","label":"Done"}]`;

describe('sanitizeText', () => {
  it('returns clean text unchanged', () => {
    expect(sanitizeText('Build finished — all tests green.')).toBe('Build finished — all tests green.');
  });

  it('passes undefined through', () => {
    expect(sanitizeText(undefined)).toBeUndefined();
  });

  it('cuts the leaked body at </body>, dropping the leaked markup', () => {
    const cleaned = sanitizeText(LEAKED_BODY);
    expect(cleaned?.endsWith('Commit now or test first?')).toBe(true);
    expect(cleaned).not.toContain('</body>');
    expect(cleaned).not.toContain('<parameter');
  });

  it('cuts at a bare <parameter name= marker', () => {
    expect(sanitizeText('Done.<parameter name="actions">[]')).toBe('Done.');
  });

  it('trims trailing whitespace left before the cut', () => {
    expect(sanitizeText('Done.   </body>')).toBe('Done.');
  });
});

describe('recoverActions', () => {
  it('recovers the actions array that leaked into the body', () => {
    const actions = recoverActions(LEAKED_BODY);
    expect(actions).toEqual([
      { id: 'commit', label: 'Commit', style: 'primary' },
      { id: 'test_first', label: 'Test first' },
      { id: 'done', label: 'Done' },
    ]);
  });

  it('returns undefined when there is no leaked actions markup', () => {
    expect(recoverActions('Just a normal body, no leak.')).toBeUndefined();
  });

  it('returns undefined when the leaked segment is not valid JSON', () => {
    expect(recoverActions('body</body><parameter name="actions">[not json')).toBeUndefined();
  });

  it('rejects a parsed array whose items lack id/label', () => {
    expect(recoverActions('x<parameter name="actions">[{"foo":1}]')).toBeUndefined();
  });
});
