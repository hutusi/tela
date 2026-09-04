import { describe, expect, test } from 'bun:test'
import { isBlockedHost, isPrivateAddress, parseIp } from '../src/net'

describe('parseIp', () => {
  test('parses the forms URL.hostname produces, and rejects the rest', () => {
    expect(parseIp('127.0.0.1')).toEqual({ family: 4, bytes: new Uint8Array([127, 0, 0, 1]) })
    expect(parseIp('[::1]')?.bytes.at(-1)).toBe(1)
    expect(parseIp('fe80::1%en0')?.family).toBe(6)
    expect(parseIp('::ffff:10.0.0.1')?.bytes.subarray(10)).toEqual(
      new Uint8Array([0xff, 0xff, 10, 0, 0, 1]),
    )
    expect(parseIp('2606:4700::1111')?.bytes.subarray(0, 4)).toEqual(
      new Uint8Array([0x26, 0x06, 0x47, 0x00]),
    )
    for (const bad of ['blog.example', '1.2.3', '256.1.1.1', '1:2:3', ':::', '1::2::3', '']) {
      expect({ bad, parsed: parseIp(bad) }).toEqual({ bad, parsed: null })
    }
  })
})

describe('isPrivateAddress', () => {
  test('blocks every non-public range, including the IPv6 forms the old regex missed', () => {
    const blocked = [
      '127.0.0.1',
      '10.0.0.1',
      '100.64.0.1',
      '169.254.169.254',
      '172.16.5.5',
      '192.168.1.1',
      '192.0.0.8',
      '198.18.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      '[::1]',
      'fdaa:0:1::3',
      'fc00::1',
      'fe80::1',
      'fec0::1',
      'ff02::1',
      '[::ffff:127.0.0.1]',
      '::ffff:10.0.0.1',
      '::ffff:a9fe:a9fe',
      '64:ff9b::7f00:1',
      '64:ff9b:1::1',
      '2002:7f00:1::',
      '2001::1',
      '2001:db8::1',
      'not-an-ip',
    ]
    for (const ip of blocked)
      expect({ ip, private: isPrivateAddress(ip) }).toEqual({ ip, private: true })
    const allowed = [
      '8.8.8.8',
      '1.1.1.1',
      '93.184.216.34',
      '2606:4700::1111',
      '64:ff9b::808:808',
      '2002:808:808::',
    ]
    for (const ip of allowed)
      expect({ ip, private: isPrivateAddress(ip) }).toEqual({ ip, private: false })
  })
})

describe('isBlockedHost', () => {
  test('refuses local names and private literals, allows public hosts', () => {
    const blocked = [
      'localhost',
      'LOCALHOST',
      'foo.localhost',
      'printer.local',
      'metadata.google.internal',
      'router.home.arpa',
      '10.1.2.3',
      '100.64.1.1',
      '169.254.169.254',
      '[::1]',
      '[fdaa::1]',
      '[::ffff:127.0.0.1]',
      '999.1.1.1',
    ]
    for (const host of blocked)
      expect({ host, blocked: isBlockedHost(host) }).toEqual({ host, blocked: true })
    const allowed = [
      'blog.example',
      'example.com.',
      '8.8.8.8',
      '[2606:4700::1111]',
      'localhost.example.com',
    ]
    for (const host of allowed)
      expect({ host, blocked: isBlockedHost(host) }).toEqual({ host, blocked: false })
  })
})
