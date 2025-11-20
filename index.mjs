import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { createRelationalModule, RelationalUtils } from 'relational'
import { Funnels } from 'funnels'
import { Merger } from 'merger'
import { createAcquisitionModule } from 'acquisition'
import { createRecallModule } from 'recall'

export const THEMES = {
  default: {
    label: 'Default',
    recall: { learningRate: 0.3, stanceFlex: 0.4 }
  }
}

export function loadPersonalityFromFile(personaPath) {
  const abs = resolvePath(personaPath)
  const raw = readFileSync(abs, 'utf8')
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object') throw new Error(`[Total] Personality file '${abs}' did not contain a JSON object.`)
  return parsed
}

export function createTotalFromPersonaFile(personaPath, options = {}) {
  const personaConfig = loadPersonalityFromFile(personaPath)
  return new Total({ ...options, personaConfig })
}

function createOfflineMerger(relational) {
  const merger = new Merger({}, relational, { defaultModel: 'total-offline' })
  if (!Array.isArray(merger.configs)) merger.configs = []
  return merger
}

function createDefaultRecallSystem(persona = null, recallOptions = {}) {
  const userId = 'Me'
  const agentId = persona?.id || 'Agent'
  const agents = [
    RelationalUtils.createAgentConfig(userId, {
      name: 'You (external)',
      plasticity: 0.7,
      energy: 0.6,
      socialStyle: 'observer'
    }),
    RelationalUtils.createAgentConfig(agentId, {
      name: persona?.name || 'Agent',
      plasticity: 0.8,
      energy: 0.75,
      socialStyle: 'balanced',
      themePacks: {},
      motifConfig: {},
      initState: {}
    })
  ]
  const relational = createRelationalModule(agents, { tasteConfig: { ProjectionsCtor: undefined } })
  const funnels = new Funnels()
  const merger = createOfflineMerger(relational)
  const { acquisition } = createAcquisitionModule(merger, relational, {
    acceptThreshold: 0.05,
    deferThreshold: 0.05
  })
  const { recall } = createRecallModule(relational, merger, funnels, {
    minSamplesForBias: 2,
    maxEnergyScale: 0.6,
    maxNoveltyBias: 0.5,
    learningAggressiveness: 1.0,
    ...recallOptions
  })
  const lastMergeBySpeaker = Object.create(null)

  async function acquireAndRemember({ text, speakerId, targetId, sourceType, direction }) {
    const result = await acquisition.consider({
      text,
      speakerId,
      targetId,
      direction,
      sourceType,
      channels: ['total']
    })
    if (result.decision === 'accept' && result.mergerResult) {
      const { stance, template, lexicon } = result.mergerResult
      lastMergeBySpeaker[speakerId] = { stance, template, lexicon }
      recall.recordAcquisition({
        speakerId,
        targetId,
        stance,
        template,
        lexicon,
        score: result.score,
        sourceType,
        channels: ['total'],
        snapshot: result.snapshot
      })
      recall.applyFunnelBias(speakerId)
    }
    return result
  }

  async function processLine(line, meta = {}) {
    const userText = line
    await acquireAndRemember({
      text: userText,
      speakerId: userId,
      targetId: agentId,
      sourceType: meta.sourceType || 'user',
      direction: 'incoming'
    })
    const genCfgBase = recall.getGenerationOverrides(agentId, userId, { stance: 'neutral' })
    let genCfg = genCfgBase
    if (persona && typeof persona === 'object') {
      const pLex = persona.lexicon && persona.lexicon.alpha
      const pSyn = persona.syntax && persona.syntax.alpha
      if (pSyn) {
        const self = Array.isArray(pSyn.self) ? pSyn.self : []
        const other = Array.isArray(pSyn.otherSpeaker) ? pSyn.otherSpeaker : []
        const personaTemplates = [...self, ...other].filter(Boolean)
        if (personaTemplates.length) {
          const existing = Array.isArray(genCfg.templates) ? genCfg.templates : []
          genCfg = { ...genCfg, templates: [...personaTemplates, ...existing], source: genCfg.source || 'merger' }
        }
      }
      if (pLex && typeof pLex === 'object') {
        const existingLex = (genCfg.lexicon && typeof genCfg.lexicon === 'object') ? genCfg.lexicon : {}
        const mergedLex = {}
        const keys = new Set([...Object.keys(existingLex), ...Object.keys(pLex)])
        for (const key of keys) {
          const baseArr = Array.isArray(existingLex[key]) ? existingLex[key] : []
          const personaArr = Array.isArray(pLex[key]) ? pLex[key] : []
          const seen = new Set()
          mergedLex[key] = [...personaArr, ...baseArr].filter(tok => {
            if (!tok || seen.has(tok)) return false
            seen.add(tok)
            return true
          })
        }
        genCfg = { ...genCfg, lexicon: mergedLex, source: genCfg.source || 'merger' }
      }
    }
    const tR = await relational.processTurn(agentId, userText, { fromUserId: userId, generationConfig: genCfg, ...meta })
    const agentText = tR.baseResponse?.text || '(no text generated)'
    await acquireAndRemember({
      text: agentText,
      speakerId: agentId,
      targetId: userId,
      sourceType: 'internal',
      direction: 'outgoing'
    })
    const tC = Math.floor(Math.random() * 6) + 1
    funnels.update(tC)
    return agentText
  }
  recall.processLine = processLine
  recall._totalInternals = { userId, agentId, relational, funnels, merger, acquisition, lastMergeBySpeaker }
  return recall
}

export class Total {
  constructor({
    themeName = 'default',
    recallSystem = null,
    recallOptions = {},
    personaPath = null,
    personaConfig = null
  } = {}) {
    if (!personaConfig && personaPath) personaConfig = loadPersonalityFromFile(personaPath)
    this.persona = personaConfig || null
    this.themes = this.persona
    this.currentTheme = null
    this.agentName = (this.persona && this.persona.name) || 'agent'
    themeName = this.persona.parameters.themeName
    this.recall = recallSystem || createDefaultRecallSystem(this.persona, recallOptions)
    if (!this.recall || typeof this.recall.processLine !== 'function') {
      console.log('Warning: recall system does not implement processLine(line, meta).')
    }
    this.applyTheme(themeName)
    if (this.persona) this.applyPersona(this.persona)
  }

  getThemeNames() { return [this.themes.id] }

  getCurrentTheme() { return this.currentTheme }

  applyTheme(name) {
    const theme = this.themes[name]
    if (!theme) return
    this.currentTheme = name
    if (this.recall) {
      if (typeof this.recall.applyTheme === 'function') {
        this.recall.applyTheme(theme)
      } else if (typeof this.recall.setTheme === 'function') {
        this.recall.setTheme(name, theme)
      } else if (theme.recall && typeof this.recall.applyParameters === 'function') {
        this.recall.applyParameters({ recall: theme.recall })
      }
    }
    console.log(`[Total] Theme set to '${name}' (${theme.label}).`)
  }

  applyPersona(persona) {
    if (!persona || typeof persona !== 'object') return
    this.persona = persona
    this.agentName = persona.name || this.agentName || 'agent'
    const { lexicon, syntax, parameters } = persona
    if (this.recall && typeof this.recall.applyPersona === 'function') {
      this.recall.applyPersona(persona)
    } else {
      if (this.recall && typeof this.recall.applyLexiconSyntaxOverrides === 'function') {
        this.recall.applyLexiconSyntaxOverrides({ lexicon, syntax })
      } else if (this.recall && (lexicon || syntax)) {
        console.log('[Total] Recall has no applyLexiconSyntaxOverrides; lexicon/syntax persona data may be ignored.')
      }
      if (parameters && this.recall) {
        if (typeof this.recall.applyParameters === 'function') {
          this.recall.applyParameters(parameters)
        } else if (parameters.recall && typeof this.recall.applyTheme === 'function') {
          this.recall.applyTheme(parameters.recall)
        }
      }
    }
    console.log(`[Total] Persona applied: ${this.agentName}\n`)
  }

  async handleUserLine(line, meta = {}) {
    if (!this.recall || typeof this.recall.processLine !== 'function') {
      console.log('[Total] Recall system is missing or does not implement processLine(line, meta).')
      return ''
    }
    const result = await this.recall.processLine(line, {
      theme: this.currentTheme,
      personaName: this.agentName,
      personaId: this.persona && this.persona.id,
      ...meta
    })
    if (typeof result === 'string') return result
    if (result && typeof result.text === 'string') return result.text
    return String(result ?? '')
  }

  showLexiconSummary() {
    if (this.recall && typeof this.recall.printLexiconSummary === 'function') {
      this.recall.printLexiconSummary()
    } else if (this.recall && typeof this.recall.dumpLexicon === 'function') {
      this.recall.dumpLexicon()
    } else {
      console.log('[Total] No lexicon summary available.')
    }
  }

  showRelationalSummary() {
    if (this.recall && typeof this.recall.printRelationalSummary === 'function') {
      this.recall.printRelationalSummary()
    } else if (this.recall && typeof this.recall.dumpRelational === 'function') {
      this.recall.dumpRelational()
    } else {
      console.log('[Total] No relational summary available.')
    }
  }

  showStateSummary() {
    if (this.recall && typeof this.recall.printStateSummary === 'function') {
      this.recall.printStateSummary()
    } else {
      console.log('[Total] No composite state summary available.')
      this.showRelationalSummary()
      this.showLexiconSummary()
    }
  }
}