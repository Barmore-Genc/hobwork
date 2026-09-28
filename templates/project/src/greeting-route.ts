import type { Handler } from '@hobwork/sdk'
import { greeting } from './greeting.ts'

export default (async () => {
  return { message: greeting(new Date()) }
}) satisfies Handler
