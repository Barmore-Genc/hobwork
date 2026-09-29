import type { ReactNode } from 'react'
import { count, inputClass, LIMIT_FIELDS, money, type LimitsDraft, type ModelsDraft } from './ai-drafts.ts'

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

export function ModelsField({
  id,
  draft,
  onChange,
  anyLabel,
}: {
  id: string
  draft: ModelsDraft
  onChange: (draft: ModelsDraft) => void
  anyLabel: string
}) {
  return (
    <fieldset>
      <legend className="font-semibold">Models</legend>
      <div className="mt-2 space-y-2">
        <Choice name={`${id}-models`} checked={draft.any} onChange={() => onChange({ ...draft, any: true })}>
          {anyLabel}
        </Choice>
        <Choice name={`${id}-models`} checked={!draft.any} onChange={() => onChange({ ...draft, any: false })}>
          Only these models
        </Choice>
      </div>
      {!draft.any && (
        <div className="mt-3 sm:pl-7">
          <textarea
            id={`${id}-list`}
            aria-label="Allowed models"
            value={draft.text}
            onChange={(e) => onChange({ ...draft, text: e.target.value })}
            rows={4}
            placeholder={'openai/gpt-5-mini\ngoogle/*'}
            spellCheck={false}
            className={`${inputClass} py-2 font-mono text-sm`}
          />
          <p className="mt-1 text-sm text-muted">
            One model per line, as OpenRouter names it. A * stands for anything, so google/* allows every Google model.
            An empty list allows no model.
          </p>
        </div>
      )}
    </fieldset>
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
            Past a limit, the project gets an error until it is under the limit again. Leave a field empty for no limit.
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
