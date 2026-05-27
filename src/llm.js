import OpenAI from 'openai'
import { config } from './config.js'
import { executeTool } from './capabilities/executor.js'
import { getToolSchemas } from './capabilities/schemas.js'
import { recordUsage, shouldThrottle } from './quota.js'
import { insertActionLog } from './db.js'

// 延迟创建 OpenAI 客户端：激活流程把 key 写入 config 后再调用这里，
// 避免模块加载阶段就锁死尚未填入的 apiKey/baseURL。
let client = null
let clientKey = null
function getClient() {
  const signature = `${config.provider}|${config.baseURL}|${config.apiKey}`
  if (client && clientKey === signature) return client
  if (!config.apiKey) {
    throw new Error('LLM 尚未激活，请先通过激活页填入 API Key')
  }
  client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL })
  clientKey = signature
  return client
}

function shouldEnableDeepSeekThinking(thinking) {
  if (!thinking) return false
  if (config.model === 'deepseek-chat') return false
  return true
}

// 单次流式调用，返回 { content, toolCalls, aborted }
async function streamOnce({ messages, toolSchemas, temperature, topP, maxTokens, thinking = true, signal, onStream }) {
  const requestParams = {
    model: config.model,
    temperature,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }

  if (typeof topP === 'number' && topP > 0) requestParams.top_p = topP
  if (config.provider === 'deepseek') {
    const thinkingEnabled = shouldEnableDeepSeekThinking(thinking)
    if (thinkingEnabled) {
      requestParams.reasoning_effort = 'high'
      requestParams.thinking = { type: 'enabled' }
    } else {
      // DeepSeek 拒绝 reasoning_effort 与 thinking.type='disabled' 组合
      requestParams.thinking = { type: 'disabled' }
    }
  } else {
    if (!thinking) requestParams.thinking = { type: 'disabled' }
  }
  if (maxTokens) requestParams.max_tokens = maxTokens
  if (toolSchemas.length > 0) {
    requestParams.tools = toolSchemas
    requestParams.tool_choice = 'auto'
  }

  const stream = await getClient().chat.completions.create(requestParams, { signal })

  let fullContent = ''
  let fullReasoningContent = ''
  let toolCallsMap = {}
  let inThink = false
  let thinkDone = false
  let streamStarted = false
  let usageTokens = 0
  let cacheHitTokens = 0
  let cacheMissTokens = 0

  try {
  for await (const chunk of stream) {
    if (signal?.aborted) break
    if (chunk.usage?.total_tokens) {
      usageTokens = chunk.usage.total_tokens
      cacheHitTokens = chunk.usage.prompt_cache_hit_tokens || 0
      cacheMissTokens = chunk.usage.prompt_cache_miss_tokens || 0
    }
    const choice = chunk.choices?.[0]
    if (!choice) continue

    const delta = choice.delta

    // 工具调用增量
    if (delta?.tool_calls) {
      if (streamStarted) {
        onStream?.({ event: 'end' })
        streamStarted = false
      }
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0
        if (!toolCallsMap[idx]) {
          toolCallsMap[idx] = { id: tc.id || '', name: '', arguments: '' }
        }
        if (tc.id) toolCallsMap[idx].id = tc.id
        if (tc.function?.name) {
          const wasEmpty = toolCallsMap[idx].name === ''
          toolCallsMap[idx].name += tc.function.name
          // 第一次拿到完整 name 时通知上层 —— 此时流文本已 end，但工具尚未执行，
          // 没有这个信号 UI 会出现"思考动画停止 → 工具行出现"之间的死寂。
          if (wasEmpty && toolCallsMap[idx].name) {
            onStream?.({ event: 'tool_preparing', name: toolCallsMap[idx].name })
          }
        }
        if (tc.function?.arguments) toolCallsMap[idx].arguments += tc.function.arguments
      }
      continue
    }

    // DeepSeek reasoner 思考内容（独立字段，不在 content 里）
    const reasoningText = delta?.reasoning_content
    if (reasoningText) {
      fullReasoningContent += reasoningText
      if (!thinkDone) {
        inThink = true
        if (!streamStarted) { onStream?.({ event: 'start', mode: 'think' }); streamStarted = true }
        onStream?.({ event: 'chunk', text: reasoningText })
      }
      continue
    }

    // 文本增量
    const text = delta?.content
    if (!text) continue

    // DeepSeek：思考流结束、进入正式回答时，先关闭 think 流
    if (inThink && !thinkDone) {
      inThink = false
      thinkDone = true
      if (streamStarted) { onStream?.({ event: 'end' }); streamStarted = false }
    }

    fullContent += text

    // 解析 <think> 标签流式推送
    if (!thinkDone) {
      if (!inThink && fullContent.includes('<think>')) {
        inThink = true
        const after = fullContent.split('<think>').slice(1).join('<think>')
        if (after.length > 0) {
          if (!streamStarted) { onStream?.({ event: 'start', mode: 'think' }); streamStarted = true }
          onStream?.({ event: 'chunk', text: after })
        }
        continue
      }
      if (inThink) {
        if (fullContent.includes('</think>')) {
          inThink = false
          thinkDone = true
          const chunkBeforeEnd = text.split('</think>')[0]
          if (chunkBeforeEnd) onStream?.({ event: 'chunk', text: chunkBeforeEnd })
          onStream?.({ event: 'end' })
          streamStarted = false
          const afterThink = fullContent.split('</think>').slice(1).join('</think>').trimStart()
          if (afterThink) {
            onStream?.({ event: 'start', mode: 'text' }); streamStarted = true
            onStream?.({ event: 'chunk', text: afterThink })
          }
        } else {
          if (!streamStarted) { onStream?.({ event: 'start', mode: 'think' }); streamStarted = true }
          onStream?.({ event: 'chunk', text })
        }
        continue
      }
    }

    if (!streamStarted) { onStream?.({ event: 'start', mode: 'text' }); streamStarted = true }
    onStream?.({ event: 'chunk', text })
  }

  } catch (err) {
    if (err.name === 'AbortError' || signal?.aborted) {
      if (streamStarted) onStream?.({ event: 'end' })
      return {
        content: fullContent,
        reasoningContent: fullReasoningContent,
        toolCalls: Object.values(toolCallsMap),
        aborted: true
      }
    }
    err.hadContent = fullContent.length > 0
    if (streamStarted) onStream?.({ event: 'end' })
    throw err
  }

  if (streamStarted) onStream?.({ event: 'end' })
  if (usageTokens > 0) {
    recordUsage(usageTokens)
    const promptTotal = cacheHitTokens + cacheMissTokens
    const cacheStr = promptTotal > 0
      ? ` (prompt cache: ${cacheHitTokens}/${promptTotal} = ${(cacheHitTokens/promptTotal*100).toFixed(1)}%)`
      : ''
    console.log(`[配额] 本轮 tokens: ${usageTokens}${cacheStr}`)
  }

  return {
    content: fullContent,
    reasoningContent: fullReasoningContent,
    toolCalls: Object.values(toolCallsMap),
    aborted: false
  }
}

// 判断是否为瞬时错误（5xx / 网络抖动 / 超时），429 交给外层 setRateLimited
function isTransientError(err) {
  const status = err.status ?? err.response?.status
  if (status && status >= 500 && status < 600) return true
  if (status === 408) return true
  const code = err.code || err.cause?.code
  if (code && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE'].includes(code)) return true
  const msg = err.message || ''
  return /timeout|timed out|socket hang up|fetch failed|network error|upstream/i.test(msg)
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
    const timer = setTimeout(resolve, ms)
    const onAbort = () => { clearTimeout(timer); reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// 包装 streamOnce：对瞬时错误做有限次退避重试；已流出内容时不重试避免 UI 重复
async function streamOnceWithRetry(args) {
  const BACKOFFS_MS = [800, 2500]
  const MAX_ATTEMPTS = BACKOFFS_MS.length + 1
  let lastErr
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (args.signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
    try {
      return await streamOnce(args)
    } catch (err) {
      if (err.name === 'AbortError' || args.signal?.aborted) throw err
      if (err.hadContent) throw err
      if (!isTransientError(err)) throw err
      lastErr = err
      if (attempt < MAX_ATTEMPTS - 1) {
        const delay = BACKOFFS_MS[attempt]
        args.onRetry?.({
          attempt: attempt + 1,
          nextAttempt: attempt + 2,
          maxAttempts: MAX_ATTEMPTS,
          delayMs: delay,
          error: err.message || String(err),
        })
        console.warn(`[LLM] 瞬时错误 "${(err.message || '').slice(0, 80)}"，${delay}ms 后第 ${attempt + 2} 次尝试`)
        await abortableSleep(delay, args.signal)
      }
    }
  }
  throw lastErr
}

// XML 格式工具调用的参数名别名映射（某些模型使用不同参数名）
const PARAM_ALIASES = {
  send_message: { to: 'target_id', message: 'content', text: 'content', recipient: 'target_id' },
  read_file: { file: 'path', filename: 'path', filepath: 'path' },
  write_file: { file: 'path', filename: 'path', filepath: 'path', text: 'content', data: 'content' },
  list_dir: { directory: 'path', dir: 'path', folder: 'path' },
  make_dir: { directory: 'path', dir: 'path', folder: 'path' },
  delete_file: { file: 'path', filename: 'path' },
  exec_command: { cmd: 'command', shell: 'command', bg: 'background' },
  web_search: { q: 'query', keyword: 'query', keywords: 'query', search: 'query' },
  fetch_url: { link: 'url', href: 'url', uri: 'url' },
  browser_read: { link: 'url', href: 'url', uri: 'url' },
  search_memory: { q: 'keyword', query: 'keyword', term: 'keyword' },
}

function normalizeArgs(toolName, args) {
  const aliases = PARAM_ALIASES[toolName]
  if (!aliases) return args
  const normalized = { ...args }
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (alias in normalized && !(canonical in normalized)) {
      normalized[canonical] = normalized[alias]
      delete normalized[alias]
    }
  }
  return normalized
}

// 从文本内容中解析 XML 格式的工具调用（MiniMax 有时输出 XML 而非 JSON tool_calls）
function parseXmlToolCalls(content) {
  const calls = []
  const invokeRegex = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/g
  let match
  while ((match = invokeRegex.exec(content)) !== null) {
    const name = match[1]
    const body = match[2]
    const xmlArgs = {}
    const paramRegex = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g
    let param
    while ((param = paramRegex.exec(body)) !== null) {
      xmlArgs[param[1]] = param[2].trim()
    }
    calls.push({ id: `xml_${calls.length}`, name, arguments: JSON.stringify(xmlArgs), xmlArgs })
  }
  return calls
}


function formatToolArgPreview(args = {}) {
  return Object.entries(args)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .slice(0, 3)
    .map(([key, value]) => `${key}=${String(value).slice(0, 80)}`)
    .join(', ')
}

function summarizeToolCall(name, args = {}) {
  switch (name) {
    case 'send_message':
      return `send_message -> ${args.target_id || '(unknown)'}`
    case 'read_file':
      return `read_file(${args.path || args.filename || args.file_path || '?'})`
    case 'list_dir':
      return `list_dir(${args.path || args.dir || args.directory || '.'})`
    case 'web_search':
      return `web_search(${String(args.query || args.q || args.keyword || '?').slice(0, 80)})`
    case 'fetch_url':
      return `fetch_url(${String(args.url || args.link || args.href || '?').slice(0, 80)})`
    case 'browser_read':
      return `browser_read(${String(args.url || args.link || args.href || '?').slice(0, 80)})`
    case 'search_memory': {
      if (Array.isArray(args.keywords)) {
        return `search_memory([${args.keywords.slice(0, 4).map(k => String(k).slice(0, 20)).join(', ')}])`
      }
      return `search_memory(${String(args.keyword || args.query || args.q || '?').slice(0, 60)})`
    }
    case 'upsert_memory': {
      const n = Array.isArray(args.memories) ? args.memories.length : 0
      const ids = (args.memories || []).slice(0, 3).map(m => m?.mem_id || '?').join(', ')
      return `upsert_memory(${n} 条: ${ids}${n > 3 ? '…' : ''})`
    }
    case 'skip_recognition':
      return `skip_recognition(${String(args.reason || '').slice(0, 40)})`
    case 'manage_reminder':
    case 'schedule_reminder': {
      const action = args.action || 'create'
      if (action === 'list') return 'manage_reminder(list)'
      if (action === 'cancel') return `manage_reminder(cancel #${args.id || '?'})`
      const kind = args.kind || 'once'
      const when = kind === 'once' ? (args.due_at || '?') : `${kind} ${args.time || '?'}`
      return `manage_reminder(create ${when}: ${String(args.task || '?').slice(0, 30)})`
    }
    case 'write_file':
      return `write_file(${args.path || args.filename || args.file_path || '?'})`
    case 'delete_file':
      return `delete_file(${args.path || args.filename || args.file_path || '?'})`
    case 'make_dir':
      return `make_dir(${args.path || args.dir || args.directory || '?'})`
    case 'exec_command':
      return `exec_command(${String(args.command || args.cmd || '?').slice(0, 80)})`
    default: {
      const preview = formatToolArgPreview(args)
      return preview ? `${name}(${preview})` : name
    }
  }
}

function buildToolLogDetail(args = {}, result = '') {
  const argPreview = formatToolArgPreview(args)
  const resultPreview = String(result || '').replace(/\s+/g, ' ').trim().slice(0, 180)
  if (argPreview && resultPreview) return `${argPreview} | ${resultPreview}`
  return argPreview || resultPreview
}

function shouldPersistActionLog(toolName) {
  return false
}

const TOOL_LOOP_LIMITS = {
  maxRounds: 100,
  maxTotalCalls: 30,
  maxConsecutiveFailures: 3,
  maxSameFailures: 2,
  loopWindowSize: 8,
  loopUniqueThreshold: 2,
}

const HIGH_RISK_TOOLS = new Set([
  'delete_file',
  'exec_command',
  'kill_process',
  'web_search',
  'fetch_url',
  'browser_read',
  'speak',
  'generate_lyrics',
  'generate_music',
  'generate_image',
  'ui_register',
])

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function buildToolFingerprint(name, args = {}) {
  return `${name}:${stableStringify(args || {})}`
}

function isHighRiskTool(name) {
  return HIGH_RISK_TOOLS.has(name)
}

const PARALLEL_SAFE_TOOLS = new Set([
  'read_file',
  'list_dir',
  'web_search',
  'fetch_url',
  'browser_read',
  'search_memory',
  'list_processes',
])

function isParallelSafeTool(name, args = {}) {
  if (PARALLEL_SAFE_TOOLS.has(name)) return true
  if (name === 'manage_reminder') return args.action === 'list'
  if (name === 'manage_prefetch_task') return args.action === 'list'
  return false
}

function isToolFailure(result) {
  const text = String(result || '').trim()
  if (!text) return false
  try {
    const parsed = JSON.parse(text)
    if (parsed?.ok === false) return true
    if (parsed?.error && parsed.ok !== true) return true
    return false
  } catch {}
  return /^(错误|请求失败|执行失败|命令超时|命令执行失败|閿欒|璇锋眰澶辫触|鎵ц澶辫触|鍛戒护瓒呮椂|鍛戒护鎵ц澶辫触)/.test(text)
}

function createToolLoopState() {
  return {
    totalCalls: 0,
    consecutiveFailures: 0,
    sameFailureCounts: new Map(),
    recentFingerprints: [],
  }
}

// send_message/express 是 agent 向用户"汇报 blocker"的唯一通道，必须绕开跨工具的全局熔断计数。
// 否则当 exec_command/fetch_url 等连续失败触发熔断后，agent 想 send_message 解释失败也会被一并挡掉，
// 出现"工具调不动 + 嘴也被堵住"的死锁（lessons-bailongma-silent-exit 的镜像问题）。
// 同指纹反复失败仍由 sameFailureCounts / recentFingerprints 拦截，安全网完好。
const REPORT_CHANNEL_TOOLS = new Set(['send_message', 'express'])

function getToolLoopStopReason(state, name, fingerprint) {
  const isReportChannel = REPORT_CHANNEL_TOOLS.has(name)
  if (!isReportChannel && state.consecutiveFailures >= TOOL_LOOP_LIMITS.maxConsecutiveFailures) {
    return `too many consecutive tool failures (${TOOL_LOOP_LIMITS.maxConsecutiveFailures})`
  }
  const sameFailures = state.sameFailureCounts.get(fingerprint) || 0
  if (sameFailures >= TOOL_LOOP_LIMITS.maxSameFailures) {
    return `same failing action repeated ${sameFailures} times`
  }
  const window = state.recentFingerprints.slice(-TOOL_LOOP_LIMITS.loopWindowSize)
  if (!isReportChannel && window.length >= TOOL_LOOP_LIMITS.loopWindowSize) {
    const unique = new Set(window).size
    if (unique <= TOOL_LOOP_LIMITS.loopUniqueThreshold) {
      return `stuck in a loop (only ${unique} unique action(s) in last ${TOOL_LOOP_LIMITS.loopWindowSize} calls)`
    }
  }
  return null
}

function makeToolLoopStoppedResult(name, reason) {
  return JSON.stringify({
    ok: false,
    tool: name,
    error: 'tool loop stopped',
    reason,
    hint: 'Stop retrying this action. Explain the blocker, ask for confirmation, or choose a materially different approach.',
  }, null, 2)
}

function recordToolLoopOutcome(state, name, fingerprint, result) {
  state.totalCalls += 1
  state.recentFingerprints.push(fingerprint)

  if (isToolFailure(result)) {
    state.consecutiveFailures += 1
    state.sameFailureCounts.set(fingerprint, (state.sameFailureCounts.get(fingerprint) || 0) + 1)
  } else {
    state.consecutiveFailures = 0
    state.sameFailureCounts.delete(fingerprint)
  }
}

function buildToolLoopStopNudge(reason, lastToolResult) {
  const lastSummary = lastToolResult
    ? `${lastToolResult.name}(${formatToolArgPreview(lastToolResult.args || {})}) -> ${String(lastToolResult.result || '').slice(0, 300)}`
    : 'No successful tool result is available.'
  return `Tool loop safety stop: ${reason}.\nLast tool result:\n${lastSummary}\n\nDo not keep retrying the same tool action. If enough information is available, call send_message and explain the outcome. If the task needs user confirmation or a different input, call send_message and ask clearly.`
}

function requiresToolForRequest(text = '') {
  const input = String(text || '')
  const fileIntent = /(sandbox|文件|目录|创建|新建|写入|读取|删除|列出|保存|test-\d+|\.txt|\.json|\.md|\.js|\.html|\.css)/i.test(input)
    && /(创建|新建|写入|读取|删除|列出|保存|改|修改|生成|create|write|read|delete|list|save)/i.test(input)
  const commandIntent = /(执行命令|运行命令|跑命令|exec|command|npm|node|git|powershell|cmd)/i.test(input)
  const webIntent = /(打开网页|抓取|联网|搜索|查询最新|fetch|url|https?:\/\/)/i.test(input)
  return fileIntent || commandIntent || webIntent
}

function buildMissingToolNudge(userMessage = '') {
  return `The user's request requires a real tool call, not a textual claim. Do not say it is done unless the tool result proves it.\nUser request:\n${String(userMessage || '').slice(0, 600)}\n\nCall the appropriate tool now. For sandbox file creation or editing, call write_file with the exact path and content, then call send_message after the write_file result returns.`
}

// 检测模型是否在文字中"描述"了工具调用而没有真正调用
// 返回检测到的规范工具名，或 null
function detectFakeToolCall(content, toolNames) {
  if (!content || !toolNames.length) return null

  // 去掉下划线后做模糊匹配（处理模型写成 settickinterval 而非 set_tick_interval 的情况）
  const normalizedContent = content.toLowerCase().replace(/[_\s]/g, '')
  for (const name of toolNames) {
    if (name.length < 5) continue  // 太短的名字容易误判
    if (normalizedContent.includes(name.toLowerCase().replace(/_/g, ''))) {
      return name
    }
  }

  // 检测中文动作括号伪调用，如 [心跳启动中] [调用成功] [执行中]
  if (/[\[【][^\]】]{2,20}(中|完成|成功|ing)[\]】]/.test(content)) {
    return '(action claim)'
  }

  return null
}

function buildFakeToolCallNudge(toolName, toolSchemas = []) {
  const isGeneric = toolName === '(action claim)'
  const header = isGeneric
    ? 'You wrote a bracketed action description (e.g. [xxx中]) but did not call any tool.'
    : `Your reply mentioned the tool "${toolName}" in text but did not invoke it through the function-call mechanism.`

  let schemaHint = ''
  if (!isGeneric) {
    const schema = toolSchemas.find(s => s?.function?.name === toolName)
    if (schema) {
      const props = schema.function?.parameters?.properties || {}
      const required = schema.function?.parameters?.required || []
      const paramList = Object.entries(props)
        .map(([k, v]) => `${required.includes(k) ? k + '*' : k} (${v.type || 'any'})`)
        .join(', ')
      if (paramList) schemaHint = `\nRequired call format: ${toolName}({ ${paramList} })  (* = required)`
    }
  }

  return `${header} Writing text about what a tool does has no effect on the system — the action did not happen.\n\nYou must now invoke the tool using the function-call interface, not describe it in prose.${schemaHint}`
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return
  const err = new Error(signal.reason || 'Aborted')
  err.name = 'AbortError'
  throw err
}

// 主调用：agentic 循环，连续执行工具直到模型停止
// 返回 { content: string, toolResult: { name, args, result } | null, aborted: bool }
export async function callLLM({ systemPrompt, message, messages: inputMessages = null, temperature = 0.5, topP = 0.9, tools = [], maxTokens, thinking = true, signal, onToolCall, onToolExecute, onStream, onRetry, toolContext = {}, mustReply = false }) {
  const toolSchemas = getToolSchemas(tools)

  const messages = Array.isArray(inputMessages) && inputMessages.length > 0
    ? inputMessages.map(item => ({ ...item }))
    : [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ]

  if (shouldThrottle()) {
    console.log('[配额] 用量超过 95%，跳过本次调用')
    return { content: '（配额接近上限，等待窗口滚动）', toolResult: null, aborted: false }
  }

  let allContent = ''
  let lastToolResult = null
  let sawToolCall = false
  let sentMessage = false
  let finalNudgeUsed = false
  let missingToolNudgeUsed = false
  let fakeToolNudgeUsed = false
  const toolLoopState = createToolLoopState()

  for (let round = 0; round < TOOL_LOOP_LIMITS.maxRounds; round++) {
    throwIfAborted(signal)

    const { content, reasoningContent, toolCalls, aborted } = await streamOnceWithRetry({
      messages,
      toolSchemas,
      temperature,
      topP,
      maxTokens,
      thinking,
      signal,
      onRetry,
      onStream,  // 所有轮次均流式推送，让 UI 实时反映工具链执行过程中的模型输出
    })

    if (aborted) {
      if (content) allContent += (allContent ? '\n' : '') + content
      break
    }

    if (content) allContent += (allContent ? '\n' : '') + content

    // 若无 JSON 工具调用，尝试从内容中解析 XML 格式工具调用（MiniMax 备用格式）
    let effectiveToolCalls = toolCalls
    if (toolCalls.length === 0 && content) {
      const xmlCalls = parseXmlToolCalls(content)
      if (xmlCalls.length > 0) {
        console.log(`[工具调用] 检测到 XML 格式工具调用，共 ${xmlCalls.length} 个`)
        effectiveToolCalls = xmlCalls
        // 从 allContent 中去掉 XML 调用块，避免污染 response
        allContent = allContent.replace(/<invoke[\s\S]*?<\/invoke>/g, '').trim()
      }
    }

    // 无工具调用：本轮结束；若工具后空回复，再补一轮明确的最终回复指令。
    if (effectiveToolCalls.length === 0) {
      if (!sawToolCall && requiresToolForRequest(message) && !missingToolNudgeUsed) {
        allContent = ''
        messages.push({
          role: 'user',
          content: buildMissingToolNudge(message),
        })
        missingToolNudgeUsed = true
        continue
      }
      // 检测伪工具调用：模型在文字里描述了调用但没有真正发起 function-call
      if (!fakeToolNudgeUsed && content) {
        const fakeToolName = detectFakeToolCall(content, tools)
        if (fakeToolName) {
          console.log(`[伪调用检测] 模型文字中发现 "${fakeToolName}"，注入修正 nudge`)
          messages.push({ role: 'assistant', content })
          messages.push({ role: 'user', content: buildFakeToolCallNudge(fakeToolName, toolSchemas) })
          allContent = ''
          fakeToolNudgeUsed = true
          continue
        }
      }
      // 安全网：工具已结束、最近一次工具不是 send_message、且模型本轮也没继续动作。
      // 不再用 !allContent.trim() 做守卫——跨轮累积的旁白会让这个守卫错误地静默 break，
      // 真正可靠的信号是 sentMessage（line 691 在每个工具后维护）。
      if (mustReply && sawToolCall && !sentMessage && !finalNudgeUsed) {
        messages.push({
          role: 'user',
          content: 'Tool results have returned, but you have not sent the user a final reply yet. Based on the available tool results, call send_message now to reply to the user. If information is insufficient, explain what was found, the failure source, and the limitations; do not end silently.',
        })
        finalNudgeUsed = true
        continue
      }
      break
    }
    sawToolCall = true

    // 为没有 id 的工具调用分配 id（保证 assistant 消息与 tool 消息 id 一致）
    effectiveToolCalls.forEach((tc, i) => { if (!tc.id) tc.id = `tool_${round}_${i}` })

    // 执行所有工具调用，收集结果。
    // 同一轮中连续的只读/查询类工具互不依赖，可以并发跑；有副作用的工具仍保持顺序。
    const toolResults = []
    let toolLoopStopReason = null
    const prepareToolCall = (tc) => {
      throwIfAborted(signal)
      let args
      try { args = JSON.parse(tc.arguments || '{}') } catch { args = {} }
      const hadEmptyArguments = !tc.arguments || tc.arguments === '{}'
      const normalizedArgs = normalizeArgs(tc.name, args)
      const fingerprint = buildToolFingerprint(tc.name, normalizedArgs)
      const stopReason = getToolLoopStopReason(toolLoopState, tc.name, fingerprint)
      return { tc, normalizedArgs, fingerprint, stopReason, hadEmptyArguments }
    }

    const runPreparedToolCall = async ({ tc, normalizedArgs, fingerprint, stopReason, hadEmptyArguments }) => {
      console.log(`[工具调用] ${tc.name}`)
      if (hadEmptyArguments) {
        console.log(`[工具警告] ${tc.name} 参数为空`)
      }
      let result
      if (stopReason) {
        result = makeToolLoopStoppedResult(tc.name, stopReason)
        console.log(`[工具熔断] ${tc.name}: ${stopReason}`)
        // 熔断信号已经回传给模型，重置跨工具的全局连续失败计数，让 agent 有机会切换到完全不同的工具
        // （比如换 read_file 查日志、search_memory 找历史经验）。同指纹反复失败仍由 sameFailureCounts
        // 拦截，跨工具死循环仍由 recentFingerprints 的 unique threshold 拦截——安全网未失效。
        toolLoopState.consecutiveFailures = 0
      } else {
        // 真正开始执行前通知 UI —— 让用户知道当前停留在哪一步的工具上
        onToolExecute?.(tc.name, normalizedArgs)
        result = await executeTool(tc.name, normalizedArgs, { ...toolContext, signal })
        recordToolLoopOutcome(toolLoopState, tc.name, fingerprint, result)
      }
      throwIfAborted(signal)
      // sentMessage 语义：最近一次工具动作是否就是 send_message。
      // 任何非 send_message 工具都把它清掉——意味着模型在 send_message 之后又做了新工作，
      // 那之前那次 send_message 只是过场（"好，我去看看…"），还欠用户一次最终回复。
      // 这样 line ~641 的"沉默退出 nudge"才能在该补刀时正确触发。
      if (tc.name === 'send_message') sentMessage = true
      else sentMessage = false
      if (shouldPersistActionLog(tc.name)) {
        insertActionLog({
          timestamp: new Date().toISOString(),
          tool: tc.name,
          summary: summarizeToolCall(tc.name, normalizedArgs),
          detail: buildToolLogDetail(normalizedArgs, result),
        })
      }
      console.log(`[工具结果] ${tc.name}: ${result.slice(0, 100)}`)
      if (onToolCall) onToolCall(tc.name, normalizedArgs, result)
      lastToolResult = { name: tc.name, args: normalizedArgs, result }
      return { id: tc.id, name: tc.name, args: normalizedArgs, result, stopReason }
    }

    for (let callIndex = 0; callIndex < effectiveToolCalls.length;) {
      const firstPrepared = prepareToolCall(effectiveToolCalls[callIndex])
      const canParallelize = isParallelSafeTool(firstPrepared.tc.name, firstPrepared.normalizedArgs)
      const remainingBudget = TOOL_LOOP_LIMITS.maxTotalCalls - toolLoopState.totalCalls

      if (canParallelize && !firstPrepared.stopReason && remainingBudget > 1) {
        const preparedBatch = [firstPrepared]
        let nextIndex = callIndex + 1
        while (nextIndex < effectiveToolCalls.length && preparedBatch.length < remainingBudget) {
          const prepared = prepareToolCall(effectiveToolCalls[nextIndex])
          if (!isParallelSafeTool(prepared.tc.name, prepared.normalizedArgs)) break
          preparedBatch.push(prepared)
          nextIndex += 1
        }

        if (preparedBatch.length > 1) {
          console.log(`[工具并行] ${preparedBatch.map(item => item.tc.name).join(', ')}`)
          const batchResults = await Promise.all(preparedBatch.map(item => runPreparedToolCall(item)))
          toolResults.push(...batchResults.map(({ id, name, result }) => ({ id, name, result })))
          const lastBatchResult = batchResults[batchResults.length - 1]
          if (lastBatchResult) {
            lastToolResult = {
              name: lastBatchResult.name,
              args: lastBatchResult.args,
              result: lastBatchResult.result,
            }
          }
          toolLoopStopReason = batchResults.find(item => item.stopReason)?.stopReason || null
          callIndex += preparedBatch.length
        } else {
          const result = await runPreparedToolCall(firstPrepared)
          toolResults.push({ id: result.id, name: result.name, result: result.result })
          toolLoopStopReason = result.stopReason
          callIndex += 1
        }
      } else {
        const result = await runPreparedToolCall(firstPrepared)
        toolResults.push({ id: result.id, name: result.name, result: result.result })
        toolLoopStopReason = result.stopReason
        callIndex += 1
      }

      if (toolLoopStopReason) {
        for (const skipped of effectiveToolCalls.slice(callIndex)) {
          toolResults.push({
            id: skipped.id,
            name: skipped.name,
            result: makeToolLoopStoppedResult(skipped.name, `skipped because previous tool call stopped the loop: ${toolLoopStopReason}`),
          })
        }
        break
      }
    }
    throwIfAborted(signal)

    // 将本轮 assistant 消息（含工具调用）加入对话
    // 若是 XML 解析的工具调用，assistant 消息用文本形式（避免 MiniMax 不支持 tool_calls 格式回放）
    const isXmlRound = toolCalls.length === 0 && effectiveToolCalls.length > 0
    if (isXmlRound) {
      // XML 工具调用：assistant 消息为纯文本，工具结果作为 user 消息注入
      if (content) messages.push({ role: 'assistant', content })
      const resultSummary = toolResults.map(tr =>
        `[Tool result] ${tr.name}: ${tr.result.slice(0, 300)}`
      ).join('\n')
      // 同主路径：以 sentMessage（本轮最后一个动作是否是 send_message）为收尾依据，
      // 而不是只看本轮有没有出现过 send_message。
      messages.push({
        role: 'user',
        content: sentMessage
          ? `Tool execution results:\n${resultSummary}\n\nMessage sent. If you still need to send additional separate messages, call send_message again now. Otherwise end this round.`
          : toolLoopStopReason
            ? buildToolLoopStopNudge(toolLoopStopReason, lastToolResult)
            : `Tool execution results:\n${resultSummary}\n\nContinue completing the task. If this is a user message and the information is sufficient, call send_message to give the user a final reply. If a tool failed, explain the failure and available clues; do not end silently.`,
      })
    } else {
      const assistantMsg = {
        role: 'assistant',
        tool_calls: effectiveToolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments || '{}' }
        }))
      }
      if (content) assistantMsg.content = content
      if (reasoningContent) assistantMsg.reasoning_content = reasoningContent
      messages.push(assistantMsg)

      // 将工具结果加入对话
      for (const tr of toolResults) {
        messages.push({
          role: 'tool',
          tool_call_id: tr.id,
          content: String(tr.result)
        })
      }
      // "send_message 是不是本轮最后一个动作"才是判断"能不能收尾"的正确信号。
      // 旧逻辑只看 hasSendMessage（本轮任意位置出现过 send_message），
      // 会让 [send_message("我查一下..."), exec_command, exec_command] 这种"先说一句再去查"的链条
      // 在 exec_command 出结果后被错误地告知"可以结束了"，导致模型静默退场、用户拿不到最终答复。
      if (toolLoopStopReason) {
        messages.push({
          role: 'user',
          content: buildToolLoopStopNudge(toolLoopStopReason, lastToolResult),
        })
      } else if (sentMessage) {
        messages.push({
          role: 'user',
          content: 'Message sent. If you still need to send additional separate messages to the user, call send_message again now. Otherwise end this round.',
        })
      } else if (mustReply) {
        messages.push({
          role: 'user',
          content: 'Tool results have returned. Continue completing the user request based on the available results. If the information is sufficient, you must call send_message to send the final reply to the user. For files, directories, commands, or network requests, state only facts verified by tool results, such as ok/verified/path/bytes/exit_code/status. Do not claim completion of any action without tool evidence. If a tool failed or the data is insufficient, explain the limitation and next suggested step; do not end silently.',
        })
      }
    }
  }

  return { content: allContent, toolResult: lastToolResult, aborted: signal?.aborted ?? false }
}
