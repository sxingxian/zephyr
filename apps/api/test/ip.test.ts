import { describe, expect, it } from 'vitest';
import { networkKey } from '../src/ip';

describe('networkKey', () => {
  it('keeps IPv4 addresses as they are', () => {
    expect(networkKey('203.0.113.7')).toBe('203.0.113.7');
    expect(networkKey(' 0.0.0.0 ')).toBe('0.0.0.0');
    expect(networkKey('255.255.255.255')).toBe('255.255.255.255');
  });

  it('truncates IPv6 to its /64, whatever the notation', () => {
    const want = '2001:db8:1:2::/64';
    expect(networkKey('2001:db8:1:2::1')).toBe(want);
    expect(networkKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe(want);
    expect(networkKey('2001:0DB8:0001:0002:0000:0000:0000:0001')).toBe(want);
    expect(networkKey('[2001:db8:1:2::ffff]')).toBe(want);
    expect(networkKey('2001:db8:1:2::1%eth0')).toBe(want);
    expect(networkKey('2001:db8:1:3::1')).not.toBe(want);
  });

  it('widens IPv6 to its /48 on request, leaving IPv4 as it is', () => {
    expect(networkKey('2001:db8:1:2::1', 48)).toBe('2001:db8:1::/48');
    expect(networkKey('2001:db8:1:ffff:1:2:3:4', 48)).toBe('2001:db8:1::/48');
    expect(networkKey('2001:db8:2:2::1', 48)).not.toBe('2001:db8:1::/48');
    expect(networkKey('203.0.113.7', 48)).toBe('203.0.113.7');
    expect(networkKey('::ffff:203.0.113.7', 48)).toBe('203.0.113.7');
    expect(networkKey('nope', 48)).toBeNull();
  });

  it('handles :: at the start, middle and end', () => {
    expect(networkKey('::1')).toBe('0:0:0:0::/64');
    expect(networkKey('::')).toBe('0:0:0:0::/64');
    expect(networkKey('2001:db8::')).toBe('2001:db8:0:0::/64');
    expect(networkKey('2001::5:6:7:8')).toBe('2001:0:0:0::/64');
    expect(networkKey('fe80::1:2:3:4')).toBe('fe80:0:0:0::/64');
  });

  it('maps IPv4-mapped IPv6 back to IPv4', () => {
    expect(networkKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(networkKey('::FFFF:cb00:7107')).toBe('203.0.113.7');
    expect(networkKey('0:0:0:0:0:ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('treats other embedded-IPv4 forms as IPv6', () => {
    expect(networkKey('64:ff9b::203.0.113.7')).toBe('64:ff9b:0:0::/64');
  });

  it('rejects anything that is not an IP', () => {
    for (const bad of [
      null,
      undefined,
      '',
      'unknown',
      '1.2.3',
      '1.2.3.4.5',
      '256.1.1.1',
      '01.2.3.4',
      '1.2.3.-4',
      '2001:db8::1::2',
      '2001:db8:1:2:3:4:5:6:7',
      '2001:db8:1:2:3:4:5',
      '1:2:3:4:5:6:7::8',
      '12345::1',
      'g::1',
      '1.2.3.4::',
      '::1.2.3',
    ]) {
      expect(networkKey(bad)).toBeNull();
    }
  });
});
