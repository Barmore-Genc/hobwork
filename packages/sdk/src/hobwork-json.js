// Plain JavaScript with a .d.ts next to it: vite.config.ts and the icon
// renderer import it from /node_modules in VMs, where Node does not strip types.
import { parseTree, printParseErrorCode } from 'jsonc-parser'

function position(text, offset) {
  const lines = text.slice(0, offset).split('\n')
  return `line ${lines.length} column ${lines.at(-1).length + 1}`
}

// Builds the value from the tree instead of using jsonc-parser's parse, which
// assigns keys with `obj[key] =` and so turns a "__proto__" key into a prototype.
function valueOf(node) {
  if (node.type === 'array') return node.children.map(valueOf)
  if (node.type !== 'object') return node.value
  const object = {}
  for (const property of node.children) {
    const [key, value] = property.children
    Object.defineProperty(object, key.value, { value: valueOf(value), enumerable: true, writable: true, configurable: true })
  }
  return object
}

export function parseHobworkJson(text) {
  const errors = []
  const tree = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false, allowEmptyContent: false })
  const error = errors[0]
  if (error) {
    const message = printParseErrorCode(error.error)
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
    throw new SyntaxError(`${message[0].toUpperCase()}${message.slice(1)} at ${position(text, error.offset)}`)
  }
  return valueOf(tree)
}
