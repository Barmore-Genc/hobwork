import { useState, type FormEvent, type ReactNode } from 'react'
import { api, ApiError, type Agent, type AgentToken, type Connection, type CreatedToken, type SshKey } from '../api.ts'
import { exactTime, shortDate, timeAgo } from '../format.ts'
import { Button, ConfirmDialog, Notice, PageHeading } from '../ui.tsx'
import { useLoad } from '../useLoad.ts'

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err)
}

const MCP_URL = `${window.location.origin}/mcp`

function CopyField({ value, label, small = false }: { value: string; label: string; small?: boolean }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
      <code
        className={`min-w-0 flex-1 rounded-md border border-border bg-bg px-3 py-2.5 font-mono break-all select-all ${small ? 'text-[0.8rem]' : 'text-sm'}`}
      >
        {value}
      </code>
      <Button
        onClick={async () => {
          await navigator.clipboard.writeText(value)
          setCopied(true)
        }}
      >
        {copied ? 'Copied' : label}
      </Button>
    </div>
  )
}

function ConnectBySignIn() {
  return (
    <section aria-labelledby="connect" className="rounded-lg border border-border bg-surface p-5 sm:p-6">
      <h2 id="connect" className="text-lg font-semibold font-display">
        Connect an agent
      </h2>
      <p className="mt-1 text-sm text-muted">
        Add Hobwork to the agent with this URL. When it opens Hobwork in your browser, allow access, and it shows up
        below.
      </p>
      <div className="mt-4">
        <CopyField value={MCP_URL} label="Copy URL" />
      </div>
      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <div>
          <h3 className="font-semibold">claude.ai and Claude Desktop</h3>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted">
            <li>Open Settings, then Connectors.</li>
            <li>Choose Add custom connector.</li>
            <li>Paste the URL and leave the OAuth fields empty.</li>
            <li>Choose Connect.</li>
          </ol>
        </div>
        <div className="min-w-0">
          <h3 className="font-semibold">Claude Code</h3>
          <p className="mt-2 text-sm text-muted">Run these in a terminal:</p>
          <div className="mt-2 space-y-2">
            <CopyField value={`claude mcp add --transport http hobwork ${MCP_URL}`} label="Copy" small />
            <CopyField value="claude mcp login hobwork" label="Copy" small />
          </div>
        </div>
      </div>
    </section>
  )
}

function NewKey({ created, onDone }: { created: CreatedToken; onDone: () => void }) {
  const command = `claude mcp add --transport http hobwork ${MCP_URL} --header "Authorization: Bearer ${created.token}"`

  return (
    <section
      aria-labelledby="new-key"
      className="rounded-lg border-2 border-accent bg-surface-raised p-5 sm:p-6"
    >
      <h2 id="new-key" className="text-xl font-semibold">
        New key for {created.agent.name}
      </h2>
      <p className="mt-2 text-muted">Copy it now. Hobwork shows it only once. If it gets lost, create another key.</p>
      <div className="mt-4">
        <CopyField value={created.token} label="Copy key" />
      </div>
      <details className="mt-5 text-sm">
        <summary className="cursor-pointer text-muted hover:text-fg">Connect Claude Code with this key</summary>
        <p className="mt-2 text-muted">Run this in a terminal:</p>
        <div className="mt-2">
          <CopyField value={command} label="Copy command" small />
        </div>
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
        <p className={revoked ? 'line-through' : ''}>
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

function ConnectionRow({ connection, onRevoke }: { connection: Connection; onRevoke: (c: Connection) => void }) {
  const revoked = connection.revokedAt !== null
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
      <div className={revoked ? 'text-muted' : ''}>
        <p className={revoked ? 'line-through' : ''}>
          Signed in through {connection.clientName}
          {connection.connectedBy && <> by {connection.connectedBy}</>}
        </p>
        <p className="text-sm text-muted">
          <span title={exactTime(connection.createdAt)}>Connected {shortDate(connection.createdAt)}</span>
          {' · '}
          {revoked ? (
            <>revoked {timeAgo(connection.revokedAt!)}</>
          ) : connection.lastUsedAt ? (
            <span title={exactTime(connection.lastUsedAt)}>last used {timeAgo(connection.lastUsedAt)}</span>
          ) : (
            'not used yet'
          )}
        </p>
      </div>
      {!revoked && (
        <Button variant="quiet-danger" onClick={() => onRevoke(connection)}>
          Revoke
        </Button>
      )}
    </li>
  )
}

function addedFrom(key: SshKey): string | null {
  const source = key.addedFrom
  if (!source) return null
  switch (source.via) {
    case 'web':
      return source.userName ? `by ${source.userName} on the web` : 'on the web'
    case 'host':
      return 'on the Hobwork host'
    case 'agent':
      if (source.signIn) return `by the agent, signed in through ${source.signIn.clientName}`
      if (source.token) return `by the agent, with the key created ${shortDate(source.token.createdAt)}`
      return 'by the agent'
  }
}

function SshKeyRow({ sshKey, onRevoke }: { sshKey: SshKey; onRevoke: (key: SshKey) => void }) {
  const revoked = sshKey.revokedAt !== null
  const from = addedFrom(sshKey)
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
      <div className={`min-w-0 ${revoked ? 'text-muted' : ''}`}>
        <p className={`break-words ${revoked ? 'line-through' : ''}`}>SSH key “{sshKey.name}”</p>
        <p className="font-mono text-[0.8rem] break-all text-muted">{sshKey.fingerprint}</p>
        <p className="text-sm text-muted">
          <span title={exactTime(sshKey.createdAt)}>Added {shortDate(sshKey.createdAt)}</span>
          {from && <> {from}</>}
          {' · '}
          {revoked ? (
            <>revoked {timeAgo(sshKey.revokedAt!)}</>
          ) : sshKey.lastUsedAt ? (
            <span title={exactTime(sshKey.lastUsedAt)}>last used {timeAgo(sshKey.lastUsedAt)}</span>
          ) : (
            'not used yet'
          )}
        </p>
      </div>
      {!revoked && (
        <Button variant="quiet-danger" onClick={() => onRevoke(sshKey)}>
          Revoke
        </Button>
      )}
    </li>
  )
}

function AddSshKey({ agent, onAdded, onCancel }: { agent: Agent; onAdded: () => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [publicKey, setPublicKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const id = `ssh-key-${agent.id}`

  async function add(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.addSshKey(agent.id, name.trim(), publicKey.trim())
      onAdded()
    } catch (err) {
      setError(message(err))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={add} className="mt-4 rounded-lg border border-border bg-surface p-4 sm:p-5">
      <p className="font-semibold">SSH key for {agent.name}</p>
      <label htmlFor={`${id}-name`} className="mt-3 block text-sm font-semibold">
        Name
      </label>
      <p className="text-sm text-muted">Where the key lives, so you recognize it later.</p>
      <input
        id={`${id}-name`}
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={64}
        required
        placeholder="Claude Code on the laptop"
        className="mt-2 min-h-10 w-full rounded-md border border-border bg-surface-raised px-3 text-fg placeholder:text-muted/70 focus:border-accent focus:outline-none"
      />
      <label htmlFor={id} className="mt-4 block text-sm font-semibold">
        Public key
      </label>
      <p className="text-sm text-muted">
        Paste the contents of the <span className="font-mono">.pub</span> file, such as{' '}
        <span className="font-mono">~/.ssh/id_ed25519.pub</span>.
      </p>
      <textarea
        id={id}
        value={publicKey}
        onChange={(e) => setPublicKey(e.target.value)}
        rows={3}
        required
        spellCheck={false}
        placeholder="ssh-ed25519 AAAA… agent@laptop"
        className="mt-2 w-full rounded-md border border-border bg-surface-raised px-3 py-2 font-mono text-sm text-fg placeholder:text-muted/70 focus:border-accent focus:outline-none"
      />
      {error && (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      <div className="mt-3 flex flex-wrap justify-end gap-3">
        <Button variant="quiet" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !name.trim() || !publicKey.trim()}>
          {busy ? 'Adding…' : 'Add SSH key'}
        </Button>
      </div>
    </form>
  )
}

function accessSummary(agent: Agent): string {
  const keys = agent.tokens.filter((t) => t.revokedAt === null).length
  const apps = agent.connections.filter((c) => c.revokedAt === null).length
  const ssh = agent.sshKeys.filter((k) => k.revokedAt === null).length
  const parts = [
    ...(keys ? [keys === 1 ? '1 working key' : `${keys} working keys`] : []),
    ...(apps ? [apps === 1 ? '1 working sign-in' : `${apps} working sign-ins`] : []),
    ...(ssh ? [ssh === 1 ? '1 SSH key' : `${ssh} SSH keys`] : []),
  ]
  return parts.length ? parts.join(', ') : 'No working access'
}

// What the confirmation dialog asks about before it takes access away.
type Removal = { title: string; confirmLabel: string; body: ReactNode; run: () => Promise<void> }

export function AgentsPage() {
  const { data: agents, error, reload } = useLoad(api.agents)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [created, setCreated] = useState<CreatedToken | null>(null)
  const [removal, setRemoval] = useState<Removal | null>(null)
  const [removeBusy, setRemoveBusy] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [addingSshKey, setAddingSshKey] = useState<number | null>(null)
  const [revokedShown, setRevokedShown] = useState<Set<number>>(new Set())

  function toggleRevoked(agentId: number) {
    setRevokedShown((shown) => {
      const next = new Set(shown)
      if (!next.delete(agentId)) next.add(agentId)
      return next
    })
  }

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

  function confirm(next: Removal) {
    setRemoveError(null)
    setRemoval(next)
  }

  async function remove() {
    if (!removal) return
    setRemoveBusy(true)
    setRemoveError(null)
    try {
      await removal.run()
      setRemoval(null)
      reload()
    } catch (err) {
      setRemoveError(message(err))
    } finally {
      setRemoveBusy(false)
    }
  }

  const revokeToken = (agent: Agent, token: AgentToken) =>
    confirm({
      title: 'Revoke this key?',
      confirmLabel: 'Revoke key',
      body: `${agent.name} loses access through this key right away, along with the SSH keys it added with it. This cannot be undone, but you can create a new key later.`,
      run: () => api.revokeToken(token.id),
    })

  const revokeConnection = (agent: Agent, connection: Connection) =>
    confirm({
      title: 'Revoke this sign-in?',
      confirmLabel: 'Revoke sign-in',
      body: `${agent.name} loses access right away, along with the SSH keys it added through this sign-in. You can connect it again from ${connection.clientName} later.`,
      run: () => api.revokeConnection(connection.id),
    })

  const revokeSshKey = (agent: Agent, key: SshKey) =>
    confirm({
      title: 'Revoke this SSH key?',
      confirmLabel: 'Revoke SSH key',
      body: `${agent.name} can no longer open a shell in workspaces with “${key.name}”. You can add the key again later.`,
      run: () => api.revokeSshKey(key.id),
    })

  return (
    <div>
      <PageHeading>Agent access</PageHeading>
      <p className="mt-3 max-w-prose text-muted">
        Agents such as Claude build and change projects. They sign in through your browser, or use a key if they cannot.
        An SSH key lets an agent open a shell in a project workspace. Access works for every project, so revoke what
        you no longer use.
      </p>

      <div className="mt-10 space-y-10">
        <ConnectBySignIn />

        {created ? (
          <NewKey created={created} onDone={() => setCreated(null)} />
        ) : (
          <form onSubmit={create} className="rounded-lg border border-border bg-surface p-5 sm:p-6">
            <label htmlFor="agent-name" className="text-lg font-semibold font-display">
              Connect with a key
            </label>
            <p className="mt-1 text-sm text-muted">
              For agents that cannot sign in. Name it after where it runs, so you recognize it later.
            </p>
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
              const activeConnections = agent.connections.filter((c) => c.revokedAt === null)
              const revokedConnections = agent.connections.filter((c) => c.revokedAt !== null)
              const activeTokens = agent.tokens.filter((t) => t.revokedAt === null)
              const revokedTokens = agent.tokens.filter((t) => t.revokedAt !== null)
              const activeSshKeys = agent.sshKeys.filter((k) => k.revokedAt === null)
              const revokedSshKeys = agent.sshKeys.filter((k) => k.revokedAt !== null)
              const revokedCount = revokedConnections.length + revokedTokens.length + revokedSshKeys.length
              const showRevoked = revokedShown.has(agent.id)
              return (
                <li key={agent.id} className="border-t border-border pt-6">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
                    <div>
                      <h2 className="text-xl font-semibold break-words">{agent.name}</h2>
                      <p className="text-sm text-muted">{accessSummary(agent)}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button onClick={() => newKey(agent.id)}>New key</Button>
                      <Button onClick={() => setAddingSshKey(agent.id)} disabled={addingSshKey === agent.id}>
                        Add SSH key
                      </Button>
                    </div>
                  </div>
                  {addingSshKey === agent.id && (
                    <AddSshKey
                      agent={agent}
                      onCancel={() => setAddingSshKey(null)}
                      onAdded={() => {
                        setAddingSshKey(null)
                        reload()
                      }}
                    />
                  )}
                  {(activeConnections.length > 0 || activeTokens.length > 0 || activeSshKeys.length > 0) && (
                    <ul className="mt-3 divide-y divide-border">
                      {activeConnections.map((connection) => (
                        <ConnectionRow
                          key={`c${connection.id}`}
                          connection={connection}
                          onRevoke={(c) => revokeConnection(agent, c)}
                        />
                      ))}
                      {activeTokens.map((token) => (
                        <KeyRow key={`t${token.id}`} token={token} onRevoke={(t) => revokeToken(agent, t)} />
                      ))}
                      {activeSshKeys.map((key) => (
                        <SshKeyRow key={`s${key.id}`} sshKey={key} onRevoke={(k) => revokeSshKey(agent, k)} />
                      ))}
                    </ul>
                  )}
                  {revokedCount > 0 && (
                    <div className="mt-2">
                      <button
                        type="button"
                        aria-expanded={showRevoked}
                        onClick={() => toggleRevoked(agent.id)}
                        className="text-sm text-muted underline-offset-2 hover:text-fg hover:underline"
                      >
                        {showRevoked ? 'Hide revoked' : `Show ${revokedCount} revoked`}
                      </button>
                      {showRevoked && (
                        <ul className="mt-1 divide-y divide-border">
                          {revokedConnections.map((connection) => (
                            <ConnectionRow
                              key={`c${connection.id}`}
                              connection={connection}
                              onRevoke={(c) => revokeConnection(agent, c)}
                            />
                          ))}
                          {revokedTokens.map((token) => (
                            <KeyRow key={`t${token.id}`} token={token} onRevoke={(t) => revokeToken(agent, t)} />
                          ))}
                          {revokedSshKeys.map((key) => (
                            <SshKeyRow key={`s${key.id}`} sshKey={key} onRevoke={(k) => revokeSshKey(agent, k)} />
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={removal !== null}
        title={removal?.title ?? ''}
        confirmLabel={removal?.confirmLabel ?? ''}
        variant="danger"
        busy={removeBusy}
        error={removeError}
        onConfirm={remove}
        onCancel={() => setRemoval(null)}
      >
        <p>{removal?.body}</p>
      </ConfirmDialog>
    </div>
  )
}
