import fs from 'fs'
import { paths } from './paths.js'

export const DEEPSEEK_PROVIDER = 'deepseek'
export const MINIMAX_PROVIDER = 'minimax'
export const OPENAI_PROVIDER = 'openai'
export const QWEN_PROVIDER = 'qwen'
export const MOONSHOT_PROVIDER = 'moonshot'
export const ZHIPU_PROVIDER = 'zhipu'

export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash'
export const DEFAULT_MINIMAX_MODEL = 'MiniMax-M2.7'
export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini'
export const DEFAULT_QWEN_MODEL = 'qwen-turbo'
export const DEFAULT_MOONSHOT_MODEL = 'moonshot-v1-8k'
export const DEFAULT_ZHIPU_MODEL = 'glm-4-flash'

export const DEEPSEEK_MODELS = [
  {
    id: 'deepseek-v4-flash',
    label: 'deepseek-v4-flash',
    deprecated: false,
  },
  {
    id: 'deepseek-v4-pro',
    label: 'deepseek-v4-pro',
    deprecated: false,
  },
  {
    id: 'deepseek-chat',
    label: 'deepseek-chat (deprecated 2026/07/24)',
    deprecated: true,
  },
  {
    id: 'deepseek-reasoner',
    label: 'deepseek-reasoner (deprecated 2026/07/24)',
    deprecated: true,
  },
]

export const MINIMAX_MODELS = [
  {
    id: 'MiniMax-M2.7',
    label: 'MiniMax-M2.7',
    deprecated: false,
  },
  {
    id: 'MiniMax-M1',
    label: 'MiniMax-M1',
    deprecated: false,
  },
]

export const OPENAI_MODELS = [
  {
    id: 'gpt-4o-mini',
    label: 'gpt-4o-mini',
    deprecated: false,
  },
  {
    id: 'gpt-4o',
    label: 'gpt-4o',
    deprecated: false,
  },
]

export const QWEN_MODELS = [
  {
    id: 'qwen-turbo',
    label: 'qwen-turbo',
    deprecated: false,
  },
  {
    id: 'qwen-plus',
    label: 'qwen-plus',
    deprecated: false,
  },
]

export const MOONSHOT_MODELS = [
  {
    id: 'moonshot-v1-8k',
    label: 'moonshot-v1-8k',
    deprecated: false,
  },
  {
    id: 'moonshot-v1-32k',
    label: 'moonshot-v1-32k',
    deprecated: false,
  },
]

export const ZHIPU_MODELS = [
  {
    id: 'glm-4-flash',
    label: 'glm-4-flash',
    deprecated: false,
  },
  {
    id: 'glm-4-plus',
    label: 'glm-4-plus',
    deprecated: false,
  },
]

const PROVIDER_CONFIG = {
  [DEEPSEEK_PROVIDER]: {
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    envVar: 'DEEPSEEK_API_KEY',
    models: DEEPSEEK_MODELS,
    defaultModel: DEFAULT_DEEPSEEK_MODEL,
  },
  [MINIMAX_PROVIDER]: {
    label: 'MiniMax',
    baseURL: 'https://api.minimax.chat/v1',
    envVar: 'MINIMAX_API_KEY',
    models: MINIMAX_MODELS,
    defaultModel: DEFAULT_MINIMAX_MODEL,
  },
  [OPENAI_PROVIDER]: {
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    envVar: 'OPENAI_API_KEY',
    models: OPENAI_MODELS,
    defaultModel: DEFAULT_OPENAI_MODEL,
  },
  [QWEN_PROVIDER]: {
    label: 'Qwen',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    envVar: 'DASHSCOPE_API_KEY',
    models: QWEN_MODELS,
    defaultModel: DEFAULT_QWEN_MODEL,
  },
  [MOONSHOT_PROVIDER]: {
    label: 'Moonshot',
    baseURL: 'https://api.moonshot.cn/v1',
    envVar: 'MOONSHOT_API_KEY',
    models: MOONSHOT_MODELS,
    defaultModel: DEFAULT_MOONSHOT_MODEL,
  },
  [ZHIPU_PROVIDER]: {
    label: 'Zhipu',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    envVar: 'ZHIPU_API_KEY',
    models: ZHIPU_MODELS,
    defaultModel: DEFAULT_ZHIPU_MODEL,
  },
}

const AUTO_PROVIDER = 'auto'
const PROBE_TIMEOUT_MS = 12000

function normalizeModel(model, provider = DEEPSEEK_PROVIDER) {
  const pConfig = PROVIDER_CONFIG[provider] || PROVIDER_CONFIG[DEEPSEEK_PROVIDER]
  const value = String(model || '').trim()
  const validIds = new Set(pConfig.models.map(m => m.id))
  if (validIds.has(value)) return value
  return pConfig.defaultModel
}

function isThinkingEnabledForModel(model) {
  return normalizeModel(model) !== 'deepseek-chat'
}

function getProvidersForAutoDetect() {
  return Object.entries(PROVIDER_CONFIG)
}

function getProviderErrorMessage(err) {
  const status = err?.status ?? err?.response?.status
  const message = err?.message || String(err)
  return status ? `${status} ${message}` : message
}

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function buildPingParams(provider, model) {
  const pingParams = {
    model,
    messages: [{ role: 'user', content: 'Reply with exactly: hello' }],
    max_tokens: 8,
    temperature: 0,
    stream: false,
  }
  if (provider === DEEPSEEK_PROVIDER) {
    pingParams.reasoning_effort = 'high'
    pingParams.thinking = { type: isThinkingEnabledForModel(model) ? 'enabled' : 'disabled' }
  }
  return pingParams
}

async function probeProvider(OpenAI, provider, apiKey, requestedModel) {
  const pConfig = PROVIDER_CONFIG[provider]
  const model = normalizeModel(requestedModel, provider)
  const client = new OpenAI({
    apiKey,
    baseURL: pConfig.baseURL,
    timeout: PROBE_TIMEOUT_MS,
  })
  await withTimeout(
    client.chat.completions.create(buildPingParams(provider, model)),
    PROBE_TIMEOUT_MS,
    provider,
  )
  return { provider, model, pConfig }
}

async function detectProvider(OpenAI, apiKey, requestedModel) {
  const providers = getProvidersForAutoDetect()
  const errors = []

  return await new Promise((resolve, reject) => {
    let pending = providers.length
    for (const [provider] of providers) {
      probeProvider(OpenAI, provider, apiKey, requestedModel)
        .then(resolve)
        .catch((err) => {
          errors.push(`${provider}: ${getProviderErrorMessage(err)}`)
          pending -= 1
          if (pending === 0) {
            reject(new Error(`Could not identify the provider for this API key. Tried: ${providers.map(([name]) => name).join(', ')}. Last errors: ${errors.slice(-3).join(' | ')}`))
          }
        })
    }
  })
}

function readStoredConfig() {
  try {
    if (!fs.existsSync(paths.configFile)) return null
    const raw = fs.readFileSync(paths.configFile, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    if (!parsed.provider) return null
    if (parsed.provider === 'custom') {
      if (!parsed.baseURL || typeof parsed.baseURL !== 'string') return null
      if (!parsed.model || typeof parsed.model !== 'string') return null
      return parsed
    }
    if (!PROVIDER_CONFIG[parsed.provider]) return null
    if (!parsed.apiKey || typeof parsed.apiKey !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

function writeStoredConfig(obj) {
  const tmp = paths.configFile + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8')
  fs.renameSync(tmp, paths.configFile)
}

function shouldAllowEnvFallback() {
  return !process.versions?.electron
}

function loadFromEnv() {
  const deepseekKey = process.env['DEEPSEEK_API_KEY']
  if (deepseekKey) {
    return {
      provider: DEEPSEEK_PROVIDER,
      apiKey: deepseekKey,
      model: normalizeModel(process.env.DEEPSEEK_MODEL, DEEPSEEK_PROVIDER),
    }
  }
  const minimaxKey = process.env['MINIMAX_API_KEY']
  if (minimaxKey) {
    return {
      provider: MINIMAX_PROVIDER,
      apiKey: minimaxKey,
      model: normalizeModel(process.env.MINIMAX_MODEL, MINIMAX_PROVIDER),
    }
  }
  for (const [provider, pConfig] of Object.entries(PROVIDER_CONFIG)) {
    if (provider === DEEPSEEK_PROVIDER || provider === MINIMAX_PROVIDER) continue
    const key = process.env[pConfig.envVar]
    if (key) {
      return {
        provider,
        apiKey: key,
        model: normalizeModel(process.env[`${pConfig.envVar.replace(/_API_KEY$/, '')}_MODEL`], provider),
      }
    }
  }
  return null
}

function applyConfig(provider, apiKey, model, customBaseURL) {
  if (provider === 'custom') {
    config.provider = 'custom'
    config.model = String(model || '').trim()
    config.apiKey = apiKey || 'none'
    config.baseURL = String(customBaseURL || '').trim()
    config.needsActivation = false
    return
  }
  const pConfig = PROVIDER_CONFIG[provider]
  config.provider = provider
  config.model = normalizeModel(model, provider)
  config.apiKey = apiKey
  config.baseURL = pConfig.baseURL
  config.needsActivation = false
}

export const config = {
  tickInterval: 20 * 60 * 1000,
  provider: null,
  model: null,
  apiKey: null,
  baseURL: null,
  needsActivation: true,
  temperature: 0.5,
  security: {
    fileSandbox: true,
    execSandbox: true,
    blockedTools: [],
  },
}

const stored = readStoredConfig()
if (stored) {
  applyConfig(stored.provider, stored.apiKey, stored.model, stored.baseURL)
  if (typeof stored.temperature === 'number' && stored.temperature >= 0 && stored.temperature <= 2) {
    config.temperature = stored.temperature
  }
  if (stored.security && typeof stored.security === 'object') {
    if (typeof stored.security.fileSandbox === 'boolean') config.security.fileSandbox = stored.security.fileSandbox
    if (typeof stored.security.execSandbox === 'boolean') config.security.execSandbox = stored.security.execSandbox
    if (Array.isArray(stored.security.blockedTools)) config.security.blockedTools = stored.security.blockedTools
  }
} else if (shouldAllowEnvFallback()) {
  const fromEnv = loadFromEnv()
  if (fromEnv) applyConfig(fromEnv.provider, fromEnv.apiKey, fromEnv.model)
}

// At startup, copy social credentials from the config file into process.env so connectors can read them
;(function loadSocialEnv() {
  try {
    const raw = fs.readFileSync(paths.configFile, 'utf-8')
    const social = JSON.parse(raw)?.social || {}
    for (const [key, val] of Object.entries(social)) {
      if (typeof val === 'string' && val && globalThis.process?.env) {
        globalThis.process.env[key] = val
      }
    }
  } catch {}
})()

export async function activate({ provider = AUTO_PROVIDER, apiKey, model, baseURL }) {
  const p = String(provider || AUTO_PROVIDER).toLowerCase()

  if (p === 'custom') {
    const normalizedBaseURL = String(baseURL || '').trim()
    if (!normalizedBaseURL) throw new Error('Custom endpoint requires a Base URL')
    const normalizedModel = String(model || '').trim()
    if (!normalizedModel) throw new Error('Custom endpoint requires a model name')
    const normalizedKey = String(apiKey || '').trim() || 'none'

    const { default: OpenAI } = await import('openai')
    const client = new OpenAI({ apiKey: normalizedKey, baseURL: normalizedBaseURL, timeout: PROBE_TIMEOUT_MS })
    try {
      await withTimeout(
        client.chat.completions.create({
          model: normalizedModel,
          messages: [{ role: 'user', content: 'Reply with exactly: hello' }],
          max_tokens: 16,
          temperature: 0,
          stream: false,
        }),
        PROBE_TIMEOUT_MS,
        'custom',
      )
    } catch (err) {
      const message = err?.message || String(err)
      throw new Error(`Custom endpoint connection failed: ${message}`)
    }

    applyConfig('custom', normalizedKey, normalizedModel, normalizedBaseURL)
    writeStoredConfig({
      provider: 'custom',
      apiKey: normalizedKey,
      model: normalizedModel,
      baseURL: normalizedBaseURL,
      activatedAt: new Date().toISOString(),
    })
    return {
      provider: 'custom',
      model: normalizedModel,
      models: [{ id: normalizedModel, label: normalizedModel, deprecated: false }],
    }
  }

  const pConfig = PROVIDER_CONFIG[p]
  if (p !== AUTO_PROVIDER && !pConfig) {
    throw new Error(`Unsupported provider: "${p}". Available: ${Object.keys(PROVIDER_CONFIG).join(', ')}`)
  }

  const normalizedKey = String(apiKey || '').trim()
  const normalizedModel = normalizeModel(model, p)
  if (normalizedKey.length < 8) {
    throw new Error(`${p} key is invalid`)
  }

  const { default: OpenAI } = await import('openai')
  if (p === AUTO_PROVIDER) {
    const detected = await detectProvider(OpenAI, normalizedKey, model)
    applyConfig(detected.provider, normalizedKey, detected.model)
    writeStoredConfig({
      provider: detected.provider,
      apiKey: normalizedKey,
      model: detected.model,
      activatedAt: new Date().toISOString(),
    })
    return {
      provider: detected.provider,
      model: detected.model,
      models: detected.pConfig.models,
    }
  }

  const client = new OpenAI({ apiKey: normalizedKey, baseURL: pConfig.baseURL, timeout: PROBE_TIMEOUT_MS })

  try {
    await withTimeout(
      client.chat.completions.create(buildPingParams(p, normalizedModel)),
      PROBE_TIMEOUT_MS,
      p,
    )
  } catch (err) {
    const message = err?.message || String(err)
    if (/401|unauthoriz|invalid.*api.*key|authentication/i.test(message)) {
      throw new Error(`${p} key validation failed — please check that the key is correct`)
    }
    throw new Error(`${p} validation failed: ${message}`)
  }

  applyConfig(p, normalizedKey, normalizedModel)
  writeStoredConfig({
    provider: p,
    apiKey: normalizedKey,
    model: normalizedModel,
    activatedAt: new Date().toISOString(),
  })

  return {
    provider: p,
    model: normalizedModel,
    models: pConfig.models,
  }
}

export function getActivationStatus() {
  const pConfig = config.provider && config.provider !== 'custom' ? PROVIDER_CONFIG[config.provider] : null
  const customModels = config.model ? [{ id: config.model, label: config.model, deprecated: false }] : DEEPSEEK_MODELS
  return {
    activated: !config.needsActivation,
    provider: config.provider,
    model: config.model,
    baseURL: config.provider === 'custom' ? config.baseURL : undefined,
    models: pConfig ? pConfig.models : customModels,
    defaultModel: pConfig ? pConfig.defaultModel : (config.model || DEFAULT_DEEPSEEK_MODEL),
  }
}

export function getProviderSummaries() {
  const result = Object.fromEntries(Object.entries(PROVIDER_CONFIG).map(([name, pConfig]) => [
    name,
    {
      label: pConfig.label || name,
      models: pConfig.models,
      defaultModel: pConfig.defaultModel,
    },
  ]))
  result.custom = { label: 'Custom Endpoint', models: [], defaultModel: '' }
  return result
}

export function deactivate() {
  try {
    if (fs.existsSync(paths.configFile)) fs.unlinkSync(paths.configFile)
  } catch {}
  config.provider = null
  config.model = null
  config.apiKey = null
  config.baseURL = null
  config.needsActivation = true
}

export function switchModel(model) {
  if (!config.apiKey) throw new Error('Not activated — cannot switch model')
  if (config.provider === 'custom') {
    const trimmed = String(model || '').trim()
    if (!trimmed) throw new Error('Model name cannot be empty')
    config.model = trimmed
    try {
      const existing = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))
      writeStoredConfig({ ...existing, model: trimmed })
    } catch {}
    return { provider: 'custom', model: trimmed }
  }
  const normalized = normalizeModel(model, config.provider)
  config.model = normalized
  try {
    const existing = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))
    writeStoredConfig({ ...existing, model: normalized })
  } catch {}
  return { provider: config.provider, model: normalized }
}

export function setTemperature(t) {
  const v = Math.min(2, Math.max(0, Number(t) || 0.5))
  config.temperature = v
  try {
    const existing = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))
    writeStoredConfig({ ...existing, temperature: v })
  } catch {}
  return { temperature: v }
}

export function getSecurity() {
  return {
    fileSandbox: config.security.fileSandbox,
    execSandbox: config.security.execSandbox,
    blockedTools: [...config.security.blockedTools],
  }
}

export function setSecurity(updates) {
  if (typeof updates.fileSandbox === 'boolean') config.security.fileSandbox = updates.fileSandbox
  if (typeof updates.execSandbox === 'boolean') config.security.execSandbox = updates.execSandbox
  if (Array.isArray(updates.blockedTools)) {
    config.security.blockedTools = updates.blockedTools.filter(t => typeof t === 'string')
  }
  try {
    const existing = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))
    writeStoredConfig({ ...existing, security: { ...config.security } })
  } catch {}
  return getSecurity()
}

export function getMinimaxKey() {
  try {
    const raw = fs.readFileSync(paths.configFile, 'utf-8')
    const parsed = JSON.parse(raw)
    return typeof parsed?.minimax_api_key === 'string' ? parsed.minimax_api_key : null
  } catch { return null }
}

export function setMinimaxKey(key) {
  const trimmed = String(key || '').trim()
  let existing = {}
  try { existing = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8')) } catch {}
  if (trimmed) {
    writeStoredConfig({ ...existing, minimax_api_key: trimmed })
  } else {
    const { minimax_api_key: _removed, ...rest } = existing
    writeStoredConfig(rest)
  }
}

// ── Social media platform config ──

const SOCIAL_ENV_KEYS = [
  'DISCORD_BOT_TOKEN',
  'FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_VERIFICATION_TOKEN',
  'WECHAT_OFFICIAL_APP_ID', 'WECHAT_OFFICIAL_APP_SECRET', 'WECHAT_OFFICIAL_TOKEN',
  'WECOM_BOT_KEY', 'WECOM_INCOMING_TOKEN',
]

// ── WeChat ClawBot credentials (written automatically after QR scan, not exposed in SOCIAL_ENV_KEYS) ──

export function getClawbotCredentials() {
  try {
    const stored = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))
    const c = stored?.clawbot
    return (c?.accountId && c?.botToken) ? c : null
  } catch { return null }
}

export function setClawbotCredentials({ accountId, botToken, baseUrl }) {
  let existing = {}
  try { existing = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8')) } catch {}
  writeStoredConfig({ ...existing, clawbot: { accountId, botToken, baseUrl } })
}

export function clearClawbotCredentials() {
  let existing = {}
  try { existing = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8')) } catch {}
  const { clawbot: _, ...rest } = existing
  writeStoredConfig(rest)
}

export function getSocialConfig() {
  let stored = {}
  try { stored = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))?.social || {} } catch {}
  const result = {}
  for (const key of SOCIAL_ENV_KEYS) {
    const val = stored[key] || globalThis.process?.env?.[key] || ''
    result[key] = { configured: !!val }
  }
  return result
}

export function setSocialConfig(updates) {
  let existing = {}
  try { existing = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8')) } catch {}
  const current = existing.social || {}
  const next = { ...current }
  for (const [key, val] of Object.entries(updates)) {
    if (!SOCIAL_ENV_KEYS.includes(key)) continue
    const trimmed = String(val || '').trim()
    if (trimmed) {
      next[key] = trimmed
      // Take effect immediately without restart
      if (globalThis.process?.env) globalThis.process.env[key] = trimmed
    } else {
      delete next[key]
    }
  }
  writeStoredConfig({ ...existing, social: next })
}

const VOICE_CONFIG_KEYS = ['aliyunApiKey', 'tencentSecretId', 'tencentSecretKey', 'tencentAppId', 'xunfeiAppId', 'xunfeiApiKey', 'xunfeiApiSecret']

function isValidAliyunAsrKey(value) {
  return /^sk-[A-Za-z0-9_\-.]{20,}$/.test(String(value || '').trim())
}

export function getVoiceConfig() {
  let stored = {}
  try { stored = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))?.voice || {} } catch {}
  const result = {}
  for (const key of VOICE_CONFIG_KEYS) {
    result[key] = { configured: !!(stored[key]) }
    if (key === 'aliyunApiKey' && stored[key]) {
      result[key] = {
        configured: isValidAliyunAsrKey(stored[key]),
        invalidFormat: !isValidAliyunAsrKey(stored[key]),
      }
    }
  }
  return result
}

export function setVoiceConfig(updates) {
  let existing = {}
  try { existing = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8')) } catch {}
  const current = existing.voice || {}
  const next = { ...current }
  for (const [key, val] of Object.entries(updates)) {
    if (!VOICE_CONFIG_KEYS.includes(key)) continue
    const trimmed = String(val || '').trim()
    if (key === 'aliyunApiKey' && trimmed && !isValidAliyunAsrKey(trimmed)) {
      console.warn('[voice-config] Ignoring invalid Aliyun ASR key format; expected DashScope sk-* API key')
      continue
    }
    if (trimmed) next[key] = trimmed
    else delete next[key]
  }
  writeStoredConfig({ ...existing, voice: next })
}

// TTS config
const TTS_CONFIG_KEYS = [
  'ttsProvider', 'ttsVoiceId',
  'minimaxKey',
  'doubaoKey', 'doubaoAppId', 'doubaoAccessKey', 'doubaoResourceId',
  'openaiTtsKey', 'openaiTtsBaseURL',
  'elevenLabsKey',
  'volcanoAppId', 'volcanoToken',
]

export function getTTSConfig() {
  let stored = {}
  try { stored = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))?.tts || {} } catch {}
  return {
    ttsProvider:     stored.ttsProvider  || 'doubao',
    ttsVoiceId:      stored.ttsVoiceId   || 'zh_female_xiaohe_uranus_bigtts',
    minimaxKey:      { configured: !!(stored.minimaxKey || process.env.MINIMAX_API_KEY || getMinimaxKey()) },
    doubaoKey:       { configured: !!(stored.doubaoKey) },
    doubaoAppId:     { configured: !!(stored.doubaoAppId), value: stored.doubaoAppId || '' },
    doubaoAccessKey: { configured: !!(stored.doubaoAccessKey) },
    doubaoResourceId: stored.doubaoResourceId || '',
    openaiTtsBaseURL: stored.openaiTtsBaseURL || '',
    openaiTtsKey:    { configured: !!(stored.openaiTtsKey) },
    elevenLabsKey:   { configured: !!(stored.elevenLabsKey) },
    volcanoAppId:    { configured: !!(stored.volcanoAppId), value: stored.volcanoAppId || '' },
    volcanoToken:    { configured: !!(stored.volcanoToken) },
  }
}

// Read plaintext TTS credentials (backend use only — not exposed to frontend)
export function getTTSCredentials() {
  let stored = {}
  try { stored = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))?.tts || {} } catch {}
  return {
    provider:       stored.ttsProvider  || 'doubao',
    voiceId:        stored.ttsVoiceId   || 'zh_female_xiaohe_uranus_bigtts',
    doubaoKey:      stored.doubaoKey    || process.env.DOUBAO_TTS_API_KEY || '',
    doubaoAppId:    stored.doubaoAppId  || process.env.DOUBAO_TTS_APP_ID || '',
    doubaoAccessKey: stored.doubaoAccessKey || process.env.DOUBAO_TTS_ACCESS_KEY || '',
    doubaoResourceId: stored.doubaoResourceId || process.env.DOUBAO_TTS_RESOURCE_ID || '',
    minimaxKey:     process.env.MINIMAX_API_KEY || stored.minimaxKey || getMinimaxKey() || (config.provider === 'minimax' ? config.apiKey : '') || '',
    openaiKey:      stored.openaiTtsKey  || '',
    openaiBaseURL:  stored.openaiTtsBaseURL || '',
    elevenLabsKey:  stored.elevenLabsKey || '',
    volcanoAppId:   stored.volcanoAppId  || '',
    volcanoToken:   stored.volcanoToken  || '',
  }
}

export function setTTSConfig(updates) {
  let existing = {}
  try { existing = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8')) } catch {}
  const current = existing.tts || {}
  const next = { ...current }
  for (const [key, val] of Object.entries(updates)) {
    if (!TTS_CONFIG_KEYS.includes(key)) continue
    const trimmed = String(val || '').trim()
    if (trimmed) next[key] = trimmed
    else delete next[key]
  }
  writeStoredConfig({ ...existing, tts: next })
}

// ── Embedding config ──────────────────────────────────────────────────────────
// Embedding 与 chat provider 完全独立。DeepSeek/Moonshot 没 embedding API，
// 所以必须分开存。结构：config.json 的 "embedding" 块。
//
// 字段：
//   provider:   'openai' | 'qwen' | 'zhipu' | 'minimax' | 'custom'
//   model:      模型名（参考 EMBEDDING_PROVIDER_PRESETS）
//   apiKey:     凭证（明文存储，与现有 chat apiKey 一样）
//   baseURL:    custom 时必填；其他 provider 留空走预设
//   dimensions: 可选，仅 OpenAI text-embedding-3-* 系列支持显式指定

const EMBEDDING_CONFIG_KEYS = ['provider', 'model', 'apiKey', 'baseURL', 'dimensions']

export const EMBEDDING_PROVIDER_PRESETS = {
  openai:  { baseURL: 'https://api.openai.com/v1',                          defaultModel: 'text-embedding-3-small', defaultDims: 1536 },
  qwen:    { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',  defaultModel: 'text-embedding-v2',      defaultDims: 1536 },
  zhipu:   { baseURL: 'https://open.bigmodel.cn/api/paas/v4',               defaultModel: 'embedding-3',            defaultDims: 2048 },
  minimax: { baseURL: 'https://api.minimax.chat/v1',                        defaultModel: 'embo-01',                defaultDims: 1536 },
  custom:  { baseURL: '',                                                   defaultModel: '',                       defaultDims: 1536 },
}

let _embeddingBlockCache = null
let _embeddingBlockCacheMtime = -1

function readEmbeddingBlock() {
  let mtime = -1
  try {
    mtime = fs.statSync(paths.configFile).mtimeMs
  } catch {
    // config 文件不存在或访问失败：直接返回 {}，不缓存（让下次有机会重试）
    return {}
  }

  if (_embeddingBlockCache !== null && mtime === _embeddingBlockCacheMtime) {
    return _embeddingBlockCache
  }

  let block = {}
  try {
    const raw = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))
    if (raw?.embedding && typeof raw.embedding === 'object') {
      block = raw.embedding
    }
  } catch {
    block = {}
  }

  _embeddingBlockCache = block
  _embeddingBlockCacheMtime = mtime
  return block
}

// 前端可见视图：不暴露 apiKey 明文，只暴露 configured 布尔
export function getEmbeddingConfig() {
  const stored = readEmbeddingBlock()
  const provider = typeof stored.provider === 'string' ? stored.provider : ''
  const model    = typeof stored.model === 'string'    ? stored.model    : ''
  const baseURL  = typeof stored.baseURL === 'string'  ? stored.baseURL  : ''
  const dimensions = Number.isFinite(stored.dimensions) ? stored.dimensions : null
  const configured = !!(stored.apiKey && model)
  return { provider, model, baseURL, dimensions, configured }
}

// Backend-only：读明文 apiKey。供 src/embedding.js 内部用，不要给前端。
export function getEmbeddingCredentials() {
  const stored = readEmbeddingBlock()
  const provider = typeof stored.provider === 'string' ? stored.provider : ''
  let baseURL = typeof stored.baseURL === 'string' && stored.baseURL ? stored.baseURL : ''
  if (!baseURL && provider && EMBEDDING_PROVIDER_PRESETS[provider]) {
    baseURL = EMBEDDING_PROVIDER_PRESETS[provider].baseURL || ''
  }
  return {
    provider,
    model:      typeof stored.model === 'string'  ? stored.model  : '',
    apiKey:     typeof stored.apiKey === 'string' ? stored.apiKey : '',
    baseURL,
    dimensions: Number.isFinite(stored.dimensions) ? stored.dimensions : null,
  }
}

export function setEmbeddingConfig(updates) {
  let existing = {}
  try { existing = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8')) } catch {}
  const current = existing.embedding || {}
  const next = { ...current }
  for (const [key, val] of Object.entries(updates || {})) {
    if (!EMBEDDING_CONFIG_KEYS.includes(key)) continue
    if (key === 'dimensions') {
      const n = Number(val)
      if (Number.isFinite(n) && n > 0) next.dimensions = n
      else delete next.dimensions
      continue
    }
    const trimmed = String(val || '').trim()
    if (trimmed) next[key] = trimmed
    else delete next[key]
  }
  writeStoredConfig({ ...existing, embedding: next })
}

// ── Web Search 配置 ──
// 顶级字段（与现有 serper_api_key 兼容），不嵌套到子块
// 字段：serper_api_key / searxng_url / jina_api_key
const WEB_SEARCH_KEY_MAP = {
  serperKey:  'serper_api_key',
  searxngUrl: 'searxng_url',
  jinaKey:    'jina_api_key',
}

function readWebSearchBlock() {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))
    return {
      serperKey:  typeof raw.serper_api_key === 'string' ? raw.serper_api_key : '',
      searxngUrl: typeof raw.searxng_url    === 'string' ? raw.searxng_url    : '',
      jinaKey:    typeof raw.jina_api_key   === 'string' ? raw.jina_api_key   : '',
    }
  } catch {
    return { serperKey: '', searxngUrl: '', jinaKey: '' }
  }
}

// 前端可见视图：不暴露 key 明文，只暴露 configured 布尔 + searxngUrl（URL 不算敏感）
// configured 同时考虑 env 兜底，避免"env 里有 key 但 UI 标未配置"的误导
// xxxFromEnv 提示来源，让 UI 标注"已配置（环境变量）"，并暗示清空输入框不会真正生效
export function getWebSearchConfig() {
  const stored = readWebSearchBlock()
  const envSerper  = process.env.SERPER_API_KEY || ''
  const envJina    = process.env.JINA_API_KEY   || ''
  const envSearxng = process.env.SEARXNG_URL    || ''
  return {
    serperConfigured: !!(stored.serperKey  || envSerper),
    jinaConfigured:   !!(stored.jinaKey    || envJina),
    // 输入框只回显 stored 值，避免用户以为能编辑 env 值
    searxngUrl:       stored.searxngUrl,
    // effective URL（含 env 兜底），UI 可显示在状态行
    effectiveSearxngUrl: stored.searxngUrl || envSearxng,
    serperFromEnv:    !stored.serperKey  && !!envSerper,
    jinaFromEnv:      !stored.jinaKey    && !!envJina,
    searxngFromEnv:   !stored.searxngUrl && !!envSearxng,
  }
}

// Backend-only：读明文 key。供 src/capabilities/executor.js 内部用，不要给前端
export function getWebSearchCredentials() {
  const stored = readWebSearchBlock()
  return {
    serperKey:  stored.serperKey  || process.env.SERPER_API_KEY || '',
    searxngUrl: stored.searxngUrl || process.env.SEARXNG_URL    || '',
    jinaKey:    stored.jinaKey    || process.env.JINA_API_KEY   || '',
  }
}

export function setWebSearchConfig(updates) {
  let existing = {}
  try { existing = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8')) } catch {}
  const next = { ...existing }
  for (const [key, val] of Object.entries(updates || {})) {
    const cfgField = WEB_SEARCH_KEY_MAP[key]
    if (!cfgField) continue
    const trimmed = String(val || '').trim()
    if (key === 'searxngUrl' && trimmed && !/^https?:\/\//i.test(trimmed)) {
      throw new Error('searxngUrl must start with http:// or https://')
    }
    if (trimmed) next[cfgField] = trimmed
    else delete next[cfgField]
  }
  writeStoredConfig(next)
}

export const __internals = {
  DEEPSEEK_MODELS,
  MINIMAX_MODELS,
  OPENAI_MODELS,
  QWEN_MODELS,
  MOONSHOT_MODELS,
  ZHIPU_MODELS,
  normalizeModel,
  isThinkingEnabledForModel,
  buildPingParams,
}
