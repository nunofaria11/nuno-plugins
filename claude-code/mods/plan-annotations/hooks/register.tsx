import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Annotated } from '../types'

const NOTE = /<!--([\s\S]*?)-->/g
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g
const PLAN_FILE = /\/\.claude\/plans\/[^/]+\.md$/

type Note = { line: number; text: string }

const annotated = atom({ plugin: 'plan-annotations', key: 'annotated' } as const, [], {
  shape: 'annotated-1',
})

// Blanks code but keeps every newline, so a note's line number stays true.
const maskCode = (plan: string) => plan.replace(CODE, code => code.replace(/[^\n]/g, ' '))

export function findNotes(plan: string): Note[] {
  const masked = maskCode(plan)
  return [...masked.matchAll(NOTE)].map(m => {
    const start = m.index ?? 0
    return {
      line: masked.slice(0, start).split('\n').length,
      text: plan.slice(start + 4, start + m[0].length - 3).trim().replace(/\s+/g, ' '),
    }
  })
}

function describe(path: string, notes: Note[], isApproved: boolean): string {
  const list = notes.map(n => `- line ${n.line}: ${n.text}`).join('\n')
  const action = isApproved
    ? 'The plan was approved, but do not execute it yet. Address every note, revise the plan file, remove the notes, and present the plan again.'
    : 'Address every note, revise the plan file, remove the notes, and present the plan again.'

  return `See annotations: the user left ${notes.length} note(s) in ${path}.\n${list}\n${action}`
}

export const register: Register = on => {
  let planPath: string | undefined
  let pending: { id: string; path: string } | undefined
  // A plan rejected with notes. Rejecting without feedback interrupts the turn, so
  // the notes only reach Claude with the next prompt.
  let unsent: string | undefined

  const remember = (path: string) => {
    if (PLAN_FILE.test(path)) planPath = path
  }

  // The plan file is learned from the Write or Edit that creates it: another plugin
  // can stop prompt.attachment, which names it, before it reaches this one.
  on('tool.call', { tool: 'Write' }, ($, e, next) => {
    remember(e.file_path)
    return next(e)
  })

  on('tool.call', { tool: 'Edit' }, ($, e, next) => {
    remember(e.file_path)
    return next(e)
  })

  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    unsent = undefined
    if (planPath !== undefined) pending = { id: e.tool_use_id, path: planPath }
    const ran = await next(e)
    const path =
      (ran.deny === undefined && ran.isError !== true ? ran.result?.filePath : undefined) ?? planPath
    if (path === undefined) {
      $.ui.toast('plan-annotations: plan file unknown, notes not checked')
      return ran
    }

    const notes = findNotes(await $.fs.read(path).catch(() => ''))
    if (notes.length === 0) return ran

    const isApproved = ran.deny === undefined && ran.isError !== true
    const message = describe(path, notes, isApproved)
    const lines = notes.map(n => n.line)
    await update($, annotated, list => [...list, { id: e.tool_use_id, lines }].slice(-50))

    if (!isApproved) unsent = path
    if (ran.deny !== undefined) return { deny: `${ran.deny}\n\n${message}` }
    return { ...ran, context: [...(ran.context ?? []), message] }
  }).catch(($, e, next) => next(e))

  // Notes still in the file mean Claude never acted on them. Once Claude has revised
  // the plan (a rejection with feedback keeps the turn going), they are gone.
  on('prompt.submit', async ($, e, next) => {
    if (unsent === undefined || e.command !== undefined) return next(e)
    const path = unsent
    unsent = undefined

    const notes = findNotes(await $.fs.read(path).catch(() => ''))
    if (notes.length === 0) return next(e)
    return next({ ...e, context: [...(e.context ?? []), describe(path, notes, false)] })
  }).catch(($, e, next) => next(e))

  // The result block is drawn once, as the answer comes back and possibly before
  // the call hook above has recorded the notes, so the call still pending reads
  // its plan file here.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const block = await next(e)
    if (e.props.tool !== 'ExitPlanMode') return block

    const id = e.props.tool_use_id
    const recorded = (await read($, annotated)).find(one => one.id === id)?.lines
    const lines =
      recorded ??
      (pending?.id === id
        ? findNotes(await $.fs.read(pending.path).catch(() => '')).map(n => n.line)
        : [])
    if (lines.length === 0) return block

    const { Box, Text } = $.ui.resolve(e)
    const plural = lines.length === 1 ? '' : 's'
    return (
      <Box flexDirection="column">
        {block}
        {/* The terminal draws a result block 5 columns in, after its "  ⎿  " gutter. */}
        <Box paddingLeft={e.surface === 'terminal' ? 5 : 0}>
          <Text color="planMode">
            {`↳ See annotations: ${lines.length} note${plural} (line${plural} ${lines.join(', ')})`}
          </Text>
        </Box>
      </Box>
    )
  })
}
