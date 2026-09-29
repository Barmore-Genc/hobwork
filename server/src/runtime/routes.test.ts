import { expect, test } from 'vitest'
import { matchRoute, parseRoutes } from './routes.ts'

const routes = parseRoutes({
  'GET /spools': { handler: 'src/spools.ts' },
  'GET /spools/:id': { handler: 'src/spool.ts' },
  'GET /spools/empty': { handler: 'src/empty.ts' },
  'POST /spools': { handler: 'src/add.ts' },
  'GET /': { handler: 'src/root.ts' },
})

function handlerFor(method: string, path: string) {
  const match = matchRoute(routes, method, path)
  return match && 'route' in match ? { handler: match.route.handler, params: match.params } : match
}

test('matches method and path', () => {
  expect(handlerFor('GET', '/spools')).toEqual({ handler: 'src/spools.ts', params: {} })
  expect(handlerFor('post', '/spools/')).toEqual({ handler: 'src/add.ts', params: {} })
  expect(handlerFor('GET', '/')).toEqual({ handler: 'src/root.ts', params: {} })
  expect(handlerFor('HEAD', '/spools')).toEqual({ handler: 'src/spools.ts', params: {} })
})

test('passes decoded parameters, and static segments win', () => {
  expect(handlerFor('GET', '/spools/a%20b')).toEqual({ handler: 'src/spool.ts', params: { id: 'a b' } })
  expect(handlerFor('GET', '/spools/empty')).toEqual({ handler: 'src/empty.ts', params: {} })
})

test('reports unknown paths and wrong methods', () => {
  expect(handlerFor('GET', '/spools/1/extra')).toBeUndefined()
  expect(handlerFor('DELETE', '/spools')).toEqual({ methodNotAllowed: ['GET', 'POST'] })
  expect(handlerFor('GET', '/spools/%E0%A4%A')).toBeUndefined()
})
