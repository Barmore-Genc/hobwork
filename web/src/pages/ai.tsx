import type { ReactNode } from 'react'
import type { AiModels } from '../api.ts'
import { count, inputClass, LIMIT_FIELDS, money, type LimitsDraft, type ModelDraft, type ModelsDraft } from './ai-drafts.ts'

function Choice({
  name,
  checked,
  onChange,
  children,
}: {
  name: string
  checked: boolean
  onChange: () => void
  children: ReactNode
}) {
  return (
    <label className="flex items-start gap-3">
      <input type="radio" name={name} checked={checked} onChange={onChange} className="mt-1.5 accent-accent" />
      <span>{children}</span>
    </label>
  )
}

function ModelField({
  id,
  legend,
  help,
  draft,
  onChange,
  inheritLabel,
  offLabel,
  placeholder,
}: {
  id: string
  legend: string
  help: string
  draft: ModelDraft
  onChange: (draft: ModelDraft) => void
  inheritLabel: ReactNode
  // Offered only when the field can be turned off.
  offLabel?: ReactNode
  placeholder: string
}) {
  const name = `${id}-${legend}`
  return (
    <fieldset>
      <legend className="font-semibold">{legend}</legend>
      <p className="mt-1 max-w-prose text-sm text-muted">{help}</p>
      <div className="mt-2 space-y-2">
        <Choice name={name} checked={draft.mode === 'inherit'} onChange={() => onChange({ ...draft, mode: 'inherit' })}>
          {inheritLabel}
        </Choice>
        <Choice name={name} checked={draft.mode === 'set'} onChange={() => onChange({ ...draft, mode: 'set' })}>
          Another model
        </Choice>
        {offLabel && (
          <Choice name={name} checked={draft.mode === 'off'} onChange={() => onChange({ ...draft, mode: 'off' })}>
            {offLabel}
          </Choice>
        )}
      </div>
      {draft.mode === 'set' && (
        <div className="mt-3 sm:pl-7">
          <input
            aria-label={legend}
            value={draft.text}
            onChange={(e) => onChange({ ...draft, text: e.target.value })}
            placeholder={placeholder}
            spellCheck={false}
            autoCapitalize="off"
            className={`${inputClass} font-mono text-sm`}
          />
          <p className="mt-1 text-sm text-muted">
            The model ID from its page on{' '}
            <a href="https://openrouter.ai/models" target="_blank" rel="noreferrer" className="underline hover:text-fg">
              OpenRouter
            </a>
            .
          </p>
        </div>
      )}
    </fieldset>
  )
}

const Mono = ({ children }: { children: ReactNode }) => <span className="font-mono text-sm">{children}</span>

export function ModelFields({
  id,
  draft,
  onChange,
  inherited,
  inheritFrom,
}: {
  id: string
  draft: ModelsDraft
  onChange: (draft: ModelsDraft) => void
  // What the inherit choice gives, and where it comes from.
  inherited: AiModels
  inheritFrom: string
}) {
  return (
    <div className="space-y-6">
      <ModelField
        id={id}
        legend="Model"
        help="Hobs use this model for everything they ask AI to write or read."
        draft={draft.model}
        onChange={(model) => onChange({ ...draft, model })}
        inheritLabel={
          <>
            {inheritFrom}: <Mono>{inherited.model}</Mono>
          </>
        }
        placeholder="deepseek/deepseek-v4.1-flash"
      />
      <ModelField
        id={id}
        legend="Decision model"
        help="Hobs use this model for yes-or-no questions and for picking one of a few options. Decision models answer these faster and cheaper than other models."
        draft={draft.decisionModel}
        onChange={(decisionModel) => onChange({ ...draft, decisionModel })}
        inheritLabel={
          <>
            {inheritFrom}: {inherited.decisionModel ? <Mono>{inherited.decisionModel}</Mono> : 'none'}
          </>
        }
        offLabel="None: the model above answers these too"
        placeholder="typesafe/jev-1.13"
      />
      <ModelField
        id={id}
        legend="Embedding model"
        help="Hobs use this model to turn text into vectors, to find similar items. Embeddings a hob stored before a change cannot be compared with new ones."
        draft={draft.embeddingModel}
        onChange={(embeddingModel) => onChange({ ...draft, embeddingModel })}
        inheritLabel={
          <>
            {inheritFrom}: <Mono>{inherited.embeddingModel}</Mono>
          </>
        }
        placeholder="openai/text-embedding-3-small"
      />
    </div>
  )
}

export function LimitsFields({
  id,
  draft,
  onChange,
}: {
  id: string
  draft: LimitsDraft
  onChange: (draft: LimitsDraft) => void
}) {
  return (
    <div>
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={draft.throttle}
          onChange={(e) => onChange({ ...draft, throttle: e.target.checked })}
          className="mt-1.5 accent-accent"
        />
        <span>
          <span className="font-semibold">Limit requests and spending</span>
          <span className="block text-sm text-muted">
            Past a limit, the hob gets an error until it is under the limit again. Leave a field empty for no limit.
          </span>
        </span>
      </label>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 sm:pl-7">
        {LIMIT_FIELDS.map(({ field, label, money: isMoney }) => (
          <div key={field}>
            <label htmlFor={`${id}-${field}`} className="text-sm font-semibold">
              {label}
            </label>
            <input
              id={`${id}-${field}`}
              type="number"
              inputMode={isMoney ? 'decimal' : 'numeric'}
              min={isMoney ? 0.01 : 1}
              step={isMoney ? 0.01 : 1}
              value={draft[field]}
              onChange={(e) => onChange({ ...draft, [field]: e.target.value })}
              disabled={!draft.throttle}
              placeholder="No limit"
              className={`${inputClass} tabular`}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

export function UsageTable({
  rows,
}: {
  rows: { key: string; label: ReactNode; requests: number; refused: number; tokens?: number; cost: number }[]
}) {
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[28rem] text-left text-[0.95rem]">
        <thead className="text-sm text-muted">
          <tr className="border-b border-border">
            <th className="py-2 pr-4 font-semibold"></th>
            <th className="py-2 pr-4 text-right font-semibold">Requests</th>
            <th className="py-2 pr-4 text-right font-semibold">Refused</th>
            {rows.some((row) => row.tokens !== undefined) && <th className="py-2 pr-4 text-right font-semibold">Tokens</th>}
            <th className="py-2 text-right font-semibold">Spent</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-border">
              <td className="py-2 pr-4 break-all">{row.label}</td>
              <td className="py-2 pr-4 text-right tabular">{count(row.requests)}</td>
              <td className="py-2 pr-4 text-right tabular">{count(row.refused)}</td>
              {row.tokens !== undefined && <td className="py-2 pr-4 text-right tabular">{count(row.tokens)}</td>}
              <td className="py-2 text-right tabular">{money(row.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
