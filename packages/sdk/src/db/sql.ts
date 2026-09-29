// A minimal SQL lexer: enough to tell comments, quoted strings and identifiers
// apart from the code around them, so `;` and keywords are only found in code.

type Chunk = { code: boolean; text: string }

function chunks(sql: string): Chunk[] {
  const out: Chunk[] = []
  let code = ''
  const flush = () => {
    if (code) out.push({ code: true, text: code })
    code = ''
  }
  let i = 0
  while (i < sql.length) {
    const c = sql[i]!
    const next = sql[i + 1]
    let end = -1
    if (c === '-' && next === '-') {
      end = sql.indexOf('\n', i)
      end = end === -1 ? sql.length : end + 1
    } else if (c === '/' && next === '*') {
      end = sql.indexOf('*/', i + 2)
      end = end === -1 ? sql.length : end + 2
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c
      end = i + 1
      for (;;) {
        const found = sql.indexOf(close, end)
        if (found === -1) {
          end = sql.length
          break
        }
        // A doubled quote is an escaped quote.
        if (close !== ']' && sql[found + 1] === close) {
          end = found + 2
          continue
        }
        end = found + 1
        break
      }
    }
    if (end === -1) {
      code += c
      i++
      continue
    }
    flush()
    const text = sql.slice(i, end)
    out.push({ code: false, text: text.startsWith('--') || text.startsWith('/*') ? ' ' : text })
    i = end
  }
  flush()
  return out
}

// Statements separated by top-level semicolons, with comments removed. Does not
// understand CREATE TRIGGER bodies, which contain semicolons of their own.
export function splitStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  for (const chunk of chunks(sql)) {
    if (!chunk.code) {
      current += chunk.text
      continue
    }
    const parts = chunk.text.split(';')
    current += parts[0]
    for (const part of parts.slice(1)) {
      statements.push(current)
      current = part
    }
  }
  statements.push(current)
  return statements.map((s) => s.trim()).filter(Boolean)
}

export function firstKeyword(sql: string): string {
  const code = chunks(sql).find((chunk) => chunk.code && chunk.text.trim())
  return /^\s*([A-Za-z]+)/.exec(code?.text ?? '')?.[1]?.toUpperCase() ?? ''
}
