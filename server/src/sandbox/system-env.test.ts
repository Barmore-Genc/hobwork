import { expect, test } from 'vitest'
import { systemEnv } from './system-env.ts'

test('passes the time zone and locale variables and nothing else', () => {
  expect(systemEnv({
    TZ: 'Europe/Istanbul',
    LANG: 'tr_TR.UTF-8',
    LANGUAGE: 'tr:en',
    LC_TIME: 'en_GB.UTF-8',
    LC_ALL: '',
    HOME: '/home/hobwork',
    PATH: '/usr/bin',
    HOBWORK_SECRET_KEY: 'abc',
  }, 'UTC')).toEqual({
    TZ: 'Europe/Istanbul',
    LANG: 'tr_TR.UTF-8',
    LANGUAGE: 'tr:en',
    LC_TIME: 'en_GB.UTF-8',
  })
})

test('uses the resolved time zone when TZ is unset', () => {
  expect(systemEnv({}, 'America/New_York')).toEqual({ TZ: 'America/New_York' })
})
