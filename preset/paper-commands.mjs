/**
 * paper-commands — the `/refs` slash command.
 *
 * ONE command, because there is exactly one action in this preset worth a
 * keystroke that does not need the model: audit a bibliography. The handler
 * runs the check and hands the table straight to the UI, so it costs no model
 * turn at all.
 *
 * It imports `runBibCheck` from the sibling row rather than reimplementing it,
 * so the command and the `bib_check` tool cannot drift apart. Preset-local
 * files are ordinary ES modules and relative imports between them resolve
 * normally — the shipped composition relies on the same mechanism.
 *
 * A command publishes nothing and registers into this session's layer of the
 * host `commands` registry, so it sits loose in the composition — no realm.
 */

import { runBibCheck } from './paper-refs.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'paper-commands'

/** The command registry must exist before `/refs` can register. */
export const inject = ['commands']

/** Parse `/refs [bib] [--tex main.tex]` without imposing a strict grammar. */
function parseInput(rawInput) {
  const tokens = String(rawInput ?? '')
    .split(/\s+/)
    .filter((token) => token.length > 0)
  let bib = ''
  let tex = ''
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--tex' || token === '-t') {
      tex = tokens[index + 1] || ''
      index += 1
    } else if (bib.length === 0) {
      bib = token
    }
  }
  return { bib, tex }
}

/** Find the sole .bib file in a directory, if there is exactly one. */
function findSoleBib(directory) {
  const fs = process.getBuiltinModule('node:fs')
  try {
    const candidates = fs.readdirSync(directory).filter((entry) => entry.toLowerCase().endsWith('.bib'))
    return candidates.length === 1 ? candidates[0] : ''
  } catch {
    return ''
  }
}

/** Register `/refs`. */
export function apply(ctx) {
  ctx.effect(() =>
    ctx.commands.register({
      name: 'refs',
      description:
        '核验 .bib 里每条引用是否真实存在（Crossref / DataCite / OpenAlex），输出状态表。用法：/refs [file.bib] [--tex main.tex]',
      input: { hint: '[file.bib] [--tex main.tex]' },
      async handler(invocation) {
        const { bib, tex } = parseInput(invocation.rawInput)
        const cwd =
          (invocation.agent &&
            invocation.agent.session &&
            invocation.agent.session.header &&
            invocation.agent.session.header.cwd) ||
          process.cwd()

        let target = bib
        if (target.length === 0) {
          const found = findSoleBib(cwd)
          if (found.length === 0) {
            return {
              kind: 'error',
              text: `当前目录没有唯一的 .bib 文件。请指定路径：/refs path/to/refs.bib（工作目录：${cwd}）`,
            }
          }
          target = found
        }

        try {
          const text = await runBibCheck(
            { path: target, texPath: tex.length > 0 ? tex : undefined },
            { agent: invocation.agent, signal: invocation.signal },
          )
          return { kind: 'success', text }
        } catch (error) {
          return { kind: 'error', text: `核验失败：${String((error && error.message) || error)}` }
        }
      },
    }),
  )
}
