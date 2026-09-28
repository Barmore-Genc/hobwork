import { expect, test } from 'vitest'
import { imageDir } from './image.ts'

test('defaults to the build output for the host architecture', () => {
  expect(imageDir({})).toMatch(/\/images\/build\/(aarch64|x86_64)$/)
})

test('HOBWORK_IMAGE_DIR overrides it', () => {
  expect(imageDir({ HOBWORK_IMAGE_DIR: '/srv/hobwork-image' })).toBe('/srv/hobwork-image')
})
