import { expect, test, type TestBody } from 'claude-code/testing'

import { findNotes } from './register'

const PLAN = '/plans/test-plan.md'

type On = Parameters<TestBody>[1]

const engine = (on: On, plan: string) => {
  on('fs.read', (_, e) => {
    if (e.path !== PLAN) throw new Error(`unexpected read: ${e.path}`)
    return { value: plan }
  })
  on('tool.call', { tool: 'ExitPlanMode' }, () => ({
    result: { plan: null, isAgent: false, filePath: PLAN },
  }))
}

test('an approved plan with notes gets them listed for Claude', async ($, on) => {
  engine(on, '# Plan\n\n1. Step one <!-- use bar -->\n2. Step two\n<!-- drop this\n   step -->\n')

  const ran = await $.tool.call({ tool: 'ExitPlanMode' })

  expect(ran.deny).toBeUndefined()
  const note = ran.context?.join('\n') ?? ''
  expect(note).toContain(`See annotations: the user left 2 note(s) in ${PLAN}`)
  expect(note).toContain('- line 3: use bar')
  expect(note).toContain('- line 5: drop this step')
  expect(note).toContain('do not execute it yet')
})

test('a plan without notes passes through untouched', async ($, on) => {
  engine(on, '# Plan\n\n1. Step one\n')

  const ran = await $.tool.call({ tool: 'ExitPlanMode' })

  expect(ran.context ?? []).toEqual([])
})

const WRITTEN = '/Users/me/.claude/plans/quiet-plan.md'
const NOTED = '# Plan\n\n<!-- rename to goodbye.txt -->\n1. Step one\n'

const rejectingEngine = (on: On, rejection: 'deny' | 'error') => {
  on('fs.read', (_, e) => {
    if (e.path !== WRITTEN) throw new Error(`unexpected read: ${e.path}`)
    return { value: NOTED }
  })
  on('tool.call', { tool: 'Write' }, () => ({ result: { type: 'create', filePath: WRITTEN, content: NOTED, structuredPatch: [], originalFile: null } }))
  on('tool.call', { tool: 'ExitPlanMode' }, () =>
    rejection === 'deny'
      ? { deny: 'The user rejected the plan.' }
      : { isError: true, result: 'The user rejected the plan.', text: 'The user rejected the plan.' },
  )
}

for (const rejection of ['deny', 'error'] as const) {
  test(`a rejected plan (${rejection}) points Claude at the notes in the file it wrote`, async ($, on) => {
    rejectingEngine(on, rejection)

    await $.tool.call({ tool: 'Write', file_path: WRITTEN, content: NOTED })
    const ran = await $.tool.call({ tool: 'ExitPlanMode' })

    const told = rejection === 'deny' ? (ran.deny ?? '') : (ran.context?.join('\n') ?? '')
    expect(told).toContain(`See annotations: the user left 1 note(s) in ${WRITTEN}`)
    expect(told).toContain('- line 3: rename to goodbye.txt')
    expect(told).not.toContain('do not execute it yet')
  })
}

const rejectedThenPrompted = async ($: Parameters<TestBody>[0], on: On, revised: string) => {
  let plan = NOTED
  on('fs.read', (_, e) => {
    if (e.path !== WRITTEN) throw new Error(`unexpected read: ${e.path}`)
    return { value: plan }
  })
  on('tool.call', { tool: 'Write' }, () => ({ result: { type: 'create', filePath: WRITTEN, content: NOTED, structuredPatch: [], originalFile: null } }))
  on('tool.call', { tool: 'ExitPlanMode' }, () => ({ deny: 'The user rejected the plan.' }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))

  await $.tool.call({ tool: 'Write', file_path: WRITTEN, content: NOTED })
  await $.tool.call({ tool: 'ExitPlanMode' })
  plan = revised
  return $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } })
}

test('a plan rejected without feedback hands its notes to the next prompt', async ($, on) => {
  const sent = await rejectedThenPrompted($, on, NOTED)

  const told = sent.drop === undefined ? (sent.context?.join('\n') ?? '') : ''
  expect(told).toContain(`See annotations: the user left 1 note(s) in ${WRITTEN}`)
  expect(told).toContain('- line 3: rename to goodbye.txt')
})

test('notes Claude already removed are not sent again with the next prompt', async ($, on) => {
  const sent = await rejectedThenPrompted($, on, '# Plan\n\n1. Step one\n')

  expect(sent.drop === undefined ? (sent.context ?? []) : ['dropped']).toEqual([])
})

test('notes inside code are not notes', () => {
  const plan = 'Use `<!-- a -->` here\n```\n<!-- b -->\n```\nReal <!-- use `foo` --> note\n'

  expect(findNotes(plan)).toEqual([{ line: 5, text: 'use `foo`' }])
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the result block of an annotated plan says so (${surface})`, async ($, on) => {
    rejectingEngine(on, 'error')
    await $.tool.call({ tool: 'Write', file_path: WRITTEN, content: NOTED })
    await $.tool.call({ tool: 'ExitPlanMode', tool_use_id: 'plan-1' })

    const ui = await $.ui.mount({
      plugin: 'plan-annotations',
      surface,
      component: 'ToolResult',
      props: { tool_use_id: 'plan-1', tool: 'ExitPlanMode', output: 'The user rejected the plan.', isErrored: true },
    })

    expect(JSON.stringify(await ui.find({ type: 'Text' }))).toContain('See annotations: 1 note (line 3)')
    await ui.unmount()
  })
}
