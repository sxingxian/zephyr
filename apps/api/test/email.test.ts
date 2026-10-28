import { describe, expect, it } from 'vitest';
import { escapeHtml, oneLine } from '../src/email/escape';
import { inviteEmail } from '../src/email/templates';

const base = {
  link: 'https://zephyrapp.midnightpoetry.studio/join#t=abc',
  expiresAt: '2026-11-04T00:00:00Z',
};

describe('invite email', () => {
  it('escapes the inviter name and note everywhere in the HTML', () => {
    const m = inviteEmail({
      ...base,
      inviterName: '<img src=x onerror=alert(1)>',
      note: '"quoted" & <script>alert(1)</script>',
    });
    expect(m.html).not.toMatch(/<img|<script|onerror=alert\(1\)>/);
    expect(m.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(m.html).toContain('&quot;quoted&quot; &amp; &lt;script&gt;');
  });

  it('keeps subjects to one line (no header injection) and caps their length', () => {
    const m = inviteEmail({ ...base, inviterName: 'Mei\r\nBcc: victim@example.com', note: null });
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(inviteEmail({ ...base, inviterName: 'x'.repeat(500), note: null }).subject.length).toBeLessThan(
      120,
    );
  });

  it('names the Zephyr team when there is no inviter, and states single use and expiry', () => {
    const m = inviteEmail({ ...base, inviterName: null, note: null });
    expect(m.subject).toBe('You’re invited to Zephyr');
    expect(m.text).toContain('The Zephyr team invited you');
    expect(m.text).toContain('https://zephyrapp.midnightpoetry.studio/join#t=abc');
    expect(m.text).toContain('4 November 2026');
    expect(m.html).toContain('href="https://zephyrapp.midnightpoetry.studio/join#t=abc"');
  });

  it('escape helpers', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
    expect(oneLine('a\nb\u0000c')).toBe('a b c');
  });
});
