// 用户发送 API Key 时自动识别服务商、验证、写入配置
// 支持 TTS（豆包、MiniMax、OpenAI、ElevenLabs、火山）和 ASR（阿里云、腾讯、讯飞）
// 支持单条消息包含多个 key（如"百炼语音识别 sk-xxx 豆包语音发声 uuid-xxx"）
import { setVoiceConfig, setTTSConfig } from './config.js'
import { streamTTS } from './voice/tts-providers.js'

// 提取文本中所有候选 key 字符串（20~120 字符的字母数字 token）
function extractCandidateKeys(text) {
  const seen = new Set()
  const results = []
  const re = /[A-Za-z0-9\-_\.]{20,120}/g
  let m
  while ((m = re.exec(text)) !== null) {
    if (!seen.has(m[0])) { seen.add(m[0]); results.push({ key: m[0], index: m.index }) }
  }
  return results
}

// 判断消息是否"纯 key"（整条消息几乎只有 key 本身）
function isKeyOnlyMessage(text) {
  return /^[\s\n]*[A-Za-z0-9\-_\.]{20,120}[\s\n]*$/.test(text)
}

function isValidAliyunAsrKey(key) {
  return /^sk-[A-Za-z0-9_\-.]{20,}$/.test(String(key || '').trim())
}

// 所有服务商的检测规则（按出现在消息中的关键词位置匹配）
const PROVIDER_RULES = [
  // TTS
  {
    re: /doubao|豆包|方舟|ark[\s_\-]?api|volcengine.*tts|tts.*volcengine/,
    service: 'tts', provider: 'doubao', label: '豆包 TTS',
    makeConfig: (key) => ({
      configUpdates: { ttsProvider: 'doubao', doubaoKey: key },
      streamKeys: { doubaoKey: key },
    }),
  },
  {
    re: /minimax|mini[\s_\-]?max/,
    skip: /asr|识别/,
    service: 'tts', provider: 'minimax', label: 'MiniMax TTS',
    makeConfig: (key) => ({
      configUpdates: { ttsProvider: 'minimax', minimaxKey: key },
      streamKeys: { minimaxKey: key },
    }),
  },
  {
    re: /eleven[\s_\-]?labs?|elevenlabs/,
    service: 'tts', provider: 'elevenlabs', label: 'ElevenLabs TTS',
    makeConfig: (key) => ({
      configUpdates: { ttsProvider: 'elevenlabs', elevenLabsKey: key },
      streamKeys: { elevenLabsKey: key },
    }),
  },
  {
    re: /(openai|open[\s_\-]?ai).*tts|tts.*(openai|open[\s_\-]?ai)/,
    service: 'tts', provider: 'openai', label: 'OpenAI TTS',
    makeConfig: (key) => ({
      configUpdates: { ttsProvider: 'openai', openaiTtsKey: key },
      streamKeys: { openaiKey: key },
    }),
  },
  {
    re: /volcano.*tts|tts.*volcano|火山.*(?:合成|语音)|(?:合成|语音).*火山/,
    service: 'tts', provider: 'volcano', label: '火山引擎 TTS',
    makeConfig: (key, key2) => ({
      configUpdates: { ttsProvider: 'volcano', volcanoToken: key, ...(key2 ? { volcanoAppId: key2 } : {}) },
      streamKeys: { volcanoToken: key, volcanoAppId: key2 || '' },
    }),
  },
  // ASR
  {
    re: /aliyun|阿里云|百炼|dashscope|paraformer/,
    service: 'asr', provider: 'aliyun', label: '阿里云 ASR',
    makeConfig: (key) => ({ configUpdates: { aliyunApiKey: key } }),
  },
  {
    re: /tencent|腾讯.*(?:asr|识别)|(?:asr|识别).*腾讯|secret[\s_\-]?id/,
    service: 'asr', provider: 'tencent', label: '腾讯云 ASR',
    makeConfig: (key, key2) => ({
      configUpdates: { tencentSecretId: key, ...(key2 ? { tencentSecretKey: key2 } : {}) },
    }),
  },
  {
    re: /xunfei|讯飞|iflytek/,
    service: 'asr', provider: 'xunfei', label: '讯飞 ASR',
    makeConfig: (key) => ({ configUpdates: { xunfeiApiKey: key } }),
  },
]

// 从文本中识别所有 {provider, key} 对
// 策略：找到每个服务商关键词的位置，取其后最近的候选 key
function detectAllKeyInfos(currentText, contextText) {
  const t = contextText.toLowerCase()
  const allKeys = extractCandidateKeys(contextText)
  if (allKeys.length === 0) return []

  const results = []
  const usedKeyIndices = new Set()

  for (const rule of PROVIDER_RULES) {
    if (!rule.re.test(t)) continue
    if (rule.skip && rule.skip.test(t)) continue

    // 找关键词在文本中的位置
    const match = rule.re.exec(t)
    const rulePos = match ? match.index : 0

    // 取关键词位置之后最近的未用 key
    const nearestKey = allKeys
      .filter((k, i) => !usedKeyIndices.has(i) && k.index >= rulePos)
      .sort((a, b) => a.index - b.index)[0]

    if (!nearestKey) continue

    const keyIdx = allKeys.indexOf(nearestKey)
    usedKeyIndices.add(keyIdx)

    // 对于需要两个 key 的（腾讯、火山），取下一个未用 key
    const nextKey = allKeys.filter((k, i) => !usedKeyIndices.has(i) && k.index > nearestKey.index)[0]
    const nextKeyIdx = nextKey ? allKeys.indexOf(nextKey) : -1
    const needsSecond = rule.provider === 'tencent' || rule.provider === 'volcano'
    if (needsSecond && nextKey) usedKeyIndices.add(nextKeyIdx)

    const config = rule.makeConfig(nearestKey.key, needsSecond && nextKey ? nextKey.key : undefined)
    results.push({ service: rule.service, provider: rule.provider, label: rule.label, ...config })
  }

  // 无关键词时：格式推断（只在当前消息里找 key）
  if (results.length === 0) {
    const currentKeys = extractCandidateKeys(currentText)
    if (currentKeys.length === 0) return []
    const key = currentKeys[0].key

    if (key.startsWith('eyJ')) {
      results.push({
        service: 'tts', provider: 'minimax', label: 'MiniMax TTS',
        configUpdates: { ttsProvider: 'minimax', minimaxKey: key },
        streamKeys: { minimaxKey: key },
      })
    } else if (key.startsWith('AKID')) {
      results.push({
        service: 'asr', provider: 'tencent', label: '腾讯云 ASR',
        configUpdates: { tencentSecretId: key },
      })
    } else if (key.startsWith('sk-') && isKeyOnlyMessage(currentText)) {
      // sk- 纯 key 消息：尝试 OpenAI TTS，失败则静默跳过
      results.push({
        service: 'tts', provider: 'openai', label: 'OpenAI TTS',
        configUpdates: { ttsProvider: 'openai', openaiTtsKey: key },
        streamKeys: { openaiKey: key },
        tryOnly: true,
      })
    }
  }

  // 宽泛语音上下文（有"配置语音/tts/合成"但无具体服务商）
  if (results.length === 0 && /配置语音|语音配置|语音合成|设置语音|tts[\s_\-]?key|语音.*key|key.*语音/.test(t)) {
    const currentKeys = extractCandidateKeys(currentText)
    if (currentKeys.length === 0) return []
    const key = currentKeys[0].key
    if (key.startsWith('eyJ')) {
      results.push({
        service: 'tts', provider: 'minimax', label: 'MiniMax TTS',
        configUpdates: { ttsProvider: 'minimax', minimaxKey: key },
        streamKeys: { minimaxKey: key },
      })
    } else {
      results.push({
        service: 'tts', provider: 'openai', label: 'OpenAI TTS',
        configUpdates: { ttsProvider: 'openai', openaiTtsKey: key },
        streamKeys: { openaiKey: key },
        tryOnly: true,
      })
    }
  }

  return results
}

// 测试 TTS key：用短文本合成，收到任意音频数据即视为成功
async function testTTSKey(provider, streamKeys) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: '连接超时（10 秒）' }), 10000)

    streamTTS({ text: '语音', provider, keys: streamKeys })
      .then(stream => {
        let gotData = false
        stream.on('data', () => {
          if (gotData) return
          gotData = true
          clearTimeout(timer)
          resolve({ ok: true })
          stream.destroy()
        })
        stream.on('error', err => {
          if (gotData) return
          clearTimeout(timer)
          resolve({ ok: false, error: err.message })
        })
        stream.on('end', () => {
          if (gotData) return
          clearTimeout(timer)
          resolve({ ok: false, error: '合成返回空音频' })
        })
      })
      .catch(err => {
        clearTimeout(timer)
        resolve({ ok: false, error: err.message })
      })
  })
}

// 主入口：检测并处理消息中的所有 API Key
// 返回：
//   { ok: true, results: [...] }  — 至少一个 key 配置成功，应静默处理（删消息、跳 LLM）
//   { ok: false, error: '...' }   — 识别到 key 但全部验证失败，应让 LLM 告知用户
//   null                           — 未识别到任何 key，正常流程
export async function tryAutoConfigureKey(text, recentContext = '') {
  const contextText = recentContext ? `${recentContext} ${text}` : text
  const infos = detectAllKeyInfos(text, contextText)
  if (infos.length === 0) return null

  let anySuccess = false
  let hasTTS = false
  const failErrors = []

  // 并行处理 ASR（无需测试），串行/并行处理 TTS（需要测试）
  const asrInfos = infos.filter(i => i.service === 'asr')
  const ttsInfos = infos.filter(i => i.service === 'tts')

  // ASR：直接配置
  const asrUpdates = {}
  for (const info of asrInfos) {
    if (info.provider === 'aliyun' && !isValidAliyunAsrKey(info.configUpdates?.aliyunApiKey)) {
      failErrors.push('阿里云 ASR: 请使用百炼/DashScope API Key（sk- 开头），不要使用 AccessKey ID/Secret 或实例 ID')
      continue
    }
    Object.assign(asrUpdates, info.configUpdates)
    anySuccess = true
  }
  if (Object.keys(asrUpdates).length > 0) setVoiceConfig(asrUpdates)

  // TTS：逐个测试，取第一个成功的作为当前 TTS provider
  for (const info of ttsInfos) {
    const testResult = await testTTSKey(info.provider, info.streamKeys)
    if (testResult.ok) {
      setTTSConfig(info.configUpdates)
      hasTTS = true
      anySuccess = true
    } else {
      if (!info.tryOnly) failErrors.push(`${info.label}: ${testResult.error}`)
    }
  }

  if (anySuccess) {
    return { ok: true, hasTTS }
  }

  // 全部失败且有非 tryOnly 的失败
  if (failErrors.length > 0) {
    return { ok: false, error: failErrors.join('；') }
  }

  // 全是 tryOnly 且全部失败 → 静默跳过
  return null
}
