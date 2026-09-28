import { join } from 'node:path'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { openHostDb } from './db.ts'

const config = loadConfig()
const db = openHostDb(join(config.dataDir, 'hobwork.db'))
const server = createApp(db)

server.listen(config.port, config.host, () => {
  console.log(`hobwork host listening on http://${config.host}:${config.port}`)
})

function shutdown() {
  server.close(() => {
    db.close()
    process.exit(0)
  })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
