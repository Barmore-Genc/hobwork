import type { Handler } from '@hobwork/sdk'
import { greeting } from './greeting.ts'

export default (async (ctx) => {
  ctx.log.info(greeting(new Date()))
}) satisfies Handler
