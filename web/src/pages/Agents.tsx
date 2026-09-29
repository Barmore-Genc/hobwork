import { useState, type FormEvent } from 'react'
import { api, ApiError, type AgentToken, type CreatedToken } from '../api.ts'
import { exactTime, shortDate, timeAgo } from '../format.ts'
import { Button, ConfirmDialog, Notice, PageHeading } from '../ui.tsx'
import { useLoad } from '../useLoad.ts'

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err)
}

function NewKey({ created, onDone }: { created: CreatedToken; onDone: () => void }) {
  const [copied, setCopied] = useState(false)
  const command = `claude mcp add --transport http hobwork ${window.location.origin}/mcp --header "Authorization: Bearer ${created.token}"`

  async function copy(text: string) {
    await navigator.clipboard.writeText(text)
    setCopied(true)
  }

  return (
    <section
      aria-labelledby="new-key"
      className="rounded-lg border-2 border-accent bg-surface-raised p-5 sm:p-6"
    >
      <h2 id="new-key" className="text-xl font-semibold">
        New key for {created.agent.name}
      </h2>
      <p className="mt-2 text-muted">Copy it now. Hobwork shows it only once. If it gets lost, create another key.</p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-stretch">
        <code className="min-w-0 flex-1 rounded-md border border-border bg-bg px-3 py-2.5 font-mono text-sm break-all select-all">
          {created.token}
        </code>
        <Button variant="primary" onClick={() => copy(created.token)}>
          {copied ? 'Copied' : 'Copy key'}
        </Button>
      </div>
      <details className="mt-5 text-sm">
        <summary className="cursor-pointer text-muted hover:text-fg">Connect Claude Code with this key</summary>
        <p className="mt-2 text-muted">Run this in a terminal:</p>
        <code className="mt-2 block rounded-md border border-border bg-bg px-3 py-2.5 font-mono text-[0.8rem] break-all">
          {command}
        </code>
        <Button className="mt-3" onClick={() => copy(command)}>
          Copy command
        </Button>
      </details>
      <div className="mt-6 border-t border-border pt-4">
        <Button variant="quiet" onClick={onDone}>
          I saved the key
        </Button>
      </div>
    </section>
  )
}

function KeyRow({ token, onRevoke }: { token: AgentToken; onRevoke: (token: AgentToken) => void }) {
  const revoked = token.revokedAt !== null
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
      <div className={revoked ? 'text-muted' : ''}>
        <p>
          Key created <span title={exactTime(token.createdAt)}>{shortDate(token.createdAt)}</span>
        </p>
        <p className="text-sm text-muted">
          {revoked ? (
            <>Revoked {timeAgo(token.revokedAt!)}</>
          ) : token.lastUsedAt ? (
            <span title={exactTime(token.lastUsedAt)}>Last used {timeAgo(token.lastUsedAt)}</span>
          ) : (
            'Not used yet'
          )}
        </p>
      </div>
      {!revoked && (
        <Button variant="quiet-danger" onClick={() => onRevoke(token)}>
          Revoke
        </Button>
      )}
    </li>
  )
}

export function AgentsPage() {
  const { data: agents, error, reload } = useLoad(api.agents)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [created, setCreated] = useState<CreatedToken | null>(null)
  const [revoking, setRevoking] = useState<{ token: AgentToken; agent: string } | null>(null)
  const [revokeBusy, setRevokeBusy] = useState(false)
  const [revokeError, setRevokeError] = useState<string | null>(null)

  async function create(event: FormEvent) {
    event.preventDefault()
    setCreating(true)
    setCreateError(null)
    try {
      setCreated(await api.createAgent(name))
      setName('')
      reload()
    } catch (err) {
      setCreateError(message(err))
    } finally {
      setCreating(false)
    }
  }

  async function newKey(agentId: number) {
    try {
      setCreated(await api.createToken(agentId))
      reload()
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (err) {
      setCreateError(message(err))
    }
  }

  async function revoke() {
    if (!revoking) return
    setRevokeBusy(true)
    setRevokeError(null)
    try {
      await api.revokeToken(revoking.token.id)
      setRevoking(null)
      reload()
    } catch (err) {
      setRevokeError(message(err))
    } finally {
      setRevokeBusy(false)
    }
  }

  return (
    <div>
      <PageHeading>Agent access</PageHeading>
      <p className="mt-3 max-w-prose text-muted">
        Agents such as Claude Code use a key to build and change projects. A key works for every project, so revoke
        keys you no longer use.
      </p>

      <div className="mt-10 space-y-10">
        {created ? (
          <NewKey created={created} onDone={() => setCreated(null)} />
        ) : (
          <form onSubmit={create} className="rounded-lg border border-border bg-surface p-5 sm:p-6">
            <label htmlFor="agent-name" className="text-lg font-semibold font-display">
              Give an agent access
            </label>
            <p className="mt-1 text-sm text-muted">Name it after where it runs, so you recognize it later.</p>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row">
              <input
                id="agent-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Claude Code on the laptop"
                maxLength={64}
                required
                className="min-h-10 flex-1 rounded-md border border-border bg-surface-raised px-3 text-fg placeholder:text-muted/70 focus:border-accent focus:outline-none"
              />
              <Button type="submit" variant="primary" disabled={creating || !name.trim()}>
                {creating ? 'Creating…' : 'Create key'}
              </Button>
            </div>
            {createError && (
              <div className="mt-4">
                <Notice tone="error">{createError}</Notice>
              </div>
            )}
          </form>
        )}

        {error && <Notice tone="error">{error}</Notice>}

        {agents && agents.length === 0 && <p className="text-muted">No agent has access yet.</p>}

        {agents && agents.length > 0 && (
          <ul className="space-y-8">
            {agents.map((agent) => {
              const active = agent.tokens.filter((t) => t.revokedAt === null).length
              return (
                <li key={agent.id} className="border-t border-border pt-6">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
                    <div>
                      <h2 className="text-xl font-semibold break-words">{agent.name}</h2>
                      <p className="text-sm text-muted">
                        {active === 0 ? 'No working keys' : active === 1 ? '1 working key' : `${active} working keys`}
                      </p>
                    </div>
                    <Button onClick={() => newKey(agent.id)}>New key</Button>
                  </div>
                  {agent.tokens.length > 0 && (
                    <ul className="mt-3 divide-y divide-border">
                      {agent.tokens.map((token) => (
                        <KeyRow
                          key={token.id}
                          token={token}
                          onRevoke={(t) => {
                            setRevokeError(null)
                            setRevoking({ token: t, agent: agent.name })
                          }}
                        />
                      ))}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={revoking !== null}
        title="Revoke this key?"
        confirmLabel="Revoke key"
        variant="danger"
        busy={revokeBusy}
        error={revokeError}
        onConfirm={revoke}
        onCancel={() => setRevoking(null)}
      >
        <p>
          {revoking?.agent} loses access through this key right away. This cannot be undone, but you can create a new
          key later.
        </p>
      </ConfirmDialog>
    </div>
  )
}
