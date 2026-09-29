// Renders a project's icons in a pipeline VM, from the checkout after
// `pnpm run build`: node main.ts <project>
import process from 'node:process'

// sharp's fontconfig has no default config file. It reads this when sharp loads.
process.env.FONTCONFIG_FILE ??= '/opt/hobwork/fonts/fonts.conf'

const { IconError, renderIcons } = await import('./render.ts')
try {
  await renderIcons({ dir: process.cwd(), project: process.argv[2] ?? '' })
  console.log('Rendered the hob icon')
} catch (err) {
  console.error(err instanceof IconError ? err.message : err)
  process.exit(1)
}
