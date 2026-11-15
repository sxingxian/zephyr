import { describe, expect, it } from 'vitest';
import { escapeHtml, oneLine } from '../src/email/escape';
import { accountActionEmail, inviteEmail, passkeyChangeEmail } from '../src/email/templates';

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

describe('passkey change notice', () => {
  it('escapes the passkey name and keeps it on one line', () => {
    const m = passkeyChangeEmail({
      change: 'added',
      name: '<img src=x onerror=alert(1)>\r\nBcc: x@example.com',
      where: 'Zephyr',
      at: new Date('2026-10-28T09:30:00Z'),
    });
    expect(m.subject).toBe('A passkey was added to your Zephyr account');
    expect(m.html).not.toContain('<img');
    expect(m.html).toContain('&lt;img');
    expect(m.text).not.toMatch(/\r|\nBcc/);
    expect(m.text).toContain('28 October 2026');
  });
});

describe('account action link email (phase 8)', () => {
  const link = `https://zephyrapp.midnightpoetry.studio/account-action/${'n'.repeat(22)}#t=${'A'.repeat(43)}`;
  it('says what will happen, carries the link only in the body, and says where Zephyr asks', () => {
    const m = accountActionEmail({ op: 'account_delete', link, minutes: 15 });
    expect(m.subject).toBe('Delete your Zephyr account');
    expect(m.subject).not.toContain('A'.repeat(43));
    expect(m.text).toContain(link);
    expect(m.html).toContain(link);
    expect(m.text).toContain('15 minutes');
    expect(m.text).toContain('never inside your library');
    expect(m.text).toContain('Ignore this email and nothing changes');
  });
  it('escapes the passkey name and keeps it to one line', () => {
    const m = accountActionEmail({
      op: 'passkey_remove',
      link,
      minutes: 15,
      passkeyName: '<img src=x onerror=alert(1)>\nWork',
    });
    expect(m.html).not.toContain('<img src=x');
    expect(m.text).toContain('the passkey “');
    expect(accountActionEmail({ op: 'passkey_add', link, minutes: 15 }).text).toContain(
      'the passkey is created there',
    );
  });
});
