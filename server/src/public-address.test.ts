import { expect, test } from 'vitest'
import { hostNetworks, ipv6Hextets, isPublicAddress, prefixBlockList } from './public-address.ts'

test.each([
  '10.1.2.3',
  '127.0.0.1',
  '169.254.169.254',
  '192.168.1.1',
  '100.64.0.1',
  '224.0.0.1',
  '255.255.255.255',
  '::',
  '::1',
  '::2',
  '::10.0.0.1',
  '::ffff:10.0.0.1',
  '::ffff:0a00:0001',
  '64:ff9b::10.0.0.1',
  '64:ff9b::a00:1',
  '64:ff9b::7f00:1',
  '64:ff9b:1::1',
  '64:ff9b:1:0:0:0:a00:1',
  '2002:0a00:0001::1',
  '2002:c0a8:0101::',
  '2002:7f00:1::',
  '2001::1',
  '2001:db8::1',
  'fc00::1',
  'fd12:3456::1',
  'fe80::1',
  'fe80::1%en0',
  'fec0::1',
  'ff02::1',
  'not an address',
])('%s is not public', (address) => {
  expect(isPublicAddress(address)).toBe(false)
})

test.each([
  '8.8.8.8',
  '1.1.1.1',
  '93.184.216.34',
  '::ffff:8.8.8.8',
  '64:ff9b::8.8.8.8',
  '64:ff9b::808:808',
  '2002:0808:0808::1',
  '2606:4700:4700::1111',
  '2a00:1450:4001:81b::200e',
])('%s is public', (address) => {
  expect(isPublicAddress(address)).toBe(true)
})

test('refuses the host network prefixes', () => {
  const extraBlocked = prefixBlockList([
    { address: '2a01:4f8:1:2::5', prefix: 64 },
    { address: '203.1.2.10', prefix: 24 },
  ])
  expect(isPublicAddress('2a01:4f8:1:2::99', { extraBlocked })).toBe(false)
  expect(isPublicAddress('2a01:4f8:1:3::99', { extraBlocked })).toBe(true)
  expect(isPublicAddress('203.1.2.77', { extraBlocked })).toBe(false)
  expect(isPublicAddress('64:ff9b::cb01:24d', { extraBlocked })).toBe(false)
  expect(isPublicAddress('203.1.3.77', { extraBlocked })).toBe(true)
})

test('reads prefixes from interfaces', () => {
  const networks = hostNetworks({
    en0: [
      { address: '2a01:4f8:1:2::5', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '', internal: false, cidr: '2a01:4f8:1:2::5/64', scopeid: 0 },
    ],
  })
  expect(networks).toEqual([{ address: '2a01:4f8:1:2::5', prefix: 64 }])
})

test('parses IPv6 hextets', () => {
  expect(ipv6Hextets('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
  expect(ipv6Hextets('64:ff9b::1.2.3.4')).toEqual([0x64, 0xff9b, 0, 0, 0, 0, 0x102, 0x304])
  expect(ipv6Hextets('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  expect(ipv6Hextets('1.2.3.4')).toBeUndefined()
})
