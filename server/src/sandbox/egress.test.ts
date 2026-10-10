import { expect, test } from 'vitest'
import {
  describeEgress,
  egressAllows,
  egressHosts,
  egressRules,
  hostMatches,
  parseEgressEntry,
  parsePrivateEgress,
  privateEgressAllows,
} from './egress.ts'

test.each([
  ['api.example.com', ['api.example.com'], true],
  ['API.Example.com', ['api.example.com'], true],
  ['a.api.example.com', ['*.example.com'], true],
  ['example.com', ['*.example.com'], false],
  ['evil-example.com', ['example.com'], false],
  ['example.com.evil.net', ['example.com'], false],
  ['anything.test', ['*'], true],
  ['anything.test', [], false],
  ['anything.test', [' '], false],
])('%s against %o is %s', (hostname, patterns, expected) => {
  expect(hostMatches(hostname, patterns)).toBe(expected)
})

test.each([
  ['api.example.com', { host: 'api.example.com' }],
  ['*.Example.com:8443', { host: '*.example.com', port: 8443 }],
  ['100.66.127.125:7912', { host: '100.66.127.125', port: 7912 }],
  ['[fd00::5]:80', { host: 'fd00::5', port: 80 }],
  ['[fd00::5]', { host: 'fd00::5' }],
  ['fd00::5', { host: 'fd00::5' }],
  ['example.com:0', undefined],
  ['example.com:70000', undefined],
  ['example.com:http', undefined],
  [':80', undefined],
])('egress entry %s', (entry, rule) => {
  expect(parseEgressEntry(entry)).toEqual(rule)
})

test('a port in an egress entry restricts it to that port', () => {
  const rules = egressRules(['api.example.com', '100.66.127.125:7912', '[fd00::5]:80'])
  expect(egressHosts(rules)).toEqual(['api.example.com', '100.66.127.125', 'fd00::5'])
  expect(egressAllows(rules, 'api.example.com', 8080)).toBe(true)
  expect(egressAllows(rules, '100.66.127.125', 7912)).toBe(true)
  expect(egressAllows(rules, '100.66.127.125', 22)).toBe(false)
  expect(egressAllows(rules, '[fd00::5]', 80)).toBe(true)
  expect(egressAllows(rules, 'other.example.com', 443)).toBe(false)
})

test('the host setting lists private targets by host, address or network, each with a port', () => {
  const rules = parsePrivateEgress(' 100.66.127.125:7912, 192.168.1.0/24:8123 ,nas.lan:5000,[fd00::5]:80,fd00:1::/64:443')
  expect(rules).toEqual([
    { host: '100.66.127.125', port: 7912 },
    { network: '192.168.1.0', prefix: 24, port: 8123 },
    { host: 'nas.lan', port: 5000 },
    { host: 'fd00::5', port: 80 },
    { network: 'fd00:1::', prefix: 64, port: 443 },
  ])
  const allows = (hostname: string, ip: string, port: number) => privateEgressAllows(rules, { hostname, ip, port })
  expect(allows('100.66.127.125', '100.66.127.125', 7912)).toBe(true)
  expect(allows('100.66.127.125', '100.66.127.125', 22)).toBe(false)
  expect(allows('100.66.127.126', '100.66.127.126', 7912)).toBe(false)
  expect(allows('ha.lan', '192.168.1.20', 8123)).toBe(true)
  expect(allows('ha.lan', '192.168.2.20', 8123)).toBe(false)
  expect(allows('nas.lan', '10.0.0.4', 5000)).toBe(true)
  expect(allows('other.lan', '10.0.0.4', 5000)).toBe(false)
  expect(allows('[fd00::5]', 'fd00::5', 80)).toBe(true)
  expect(allows('x', 'fd00:1::9', 443)).toBe(true)
  // A listed name that resolves to loopback still cannot reach the host's own services.
  expect(allows('nas.lan', '127.0.0.1', 5000)).toBe(false)
  expect(allows('nas.lan', '::ffff:127.0.0.1', 5000)).toBe(false)
  expect(parsePrivateEgress(undefined)).toEqual([])
})

test.each([
  ['100.66.127.125', 'needs a host or network and a port'],
  ['10.0.0.0/33:80', 'is not a network'],
  ['127.0.0.1:7420', 'loopback'],
  ['0.0.0.0/1:80', 'loopback'],
  ['0.0.0.0/0:80', 'is not a network'],
  ['[::1]:80', 'loopback'],
  ['bad host:80', 'is not a host name or address'],
])('refuses %s in the host setting', (value, message) => {
  expect(() => parsePrivateEgress(value)).toThrow(message)
})

test('describes which egress entries are private and whether the host allows them', () => {
  const rules = parsePrivateEgress('100.66.127.125:7912,nas.lan:5000')
  const entries = ['api.example.com', '100.66.127.125:7912', '100.66.127.125:22', '192.168.1.5', 'nas.lan', '127.0.0.1:80']
  expect(entries.map((entry) => describeEgress(entry, rules))).toEqual([
    { target: 'api.example.com', private: false, allowed: true },
    { target: '100.66.127.125:7912', private: true, allowed: true },
    { target: '100.66.127.125:22', private: true, allowed: false },
    { target: '192.168.1.5', private: true, allowed: false },
    { target: 'nas.lan', private: true, allowed: true },
    { target: '127.0.0.1:80', private: true, allowed: false },
  ])
})
