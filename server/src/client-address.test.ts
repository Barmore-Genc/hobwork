import type { IncomingMessage } from 'node:http'
import { expect, test } from 'vitest'
import { clientAddress, normalizeAddress, parseTrustedProxies } from './client-address.ts'
import { loadConfig } from './config.ts'

function request(remoteAddress: string | undefined, forwardedFor?: string | string[]): IncomingMessage {
  return {
    socket: { remoteAddress },
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
  } as unknown as IncomingMessage
}

const proxies = parseTrustedProxies('10.0.0.0/8, 192.168.1.5, fd00::/8, ::1')

test('without trusted proxies the socket address is the client', () => {
  const none = parseTrustedProxies('')
  expect(clientAddress(request('203.0.113.9', '198.51.100.1'), none)).toBe('203.0.113.9')
  expect(clientAddress(request('::ffff:127.0.0.1', '198.51.100.1'), none)).toBe('127.0.0.1')
  expect(clientAddress(request(undefined), none)).toBeUndefined()
})

test('a spoofed header from an untrusted socket is ignored', () => {
  expect(clientAddress(request('203.0.113.9', '198.51.100.1'), proxies)).toBe('203.0.113.9')
})

test('a trusted proxy names the client', () => {
  expect(clientAddress(request('10.1.2.3', '198.51.100.1'), proxies)).toBe('198.51.100.1')
  expect(clientAddress(request('192.168.1.5', ' 198.51.100.1 '), proxies)).toBe('198.51.100.1')
  expect(clientAddress(request('192.168.1.6', '198.51.100.1'), proxies)).toBe('192.168.1.6')
})

test('walks a chain of proxies from the right and stops at the first untrusted entry', () => {
  expect(clientAddress(request('10.0.0.1', 'spoofed, 198.51.100.1, 10.0.0.2, 192.168.1.5'), proxies)).toBe('198.51.100.1')
  expect(clientAddress(request('10.0.0.1', ['1.1.1.1, 198.51.100.1', '10.0.0.2']), proxies)).toBe('198.51.100.1')
  expect(clientAddress(request('10.0.0.1', '1.1.1.1, 2.2.2.2'), proxies)).toBe('2.2.2.2')
})

test('uses the leftmost entry when the whole chain is trusted', () => {
  expect(clientAddress(request('10.0.0.1', '10.9.9.9, 192.168.1.5'), proxies)).toBe('10.9.9.9')
})

test('falls back to the socket address without a usable header', () => {
  expect(clientAddress(request('10.0.0.1'), proxies)).toBe('10.0.0.1')
  expect(clientAddress(request('10.0.0.1', ''), proxies)).toBe('10.0.0.1')
  expect(clientAddress(request('10.0.0.1', ' , '), proxies)).toBe('10.0.0.1')
  expect(clientAddress(request('10.0.0.1', '198.51.100.1, not-an-ip'), proxies)).toBe('10.0.0.1')
  expect(clientAddress(request('10.0.0.1', '198.51.100.1, 1.2.3.4.5'), proxies)).toBe('10.0.0.1')
  expect(clientAddress(request('10.0.0.1', 'unknown'), proxies)).toBe('10.0.0.1')
  expect(clientAddress(request('10.0.0.1', '"[2001:db8::1]"'), proxies)).toBe('10.0.0.1')
})

test('an untrusted entry left of a malformed one is not used', () => {
  expect(clientAddress(request('10.0.0.1', '198.51.100.1, garbage, 10.0.0.2'), proxies)).toBe('10.0.0.1')
})

test('IPv6 proxies and clients', () => {
  expect(clientAddress(request('fd12::1', '2001:db8::1'), proxies)).toBe('2001:db8::1')
  expect(clientAddress(request('::1', '2001:DB8:0:0::1, fd00::5'), proxies)).toBe('2001:db8::1')
  expect(clientAddress(request('fd12::1', '[2001:db8::1]:4711'), proxies)).toBe('2001:db8::1')
  expect(clientAddress(request('2001:db8::2', '198.51.100.1'), proxies)).toBe('2001:db8::2')
})

test('IPv4-mapped IPv6 addresses count as IPv4', () => {
  expect(clientAddress(request('::ffff:10.0.0.1', '::ffff:198.51.100.1'), proxies)).toBe('198.51.100.1')
  expect(clientAddress(request('::ffff:a00:1', '198.51.100.1:5000'), proxies)).toBe('198.51.100.1')
  expect(clientAddress(request('::ffff:10.0.0.1', '10.0.0.3, ::ffff:192.168.1.5'), proxies)).toBe('10.0.0.3')
  const mapped = parseTrustedProxies('::ffff:127.0.0.1, ::ffff:172.16.0.0/108')
  expect(clientAddress(request('127.0.0.1', '198.51.100.1'), mapped)).toBe('198.51.100.1')
  expect(clientAddress(request('::ffff:172.20.1.1', '198.51.100.1'), mapped)).toBe('198.51.100.1')
  expect(clientAddress(request('172.32.0.1', '198.51.100.1'), mapped)).toBe('172.32.0.1')
})

test('CIDR ranges match their whole range and nothing else', () => {
  const list = parseTrustedProxies('172.16.0.0/12,2001:db8:1::/48')
  expect(clientAddress(request('172.31.255.255', '198.51.100.1'), list)).toBe('198.51.100.1')
  expect(clientAddress(request('172.32.0.0', '198.51.100.1'), list)).toBe('172.32.0.0')
  expect(clientAddress(request('2001:db8:1:ffff::1', '198.51.100.1'), list)).toBe('198.51.100.1')
  expect(clientAddress(request('2001:db8:2::1', '198.51.100.1'), list)).toBe('2001:db8:2::1')
})

test('normalizes addresses', () => {
  expect(normalizeAddress('::FFFF:7F00:1')).toBe('127.0.0.1')
  expect(normalizeAddress('0:0:0:0:0:ffff:1.2.3.4')).toBe('1.2.3.4')
  expect(normalizeAddress('[::1]')).toBe('::1')
  expect(normalizeAddress('fe80::1%eth0')).toBeUndefined()
  expect(normalizeAddress('1.2.3.4:99999')).toBeUndefined()
  expect(normalizeAddress('example.com')).toBeUndefined()
})

test('refuses invalid entries', () => {
  for (const entry of ['example.com', '10.0.0.0/33', '10.0.0.0/', '10.0.0.0/8/8', 'fd00::/129', '1.2.3.4:80', '[::1]', '::ffff:10.0.0.0/8', '10.0.0.0/-1']) {
    expect(() => parseTrustedProxies(entry), entry).toThrow('HOBWORK_TRUSTED_PROXIES')
  }
  expect(() => loadConfig({ HOBWORK_TRUSTED_PROXIES: '10.0.0.1, nope' })).toThrow('got "nope"')
})
