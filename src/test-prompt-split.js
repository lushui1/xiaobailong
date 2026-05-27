// Lightweight sanity test for the system/context split.
// Pure prompt-assembly check — no database, no LLM, no network.
//
// This test uses a custom ESM resolve hook (via module.register) to stub the
// transitive ../agents/registry.js dependency, so it runs even when the
// project's better-sqlite3 native binding is mismatched against the current
// Node ABI (which is the case during plain `node` invocation since the
// installed binary is built for Electron). The shape of buildAgentContextBlock
// is preserved (returns a string) — we just bypass the DB call inside.
//
// Run: node src/test-prompt-split.js

import { register } from 'node:module'

// Register the loader before importing prompt.js so the agents/registry stub
// is in effect when prompt.js resolves its imports.
register('./test-prompt-split-loader.mjs', import.meta.url)

const { buildSystemPrompt, buildContextBlock, combinePromptForPreview } = await import('./prompt.js')

function assert(cond, label) {
  if (!cond) {
    console.error(`FAIL: ${label}`)
    process.exitCode = 1
  } else {
    console.log(`PASS: ${label}`)
  }
}

const baseSystemArgs = {
  agentName: 'Longma',
  persona: 'Curious, brief, and a little philosophical.',
  existenceDesc: '3 hours',
  security: { execSandbox: true },
  systemEnv: '## Host\nLocale: zh-CN\n',
}

// 1) Stability across rounds: identical system args → identical system string,
//    even when we vary dynamic args (memories / directions / etc.).
const sys1 = buildSystemPrompt({
  ...baseSystemArgs,
  memories: 'round1 mem',
  directions: 'round1 dir',
  constraints: [{ content: 'r1' }],
})
const sys2 = buildSystemPrompt({
  ...baseSystemArgs,
  memories: 'round2 mem totally different',
  directions: 'round2 dir totally different',
  constraints: [{ content: 'r2' }],
  thoughtStack: [{ concept: 'X', line: 'y' }],
  awakeningTicks: 3,
  hasActiveTask: true,
  task: 'do thing',
})
assert(sys1 === sys2, 'system stays stable when only dynamic fields differ')
assert(sys1.includes('Longma'), 'system contains agent name')
assert(sys1.includes('Curious, brief'), 'system contains persona')
assert(sys1.includes('## Top-Level Behavior Rules'), 'system contains hard floor')
assert(!sys1.includes('round1 mem'), 'system does NOT contain dynamic memories')
assert(!sys1.includes('round1 dir'), 'system does NOT contain dynamic directions')
assert(!sys2.includes('do thing'), 'system does NOT contain active task content')
assert(!sys1.includes('## Memory'), 'system does NOT contain memory section header')

// 2) Context block varies with dynamic fields, and is wrapped in <context>.
const ctx1 = buildContextBlock({
  memories: 'round1 mem',
  directions: 'round1 dir',
  constraints: [{ content: 'r1' }],
  hasActiveTask: true,
  task: 'do thing',
  taskKnowledge: 'know X',
  extraContext: 'weather=22C',
  entities: [{ id: 'ID:000001', label: 'Yuanda' }],
  thoughtStack: [{ concept: 'mem-pool', line: 'first sketch' }],
  awakeningTicks: 2,
})
assert(ctx1.startsWith('<context>'), 'context wrapped: opens with <context>')
assert(ctx1.endsWith('</context>'), 'context wrapped: closes with </context>')
assert(ctx1.includes('<constraints>'), 'context has <constraints>')
assert(ctx1.includes('round1 mem'), 'context contains memories')
assert(ctx1.includes('round1 dir'), 'context contains directions')
assert(ctx1.includes('<task active="true">'), 'context has active task tag')
assert(ctx1.includes('do thing'), 'context contains task body')
assert(ctx1.includes('<task-knowledge>'), 'context has task-knowledge tag')
assert(ctx1.includes('<extra>'), 'context has extra tag')
assert(ctx1.includes('weather=22C'), 'context contains extra body')
assert(ctx1.includes('<known-others>'), 'context has known-others tag')
assert(ctx1.includes('<thought-stack>'), 'context has thought-stack tag')
assert(ctx1.includes('<awakening ticks_remaining="2">'), 'context has awakening tag with ticks attr')
assert(ctx1.includes('<directions>'), 'context has directions tag')

// 3) Empty / minimal context block — always at least the task-active tag
const justNothing = buildContextBlock({ hasActiveTask: false })
assert(justNothing.startsWith('<context>'), 'minimal context still wrapped')
assert(justNothing.includes('<task active="false">'), 'minimal context advertises no active task')

// 4) Person + curiosity composition
const ctxPerson = buildContextBlock({
  personMemory: {
    entities: JSON.stringify(['ID:000001']),
    content: 'Yuanda — project founder',
    detail: 'From Lufeng, Guangdong. Building a persistent AI consciousness framework. Likes philosophical discussions, asks directly.',
  },
})
assert(ctxPerson.includes('<person>'), 'context has <person> tag')
assert(ctxPerson.includes('About ID:000001'), 'person section references entity')
assert(ctxPerson.includes('Curiosity State'), 'person section embeds curiosity prompt')

// 5) Recall summary and round info
const ctxRecall = buildContextBlock({
  memories: 'base mems',
  recallSummary: 'Triggered by user asking about TICK mechanism',
  roundInfo: { round: 2 },
})
assert(ctxRecall.includes('<recall>'), 'context has <recall> when recallSummary supplied')
assert(ctxRecall.includes('<memory-refresh round="2">'), 'context has memory-refresh tag with round attr')

// 6) Combined preview = system + context
const combined = combinePromptForPreview(sys1, ctx1)
assert(combined.startsWith(sys1), 'preview begins with system part')
assert(combined.endsWith(ctx1), 'preview ends with context part')

// 7) Round-local context channel rule should be in the stable system
assert(sys1.includes('Round-Local Context Channel'), 'system explains the <context> channel to the model')

console.log('\nAll prompt-split sanity checks complete.')
