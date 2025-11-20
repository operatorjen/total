import { createRequire } from 'node:module'
import { Total, loadPersonalityFromFile } from './index.mjs'
const require = createRequire(import.meta.url)
const PERSONA_PATH = require.resolve('portraits/king-tut.json')

function banner(title) {
  console.log(`${title}`)
  console.log('='.repeat(60), '\n')
}

function assert(condition, message) { if (!condition) throw new Error(message || 'Assertion failed') }

function loadPersona() { return loadPersonalityFromFile(PERSONA_PATH) }

function getTut() {
  const r = ['is booting up', 'is considering a response', 'will be with you in a moment', 'says "Please hold"']
  return r[Math.floor(Math.random() * r.length)]
}

async function basicInteractionTest() {
  const persona = loadPersona()
  const total = new Total({
    themeName: persona.parameters?.themeName || 'default',
    personaPath: PERSONA_PATH
  })
  assert(total.agentName === persona.name, 'Total.agentName should reflect king-tut persona name')
  const MESSAGES = ['Hi, what kind of system are you?', 'How do you change over time when we talk more?', 'Explain your feelings about KING-TUT when it is cloudy outside.', 'You look wonderful - tell me about your thoughts on KING-TUT.','Consider the idea that you are not KING-TUT.','How is the weather in your region?']
  for (let i = 0; i < 12; i++) {
    const user = MESSAGES[Math.floor(Math.random() * MESSAGES.length)]
    console.log(`[${i}] you:  ${user}`)
    console.log(`\nKING-TUT ${getTut()}...\n`)
    const reply = await total.handleUserLine(user)
    console.log(`[${i + 1}] ${total.agentName}: ${reply}\n\n${'~'.repeat(50)}\n`)
    assert(typeof reply === 'string', 'Reply should be a string')
  }
}

async function run() {
  banner('CYBERNETIC MEMETIC CONVERSATIONS with KING-TUT')
  await basicInteractionTest()
  console.log('\nTESTS COMPLETE')
}

run().catch((err) => {
  console.error('\n[Total tests] ERROR:', err)
  console.error(err?.stack || err)
  process.exitCode = 1
})