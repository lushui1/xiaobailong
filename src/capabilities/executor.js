import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { nowTimestamp } from '../time.js'
import { searchMemories, searchMemoriesByKeywords, insertMemory, upsertMemoryByMemId, memoryExistsByMemId, getMemoryByMemId, deleteMemoryByMemId, hideMemoryByMemId, normalizeConversationPartyId, createReminder, findMergeableOneOffReminder, appendReminderTask, listPendingReminders, getReminderById, cancelReminder, upsertPrefetchTask, removePrefetchTask, listPrefetchTasks, insertActionLog, insertConversation, upsertMusicTrack, getMusicTrack, searchMusicLibrary, listMusicLibrary, updateMusicLrc, deleteMusicTrack as dbDeleteMusicTrack, setConfig as dbSetConfig } from '../db.js'
import { emitEvent, emitUICommand, emitACUIEvent, hasACUIClient, addActiveUICard, removeActiveUICard, getActiveUICards, setStickyEvent } from '../events.js'
import { dispatchSocialMessage } from '../social/dispatch.js'
import { callCapability, listCapabilities } from '../providers/registry.js'
import { isDailyLimitReached } from '../quota.js'
import { setCustomInterval as setTickerInterval, getStatus as getTickerStatus } from '../ticker.js'
import { setHotspotPanelState, getHotspotPanelState } from '../hotspots.js'
import { setPersonCardPanelState, getPersonCardPanelState, getPersonCard } from '../person-cards.js'
import { setDocPanelState, getDocPanelState } from '../docs.js'
import { setUserLocation } from '../weather.js'
import { getAgentById, isDelegationAllowed } from '../agents/registry.js'
import { installTool, uninstallTool, listInstalledTools, isInstalledTool, executeInstalledTool } from './marketplace/index.js'
import { TOOL_SCHEMAS } from './schemas.js'

// 后台进程注册表：pid → { process, command, startedAt, outputLines }
const bgProcesses = new Map()
const BG_OUTPUT_MAX_LINES = 200

const IS_WIN = process.platform === 'win32'

/**
 * 跨平台 spawn shell 命令，确保中文输出不乱码。
 *
 * Windows 编码三层同步（缺一不可，否则中文会乱码）：
 *   1) chcp 65001  → 切换控制台 Active Code Page 到 UTF-8。这一步最关键：
 *      原生程序（git / npm / node / cmd 内建命令 / yt-dlp 等）读取的是 ACP，
 *      不读 PowerShell 的 OutputEncoding。中文 Windows 默认 ACP=936(GBK)，
 *      不切的话原生命令吐 GBK 字节，下游按 UTF-8 解码就是 �。
 *   2) [Console]::OutputEncoding=UTF8  → 告诉 PowerShell 按 UTF-8 解码原生命令输出。
 *   3) [Console]::InputEncoding / $OutputEncoding=UTF8  → PowerShell 自身、
 *      以及向子进程 stdin 写数据的方向也用 UTF-8。
 *
 * 不通过 Node 的 shell: 'powershell.exe' 选项，避免 Windows 下被强行套上
 * cmd /d /s /c 包装（PowerShell 会把这些当作未知参数，特殊字符还可能二次转义）。
 * 直接显式 spawn powershell.exe + -Command 最可控。
 *
 * 调用方仍应对 child.stdout / child.stderr 调用 setEncoding('utf8')，
 * 防止数据 chunk 切在多字节字符中间产生 U+FFFD。
 */
function spawnShellCommand(command, opts = {}) {
  if (IS_WIN) {
    const wrapped =
      `chcp 65001 > $null; ` +
      `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ` +
      `[Console]::InputEncoding=[System.Text.Encoding]::UTF8; ` +
      `$OutputEncoding=[System.Text.Encoding]::UTF8; ` +
      command
    return spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', wrapped], opts)
  }
  return spawn(command, { ...opts, shell: true })
}

// URL 访问缓存：url → { content, fetchedAt (ms timestamp) }
// 避免同一 URL 在短时间内被反复请求（如天气每天只需查一次）
const urlCache = new Map()

// web_search 结果缓存：query::limit → { payload, fetchedAt }
// Map 的插入顺序即 LRU 顺序；写入时若超量则淘汰最老一条
const searchCache = new Map()
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000
const SEARCH_CACHE_MAX = 200

function searchCacheGet(key) {
  const entry = searchCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.fetchedAt >= SEARCH_CACHE_TTL_MS) {
    searchCache.delete(key)
    return null
  }
  searchCache.delete(key)
  searchCache.set(key, entry)
  return entry.payload
}

function searchCacheSet(key, payload) {
  searchCache.set(key, { payload, fetchedAt: Date.now() })
  while (searchCache.size > SEARCH_CACHE_MAX) {
    const oldest = searchCache.keys().next().value
    if (oldest === undefined) break
    searchCache.delete(oldest)
  }
}

const URL_TTL_MS = {
  default: 60 * 60 * 1000,       // 默认：1 小时
  weather: 24 * 60 * 60 * 1000,  // 天气类：24 小时
  news:    30 * 60 * 1000,        // 新闻类：30 分钟
}

function getUrlTtl(url) {
  const u = url.toLowerCase()
  if (u.includes('wttr.in') || u.includes('weather') || u.includes('openweather') || u.includes('tianqi')) {
    return URL_TTL_MS.weather
  }
  if (u.includes('news') || u.includes('rss') || u.includes('feed')) {
    return URL_TTL_MS.news
  }
  return URL_TTL_MS.default
}

import { config, getTTSCredentials, setSecurity, getWebSearchCredentials } from '../config.js'
import { streamTTS } from '../voice/tts-providers.js'
import { paths } from '../paths.js'
import { PRIMARY_USER_ID, lookupReplyTarget, normalizeChannel, suggestProactiveChannel } from '../identity.js'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 文件操作只允许在 sandbox 目录内
const SANDBOX_ROOT = path.resolve(paths.sandboxDir)

// inline-script 草稿注册表（内存 + 磁盘双存）
const draftCodeMap = new Map()   // { scratchId → code }
const appIdToName  = new Map()   // { scratchId → appName }
const DRAFT_CODE_MAP_MAX = 50    // 超出后淘汰最旧条目
function addDraftCode(id, code) {
  if (draftCodeMap.size >= DRAFT_CODE_MAP_MAX) {
    draftCodeMap.delete(draftCodeMap.keys().next().value)
  }
  draftCodeMap.set(id, code)
}

// 由 api.js 调用：把 app:saveState 信号的状态自动落盘
export function persistAppState(componentId, state) {
  const name = appIdToName.get(componentId)
  if (!name) return false
  try {
    const statePath = path.resolve(SANDBOX_ROOT, 'apps', name, 'state.json')
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8')
    return true
  } catch { return false }
}

function createAbortError(reason = 'Aborted') {
  const err = new Error(reason)
  err.name = 'AbortError'
  return err
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError(signal.reason || 'Aborted')
}

function createMergedAbortSignal(signal, timeoutMs) {
  if (!signal && !timeoutMs) return null

  const controller = new AbortController()
  let timeoutId = null

  const abort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason)
  }

  const onAbort = () => abort(signal?.reason || 'Aborted')
  if (signal) {
    if (signal.aborted) abort(signal.reason || 'Aborted')
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  if (timeoutMs) {
    timeoutId = setTimeout(() => abort(`Timeout ${timeoutMs}ms`), timeoutMs)
  }

  return {
    signal: controller.signal,
    cleanup() {
      if (timeoutId) clearTimeout(timeoutId)
      if (signal) signal.removeEventListener('abort', onAbort)
    },
  }
}

function isPathInside(parentDir, candidatePath) {
  const parent = path.resolve(parentDir)
  const candidate = path.resolve(candidatePath)
  const relative = path.relative(parent, candidate)
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function assertInSandbox(resolvedPath) {
  if (config.security?.fileSandbox === false) return
  if (resolvedPath !== SANDBOX_ROOT && !isPathInside(SANDBOX_ROOT, resolvedPath)) {
    throw new Error(`访问被拒绝：文件操作只允许在 sandbox 目录内（${SANDBOX_ROOT}）`)
  }
}

// 规范化路径：去掉可能带的 sandbox/ 前缀，统一以 SANDBOX_ROOT 为基准
// 同时处理模型把 list_dir 返回的绝对路径再次传入的情况
function normalizeSandboxPath(filePath) {
  if (path.isAbsolute(filePath)) {
    const rel = path.relative(SANDBOX_ROOT, filePath)
    if (!rel.startsWith('..')) return rel || '.'
  }
  return filePath
    .replace(/^sandbox[\\/]/i, '')
    .replace(/^\.[\\/]/, '')
}

// 工具执行器：根据工具名和参数执行对应操作，返回结果字符串
const TOOL_RISK = {
  read_file: 'low',
  list_dir: 'low',
  search_memory: 'low',
  list_processes: 'low',
  skip_recognition: 'low',
  send_message: 'medium',
  express: 'medium',
  write_file: 'medium',
  make_dir: 'medium',
  upsert_memory: 'medium',
  merge_memories: 'high',     // 删数据
  downgrade_memory: 'low',
  skip_consolidation: 'low',
  manage_reminder: 'medium',
  schedule_reminder: 'medium',
  manage_prefetch_task: 'medium',
  ui_show: 'medium',
  ui_update: 'medium',
  ui_hide: 'medium',
  ui_patch: 'medium',
  manage_app: 'medium',
  set_tick_interval: 'medium',
  media_mode: 'low',
  hotspot_mode: 'low',
  open_doc_panel: 'low',
  person_card_mode: 'low',
  music: 'low',
  delegate_to_agent: 'high',
  grant_agent_delegation: 'high',
  install_tool: 'high',
  uninstall_tool: 'medium',
  list_tools: 'low',
  complete_startup_self_check: 'low',
  delete_file: 'high',
  exec_command: 'high',
  kill_process: 'high',
  web_search: 'high',
  fetch_url: 'high',
  browser_read: 'high',
  speak: 'high',
  generate_lyrics: 'high',
  generate_music: 'high',
  generate_image: 'high',
  ui_register: 'high',
  set_security: 'high',
}

function classifyTool(name) {
  return TOOL_RISK[name] || 'medium'
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return '{}'
  }
}

function compactWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function previewValue(value, max = 180) {
  const text = typeof value === 'string' ? value : safeJsonStringify(value)
  const compact = compactWhitespace(text)
  return compact.length > max ? `${compact.slice(0, max)}...` : compact
}

function getExecutionSource(context = {}) {
  return context.source || context.trigger || (context.autonomous ? 'autonomous' : 'llm')
}

function summarizeToolExecution(name, args = {}) {
  switch (name) {
    case 'read_file':
      return `read_file(${args.path || args.filename || args.file_path || '?'})`
    case 'list_dir':
      return `list_dir(${args.path || args.dir || args.directory || '.'})`
    case 'write_file':
      return `write_file(${args.path || args.filename || args.file_path || '?'})`
    case 'delete_file':
      return `delete_file(${args.path || args.filename || args.file_path || '?'})`
    case 'make_dir':
      return `make_dir(${args.path || args.dir || args.directory || '?'})`
    case 'exec_command':
      return `exec_command(${String(args.command || args.cmd || '?').slice(0, 100)})`
    case 'fetch_url':
    case 'browser_read':
      return `${name}(${String(args.url || args.link || args.href || '?').slice(0, 120)})`
    case 'web_search':
      return `web_search(${String(args.query || args.q || args.keyword || '?').slice(0, 120)})`
    case 'send_message':
    case 'express':
      return `${name} -> ${args.target_id || '(unknown)'}`
    case 'upsert_memory': {
      const count = Array.isArray(args.memories) ? args.memories.length : 0
      return `upsert_memory(${count})`
    }
    default:
      return name
  }
}

function isDangerousShellCommand(command) {
  const text = String(command || '').trim()
  const reasons = []
  if (config.security?.execSandbox !== false) {
    if (/(^|[\s"'`])\.\.([\\/]|$)/.test(text)) reasons.push('command references a parent directory')
    if (/(^|[\s"'`])[a-z]:[\\/]/i.test(text) || /(^|[\s"'`])[\\/]{2}[^\\/]/.test(text)) reasons.push('command references an absolute filesystem path')
    if (/(^|[\s"'`])~([\\/]|$)/.test(text) || /\$(home|env:userprofile)\b/i.test(text) || /%userprofile%/i.test(text)) reasons.push('command references the user home directory')
    if (/\bgit\s+reset\s+--hard\b/i.test(text) || /\bgit\s+clean\b/i.test(text)) reasons.push('command can destructively rewrite the worktree')
    if (/\b(format|diskpart|shutdown)\b/i.test(text)) reasons.push('command is system-level destructive or disruptive')
    if (/Remove-Item\b.*-Recurse|-Recurse\b.*Remove-Item/i.test(text)) reasons.push('recursive delete (Remove-Item -Recurse) detected')
    if (/\brd\s+\/s\b/i.test(text)) reasons.push('recursive directory delete (rd /s) detected')
    if (/\bInvoke-Expression\b|\biex\s/i.test(text)) reasons.push('dynamic code execution via Invoke-Expression detected')
  }
  return reasons
}

function evaluateToolPolicy(name, args = {}, context = {}) {
  const risk = classifyTool(name)
  const blockedTools = config.security?.blockedTools || []
  if (blockedTools.includes(name)) {
    return { allowed: false, risk, reason: `工具 "${name}" 已被安全策略禁用` }
  }
  if (name === 'exec_command') {
    const reasons = isDangerousShellCommand(args.command || args.cmd || '')
    if (reasons.length) return { allowed: false, risk, reason: reasons.join('; ') }
  }
  if (context.autonomous && risk === 'high' && !context.allowHighRiskAutonomy) {
    return { allowed: false, risk, reason: 'high-risk tool requires an explicit user-driven context' }
  }
  return { allowed: true, risk, reason: '' }
}

function inferToolStatus(result) {
  const text = String(result ?? '').trim()
  if (!text) return 'ok'
  try {
    const parsed = JSON.parse(text)
    return parsed?.ok === false ? 'error' : 'ok'
  } catch {}
  return /^(错误|请求失败|执行失败|命令超时|命令执行失败|閿欒|璇锋眰澶辫触|鎵ц澶辫触|鍛戒护瓒呮椂|鍛戒护鎵ц澶辫触)/.test(text) ? 'error' : 'ok'
}

function writeToolAuditLog({ name, args, context, policy, status, result = '', error = '', startedAt }) {
  const durationMs = Date.now() - startedAt
  const detailParts = []
  if (policy?.reason) detailParts.push(`policy=${policy.reason}`)
  const argPreview = previewValue(args, 160)
  if (argPreview && argPreview !== '{}') detailParts.push(`args=${argPreview}`)
  const resultPreview = previewValue(result || error, 220)
  if (resultPreview) detailParts.push(`result=${resultPreview}`)

  try {
    insertActionLog({
      timestamp: new Date(startedAt).toISOString(),
      tool: name,
      summary: summarizeToolExecution(name, args),
      detail: detailParts.join(' | '),
      status,
      risk: policy?.risk || classifyTool(name),
      argsJson: safeJsonStringify(args),
      resultPreview,
      error,
      durationMs,
      source: getExecutionSource(context),
    })
  } catch (err) {
    console.warn(`[audit] failed to persist tool audit log: ${err.message}`)
  }

  emitEvent('tool_audit', {
    tool: name,
    status,
    risk: policy?.risk || classifyTool(name),
    summary: summarizeToolExecution(name, args),
    duration_ms: durationMs,
    source: getExecutionSource(context),
  })
}

async function executeToolUnchecked(name, args, context = {}) {
  try {
    throwIfAborted(context.signal)
    switch (name) {
      case 'express':
        return await execExpress(args, context)
      case 'send_message':
        return await execSendMessage(args, context)
      case 'read_file':
        return await execReadFile(args, context)
      case 'list_dir':
        return await execListDir(args, context)
      case 'write_file':
        return await execWriteFile(args, context)
      case 'delete_file':
        return await execDeleteFile(args, context)
      case 'make_dir':
        return await execMakeDir(args, context)
      case 'exec_command':
        return await execCommand(args, context)
      case 'kill_process':
        return await execKillProcess(args)
      case 'list_processes':
        return await execListProcesses(args)
      case 'web_search':
        return await execWebSearch(args, context)
      case 'fetch_url':
        return await execFetchUrl(args, context)
      case 'browser_read':
        return await execBrowserRead(args, context)
      case 'search_memory':
        return await execSearchMemory(args)
      case 'upsert_memory':
        return await execUpsertMemory(args, context)
      case 'skip_recognition':
        return await execSkipRecognition(args)
      case 'merge_memories':
        return await execMergeMemories(args, context)
      case 'downgrade_memory':
        return await execDowngradeMemory(args)
      case 'skip_consolidation':
        return await execSkipConsolidation(args)
      case 'speak':
        return await execSpeak(args)
      case 'generate_lyrics':
        return await execGenerateLyrics(args)
      case 'generate_music':
        return await execGenerateMusic(args)
      case 'generate_image':
        return await execGenerateImage(args)
      case 'set_tick_interval':
        return execSetTickInterval(args)
      case 'media_mode':
        return execMediaMode(args)
      case 'hotspot_mode':
        return execHotspotMode(args)
      case 'open_doc_panel':
        return execOpenDocPanel(args)
      case 'person_card_mode':
        return execPersonCardMode(args)
      case 'music':
        return await execMusic(args)
      case 'schedule_reminder':
      case 'manage_reminder':
        return await execManageReminder(args, context)
      case 'manage_prefetch_task':
        return execManagePrefetchTask(args)
      case 'ui_show':
        return execUIShow(args)
      case 'ui_update':
        return execUIUpdate(args)
      case 'ui_hide':
        return execUIHide(args)
      case 'ui_patch':
        return execUIPatch(args)
      case 'manage_app':
        return execManageApp(args)
      case 'ui_register':
        return execUIRegister(args)
      case 'focus_banner':
        return execFocusBanner(args)
      case 'set_location':
        return execSetLocation(args)
      case 'set_agent_name':
        return execSetAgentName(args)
      case 'delegate_to_agent':
        return await execDelegateToAgent(args)
      case 'grant_agent_delegation':
        return execGrantAgentDelegation(args)
      case 'complete_startup_self_check':
        return execCompleteStartupSelfCheck(args, context)
      case 'set_task':
        return execSetTask(args, context)
      case 'complete_task':
        return execCompleteTask(args, context)
      case 'update_task_step':
        return execUpdateTaskStep(args, context)
      case 'recall_memory':
        return await execRecallMemory(args, context)
      case 'install_tool':
        return await execInstallTool(args)
      case 'uninstall_tool':
        return execUninstallTool(args)
      case 'list_tools':
        return execListTools()
      case 'connect_wechat':
        return execConnectWechat()
      case 'set_security':
        return execSetSecurity(args)
      default:
        if (isInstalledTool(name)) {
          return await executeInstalledTool(name, args)
        }
        return `错误：未知工具 "${name}"`
    }
  } catch (err) {
    if (err.name === 'AbortError') throw err
    return `执行失败：${err.message}`
  }
}

export async function executeTool(name, args, context = {}) {
  const startedAt = Date.now()
  const safeArgs = args || {}
  const policy = evaluateToolPolicy(name, safeArgs, context)

  if (!policy.allowed) {
    const result = toolJson({
      ok: false,
      tool: name,
      error: 'permission denied',
      policy: {
        risk: policy.risk,
        reason: policy.reason,
      },
    })
    writeToolAuditLog({ name, args: safeArgs, context, policy, status: 'denied', result, startedAt })
    return result
  }

  try {
    const result = await executeToolUnchecked(name, safeArgs, context)
    writeToolAuditLog({ name, args: safeArgs, context, policy, status: inferToolStatus(result), result, startedAt })
    return result
  } catch (err) {
    if (err.name === 'AbortError') throw err
    const result = `执行失败：${err.message}`
    writeToolAuditLog({ name, args: safeArgs, context, policy, status: 'error', result, error: err.message, startedAt })
    return result
  }
}

function resolveAllowedTargetId(targetId, allowedTargetIds = []) {
  const normalizedTarget = normalizeConversationPartyId(targetId)
  const normalizedAllowed = [...new Set((allowedTargetIds || []).map(id => normalizeConversationPartyId(id)).filter(Boolean))]
  if (!normalizedAllowed.length) {
    throw new Error('The current prompt did not explicitly inject any sendable target entities, so sending a message is forbidden.')
  }

  if (normalizedAllowed.includes(normalizedTarget)) {
    return normalizedTarget
  }

  const compact = value => String(value || '').trim().toLowerCase().replace(/^id:0*/, '')
  const targetCompact = compact(normalizedTarget)
  const fuzzyMatches = normalizedAllowed.filter(id => compact(id) === targetCompact)
  if (fuzzyMatches.length === 1) {
    console.log(`[send_message] ID strict validation passed by fuzzy normalization: "${targetId}" -> "${fuzzyMatches[0]}"`)
    return fuzzyMatches[0]
  }

  throw new Error(`target_id "${targetId}" is not in the target entity list explicitly injected into the current prompt: ${normalizedAllowed.join(', ')}`)
}

function assertVisibleTargetId(targetId, visibleTargetIds = []) {
  const normalizedTarget = normalizeConversationPartyId(targetId)
  const normalizedVisible = [...new Set((visibleTargetIds || []).map(id => normalizeConversationPartyId(id)).filter(Boolean))]
  if (!normalizedVisible.length) {
    throw new Error('The current L2 prompt did not inject any conversation targets, so sending a message is forbidden.')
  }

  if (normalizedVisible.includes(normalizedTarget)) {
    return normalizedTarget
  }

  throw new Error(`target_id "${targetId}" does not appear in the conversation records injected into the current L2 prompt: ${normalizedVisible.join(', ')}`)
}

function parseReminderDueAt(value) {
  if (!value || typeof value !== 'string') {
    throw new Error('due_at was not provided')
  }
  const dueAt = new Date(value.trim())
  if (Number.isNaN(dueAt.getTime())) {
    throw new Error('due_at must be a valid ISO 8601 absolute time, for example 2026-04-21T06:00:00+08:00')
  }
  return dueAt
}

function trimAssistantFluff(content) {
  let text = String(content || '').trim()
  if (!text) return text

  text = text
    .replace(/^(?:\s*\[assistant(?:\s+to\s+[^\]\r\n]+)?(?:\s+\d{4}-\d{2}-\d{2}T[^\]\r\n]+)?\]\s*)+/giu, '')
    .trim()

  const patterns = [
    /[，,、。.!！？~～\s]*(?:从现在起|从今以后|以后)?我就是[\u4e00-\u9fa5A-Za-z0-9 _-]{1,24}[，,、。.!！？~～\s]*为您效劳[！!～~。.\s]*$/u,
    /[，,、。.!！？~～\s]*有什么需要帮忙的[？?]?[，,、。.!！？~～\s]*(?:随时)?为您效劳[～~！!。.\s]*$/u,
    /[，,、。.!！？~～\s]*有什么需要我帮忙的[？?]?[，,、。.!！？~～\s]*(?:随时)?为您效劳[～~！!。.\s]*$/u,
    /[，,、。.!！？~～\s]*随时为您效劳[～~！!。.\s]*$/u,
    /[，,、。.!！？~～\s]*为您效劳[～~！!。.\s]*$/u,
    /[，,、。.!！？~～\s]*有什么需要帮忙的[？?]?[～~！!。.\s]*$/u,
    /[，,、。.!！？~～\s]*有什么需要我帮忙的[？?]?[～~！!。.\s]*$/u,
  ]

  let changed = true
  while (changed) {
    changed = false
    for (const pattern of patterns) {
      const next = text.replace(pattern, '').trim()
      if (next !== text) {
        text = next
        changed = true
      }
    }
  }

  return text
}

// express：表达器入口，根据 format 路由到对应输出渠道
async function execExpress({ target_id, content, channel = 'AUTO', format = 'text' }, context = {}) {
  if (!content?.trim()) return '错误：未提供表达内容'
  if (format === 'voice') {
    // 语音表达：先发文字消息再生成语音
    const sendResult = await execSendMessage({ target_id, content, channel }, context)
    if (sendResult.startsWith('错误：') || sendResult.startsWith('执行失败：')) return sendResult
    return await execSpeak({ text: content })
  }
  // 默认：文字表达
  return await execSendMessage({ target_id, content, channel }, context)
}

// 决议出站消息的真实投递目标：
// 输入 target_id（可能是 canonical ID:000001 或带前缀的外部 ID）+ channel 偏好（WECHAT/DISCORD/FEISHU/WECOM/TUI/AUTO）+ ctx
// 输出 { externalTargetId, deliveryChannel, isLocal, reason }
//   - externalTargetId: 传给 dispatchSocialMessage 的 ID（本地投递时为 null）
//   - deliveryChannel: conversations.channel 字段实际值（数据库格式，如 WECHAT_CLAWBOT/TUI）
//   - isLocal: true 时不调外部 dispatch，只走本地 SSE
//   - reason: 失败时给 LLM 的提示
// AUTO 决议顺序：当前 turn 渠道（响应模式）→ suggestProactiveChannel（主动模式）
function resolveDeliveryTarget(resolvedId, channelPref, context = {}) {
  const pref = (channelPref || 'AUTO').toUpperCase()

  // resolvedId 本身就是带渠道前缀的外部 ID（少见，但保留兼容）—— 直接当外部投递
  if (/^(wechat|discord|feishu|wecom):/i.test(resolvedId)) {
    return { externalTargetId: resolvedId, deliveryChannel: '', isLocal: false }
  }

  // canonical 用户 ID：根据 channel 偏好决议
  let actualPref = pref
  if (actualPref === 'AUTO') {
    // 优先用当前 turn 的渠道：用户在哪儿发消息就回到哪儿（响应直觉一致）
    const currentNorm = context.currentChannel ? normalizeChannel(context.currentChannel) : null
    if (currentNorm && currentNorm !== 'SYSTEM') {
      actualPref = currentNorm
    } else {
      // 没有当前 turn 渠道（典型场景：tick 主动外联）→ 用 presence 推荐
      actualPref = suggestProactiveChannel(resolvedId)
    }
  }

  if (actualPref === 'TUI') {
    return { externalTargetId: null, deliveryChannel: 'TUI', isLocal: true }
  }

  // 当前 turn 已经在该外部渠道、且带 externalPartyId → 直接复用，省一次 DB 查
  if (context.currentExternalPartyId && context.currentChannel) {
    const ctxNorm = normalizeChannel(context.currentChannel)
    if (ctxNorm === actualPref) {
      return {
        externalTargetId: context.currentExternalPartyId,
        deliveryChannel: context.currentChannel,
        isLocal: false,
      }
    }
  }

  // 否则反查该 canonical 用户在指定渠道最近一次的 external_id
  const reply = lookupReplyTarget({ canonicalId: resolvedId, channel: actualPref })
  if (reply) {
    return { externalTargetId: reply.externalId, deliveryChannel: reply.channel, isLocal: false }
  }

  // 用户在该渠道从未交互过，无法主动联系
  return {
    externalTargetId: null,
    deliveryChannel: '',
    isLocal: false,
    error: `cannot route to ${actualPref}: user ${resolvedId} has no recorded external_party_id on that channel`,
  }
}

// send_message：投递到指定渠道（本地 SSE 或外部平台），并写入 conversations 表
async function execSendMessage({ target_id, content, channel = 'AUTO' }, context = {}) {
  if (!target_id) return '错误：未提供 target_id'
  if (!content?.trim()) return '错误：未提供消息内容'

  const resolvedId = resolveAllowedTargetId(target_id, context.allowedTargetIds)
  assertVisibleTargetId(resolvedId, context.visibleTargetIds)
  const cleanedContent = trimAssistantFluff(content)
  if (!cleanedContent) return '错误：消息内容为空'

  const delivery = resolveDeliveryTarget(resolvedId, channel, context)
  if (delivery.error) return `错误：${delivery.error}`

  const timestamp = nowTimestamp()
  const channelLabel = delivery.deliveryChannel || (delivery.isLocal ? 'TUI' : '')
  console.log(`\n[消息发送] → ${resolvedId}${delivery.externalTargetId ? ` via ${delivery.externalTargetId}` : ''}${channelLabel ? ` [${channelLabel}]` : ''}`)
  console.log(`  ${cleanedContent}`)
  console.log(`  时间：${timestamp}`)

  // 顺序：先写数据库（source of truth），再广播 SSE，最后外部投递。
  // 外部投递失败时仍保留对话记录，下次 LLM 仍能看到自己发过这句话；前端也已经显示。
  insertConversation({
    role: 'jarvis',
    from_id: 'jarvis',
    to_id: resolvedId,
    content: cleanedContent,
    timestamp,
    channel: channelLabel,
    external_party_id: delivery.externalTargetId || '',
  })

  emitEvent('message', {
    from: 'consciousness',
    to: resolvedId,
    content: cleanedContent,
    timestamp,
    channel: channelLabel,
    external_party_id: delivery.externalTargetId || '',
  })

  let socialResult = null
  if (!delivery.isLocal && delivery.externalTargetId) {
    try {
      socialResult = await dispatchSocialMessage(delivery.externalTargetId, cleanedContent)
    } catch (err) {
      console.warn(`[消息发送] 外部投递异常 (${delivery.deliveryChannel}): ${err.message}`)
      socialResult = { ok: false, error: err.message }
    }
  }

  if (socialResult?.ok) return `消息已发送至 ${resolvedId}（${socialResult.platform} 已投递）`
  if (socialResult?.skipped) return `消息已发送至 ${resolvedId}（社交平台未配置：${socialResult.reason}）`
  if (socialResult && socialResult.ok === false) {
    const reason = socialResult.reason || socialResult.error || 'unknown'
    // wechat-clawbot 缺 context_token 是该渠道最常见的失败：重启后内存 Map 清空、或用户从未入站。
    // 单独点名，让 LLM 直接告诉用户"先发一条过来"，不要去编造其他解释。
    const isMissingContextToken = /no context_token/i.test(reason)
    const hint = isMissingContextToken
      ? '（wechat-clawbot 必须先收到该用户的入站消息才能回发；告诉用户先从微信给你发一条任意内容即可。）'
      : ''
    return `消息发送失败：外部渠道 ${delivery.deliveryChannel || 'unknown'} 投递未成功（${reason}）。${hint}请如实告知用户该消息未送达及原因。`
  }
  return `消息已发送至 ${resolvedId}${channelLabel ? `（${channelLabel}）` : ''}`
}

function parseHourMinute(value, label = 'time') {
  const m = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m) throw new Error(`${label} must use HH:MM format, for example 09:00`)
  const hour = Number(m[1]), minute = Number(m[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new Error(`${label} is outside the valid range`)
  return { hour, minute }
}

// 周期提醒：根据 type/config 计算下一次触发时间（晚于 fromDate）
export function calculateNextDueAt(type, config, fromDate = new Date()) {
  const now = fromDate
  const { hour, minute } = parseHourMinute(config.time, 'time')

  if (type === 'daily') {
    const next = new Date(now)
    next.setHours(hour, minute, 0, 0)
    if (next <= now) next.setDate(next.getDate() + 1)
    return next
  }
  if (type === 'weekly') {
    const targetWeekday = Number(config.weekday)
    if (!Number.isInteger(targetWeekday) || targetWeekday < 0 || targetWeekday > 6) {
      throw new Error('weekday must be an integer from 0 to 6 (0=Sunday)')
    }
    const next = new Date(now)
    next.setHours(hour, minute, 0, 0)
    let diff = (targetWeekday - now.getDay() + 7) % 7
    if (diff === 0 && next <= now) diff = 7
    next.setDate(next.getDate() + diff)
    return next
  }
  if (type === 'monthly') {
    const targetDay = Number(config.day_of_month)
    if (!Number.isInteger(targetDay) || targetDay < 1 || targetDay > 31) {
      throw new Error('day_of_month must be an integer from 1 to 31')
    }
    let year = now.getFullYear(), month = now.getMonth()
    for (let i = 0; i < 12; i++) {
      const lastDay = new Date(year, month + 1, 0).getDate()
      if (targetDay <= lastDay) {
        const next = new Date(year, month, targetDay, hour, minute, 0, 0)
        if (next > now) return next
      }
      month++
      if (month > 11) { month = 0; year++ }
    }
    throw new Error('Could not find the next matching month')
  }
  throw new Error(`Unknown recurrence kind: ${type}`)
}

function buildSystemMessage(targetId, taskText) {
  return `I am the system. Based on the reminder you set, you now need to perform this task for user ${targetId}: ${taskText}. Handle it immediately, and when needed use send_message to send the result to ${targetId}.`
}

function formatReminderRow(r) {
  const recurrence = r.recurrence_type
    ? `[${r.recurrence_type}] ${(() => {
        try {
          const c = JSON.parse(r.recurrence_config || '{}')
          if (r.recurrence_type === 'daily') return `每天 ${c.time}`
          if (r.recurrence_type === 'weekly') {
            const names = ['周日','周一','周二','周三','周四','周五','周六']
            return `每${names[c.weekday]} ${c.time}`
          }
          if (r.recurrence_type === 'monthly') return `每月 ${c.day_of_month} 号 ${c.time}`
          return JSON.stringify(c)
        } catch { return '' }
      })()}`
    : '[once]'
  return `#${r.id} ${recurrence} 下次 ${r.due_at} → ${r.user_id}：${r.task}`
}

async function execManageReminder(args, context = {}) {
  const action = args.action || (args.due_at || args.kind ? 'create' : null)
  if (!action) return '错误：未提供 action（create/list/cancel）'

  if (action === 'list') {
    const rows = listPendingReminders(50)
    if (!rows.length) return '当前没有待触发的提醒。'
    return `共 ${rows.length} 条待触发提醒：\n` + rows.map(formatReminderRow).join('\n')
  }

  if (action === 'cancel') {
    const id = Number(args.id)
    if (!Number.isInteger(id) || id <= 0) return '错误：cancel 需要提供合法的提醒 id'
    const existing = getReminderById(id)
    if (!existing) return `错误：未找到提醒 #${id}`
    if (existing.status !== 'pending') return `错误：提醒 #${id} 当前状态为 ${existing.status}，无法取消`
    const result = cancelReminder(id)
    if (!result.changes) return `错误：取消提醒 #${id} 失败`
    emitEvent('reminder_cancelled', { id, user_id: existing.user_id, task: existing.task })
    return `提醒 #${id} 已取消（${existing.task}）`
  }

  if (action !== 'create') return `错误：未知 action "${action}"，仅支持 create/list/cancel`

  const { task } = args
  if (!task?.trim()) return '错误：未提供 task'
  const taskText = task.trim()
  const fallbackTargetId = context.visibleTargetIds?.[0] || context.allowedTargetIds?.[0] || PRIMARY_USER_ID
  const resolvedTargetId = resolveAllowedTargetId(args.target_id || fallbackTargetId, context.allowedTargetIds)

  const kind = args.kind || 'once'

  if (kind === 'once') {
    const dueAt = parseReminderDueAt(args.due_at)
    if (dueAt.getTime() <= Date.now()) throw new Error('提醒时间必须晚于当前时间')
    const isoDueAt = dueAt.toISOString()
    const minuteKey = isoDueAt.slice(0, 16)

    const mergeTarget = findMergeableOneOffReminder(resolvedTargetId, minuteKey)
    if (mergeTarget) {
      const mergedTaskText = `${mergeTarget.task}; ${taskText}`
      const newSystemMessage = buildSystemMessage(resolvedTargetId, mergedTaskText)
      const r = appendReminderTask(mergeTarget.id, taskText, newSystemMessage)
      if (!r.changes) return `错误：合并提醒 #${mergeTarget.id} 失败`
      emitEvent('reminder_merged', { id: mergeTarget.id, user_id: resolvedTargetId, due_at: mergeTarget.due_at, task: mergedTaskText })
      return `已合并到现有提醒 #${mergeTarget.id}（同时间），合并后任务：${mergedTaskText}`
    }

    const result = createReminder({
      userId: resolvedTargetId,
      dueAt: isoDueAt,
      task: taskText,
      systemMessage: buildSystemMessage(resolvedTargetId, taskText),
      source: `tool:manage_reminder@${nowTimestamp()}`,
    })
    emitEvent('reminder_created', { id: Number(result.lastInsertRowid), user_id: resolvedTargetId, due_at: isoDueAt, task: taskText })
    return `提醒已创建：#${result.lastInsertRowid}，将在 ${isoDueAt} 触发，目标用户 ${resolvedTargetId}`
  }

  // 周期提醒
  const config = {}
  if (kind === 'daily') {
    config.time = args.time
  } else if (kind === 'weekly') {
    config.time = args.time
    config.weekday = args.weekday
  } else if (kind === 'monthly') {
    config.time = args.time
    config.day_of_month = args.day_of_month
  } else {
    throw new Error(`未知的 kind "${kind}"，支持 once/daily/weekly/monthly`)
  }

  const nextDate = calculateNextDueAt(kind, config)
  const isoDueAt = nextDate.toISOString()
  const result = createReminder({
    userId: resolvedTargetId,
    dueAt: isoDueAt,
    task: taskText,
    systemMessage: buildSystemMessage(resolvedTargetId, taskText),
    source: `tool:manage_reminder@${nowTimestamp()}`,
    recurrenceType: kind,
    recurrenceConfig: config,
  })
  emitEvent('reminder_created', { id: Number(result.lastInsertRowid), user_id: resolvedTargetId, due_at: isoDueAt, task: taskText, recurrence_type: kind, recurrence_config: config })
  return `周期提醒已创建：#${result.lastInsertRowid} (${kind})，下次触发 ${isoDueAt}，目标用户 ${resolvedTargetId}`
}

// read_file：读取文件内容
async function execReadFile(args, context = {}) {
  throwIfAborted(context.signal)
  const rawPath = args.path || args.filename || args.file_path
  if (!rawPath) return '错误：未提供文件路径'
  const filePath = normalizeSandboxPath(rawPath)
  const resolved = path.resolve(SANDBOX_ROOT, filePath)
  assertInSandbox(resolved)
  return fs.readFileSync(resolved, 'utf-8')
}

// list_dir：列出目录内容
async function execListDir(args, context = {}) {
  throwIfAborted(context.signal)
  const rawPath = args.path || args.dir || args.directory || '.'
  const dirPath = normalizeSandboxPath(rawPath)
  const resolved = path.resolve(SANDBOX_ROOT, dirPath)
  assertInSandbox(resolved)
  const entries = fs.readdirSync(resolved, { withFileTypes: true })
  const result = entries.map(e => {
    const type = e.isDirectory() ? '[目录]' : '[文件]'
    return `${type} ${e.name}`
  }).join('\n')
  const relDisplay = dirPath === '.' ? '.' : dirPath.replace(/\\/g, '/')
  return `目录（相对路径）：${relDisplay}\n\n${result || '（空目录）'}`
}

const PROTECTED_FILES = new Set(['readme.txt', 'world.txt', 'package.json'])

// write_file：写入文件
async function execWriteFile(args, context = {}) {
  throwIfAborted(context.signal)
  const rawPath = args.path || args.filename || args.file_path
  const content = args.content ?? args.text ?? args.data
  if (!rawPath) return '错误：未提供文件路径'
  if (content === undefined) return '错误：未提供写入内容'
  const filePath = normalizeSandboxPath(rawPath)
  if (PROTECTED_FILES.has(path.basename(filePath).toLowerCase())) {
    return `错误：${path.basename(filePath)} 是系统文件，不可修改`
  }
  const resolved = path.resolve(SANDBOX_ROOT, filePath)
  assertInSandbox(resolved)
  // 确保目录存在
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, content, 'utf-8')
  const verifiedContent = fs.readFileSync(resolved, 'utf-8')
  const verified = verifiedContent === String(content)
  const bytes = Buffer.byteLength(verifiedContent, 'utf-8')
  if (!verified) {
    return toolJson({
      ok: false,
      tool: 'write_file',
      path: filePath,
      absolute_path: resolved,
      bytes,
      verified: false,
      error: 'read-back verification did not match written content',
    })
  }
  return toolJson({
    ok: true,
    tool: 'write_file',
    path: filePath,
    absolute_path: resolved,
    bytes,
    verified: true,
    content_preview: verifiedContent.slice(0, 120),
  })
}

// delete_file：删除沙盒内的文件或目录
async function execDeleteFile(args, context = {}) {
  throwIfAborted(context.signal)
  const rawPath = args.path || args.filename || args.file_path
  if (!rawPath) return '错误：未提供路径'
  const filePath = normalizeSandboxPath(rawPath)
  if (PROTECTED_FILES.has(path.basename(filePath).toLowerCase())) {
    return `错误：${path.basename(filePath)} 是系统文件，不可删除`
  }
  const resolved = path.resolve(SANDBOX_ROOT, filePath)
  assertInSandbox(resolved)
  if (!fs.existsSync(resolved)) return `错误：路径不存在：${filePath}`
  const stat = fs.statSync(resolved)
  if (stat.isDirectory()) {
    fs.rmSync(resolved, { recursive: true, force: true })
    const verifiedAbsent = !fs.existsSync(resolved)
    return toolJson({
      ok: verifiedAbsent,
      tool: 'delete_file',
      path: filePath,
      kind: 'directory',
      verified_absent: verifiedAbsent,
    })
  } else {
    fs.unlinkSync(resolved)
    const verifiedAbsent = !fs.existsSync(resolved)
    return toolJson({
      ok: verifiedAbsent,
      tool: 'delete_file',
      path: filePath,
      kind: 'file',
      verified_absent: verifiedAbsent,
    })
  }
}

// make_dir：在沙盒内创建目录（支持多级）
async function execMakeDir(args, context = {}) {
  throwIfAborted(context.signal)
  const rawPath = args.path || args.dir || args.directory
  if (!rawPath) return '错误：未提供目录路径'
  const dirPath = normalizeSandboxPath(rawPath)
  const resolved = path.resolve(SANDBOX_ROOT, dirPath)
  assertInSandbox(resolved)
  fs.mkdirSync(resolved, { recursive: true })
  const verified = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
  return toolJson({
    ok: verified,
    tool: 'make_dir',
    path: dirPath,
    absolute_path: resolved,
    verified,
  })
}

function resolveExecCwd(cwdArg) {
  if (!cwdArg) return config.security?.execSandbox === false ? process.cwd() : SANDBOX_ROOT
  if (config.security?.execSandbox === false) return path.resolve(process.cwd(), cwdArg)
  const resolved = path.resolve(SANDBOX_ROOT, cwdArg)
  assertInSandbox(resolved)
  return resolved
}

// exec_command：在沙盒目录内执行 shell 命令
// background=true 时后台运行，返回 PID；否则等待完成，返回输出
async function execCommand(args, context = {}) {
  throwIfAborted(context.signal)
  const command = String(args.command || args.cmd || '').trim()
  if (!command) return toolJson({ ok: false, tool: 'exec_command', error: 'missing command' })

  const background = args.background === true || args.background === 'true'
  const promoteToBackground = args.promote_to_background === true || args.promote_to_background === 'true'
  // schema 说明单位是秒，转换为毫秒；兼容旧调用（如果传入 >1000 视为已是毫秒）
  const rawTimeout = Number(args.timeout) || 30
  const timeoutMs = Math.max(1000, Math.min(rawTimeout < 1000 ? rawTimeout * 1000 : rawTimeout, 120000))

  let execCwd
  try {
    execCwd = resolveExecCwd(args.cwd || '')
  } catch (err) {
    return toolJson({ ok: false, tool: 'exec_command', error: err.message })
  }

  console.log(`[exec_command] ${background ? '[后台]' : '[前台]'} ${command} (cwd: ${execCwd})`)
  emitEvent('exec_command', { command, background, cwd: execCwd })

  if (background) {
    return execBackground(command, execCwd)
  } else {
    return execForeground(command, timeoutMs, context.signal, execCwd, promoteToBackground)
  }
}

function toolJson(payload) {
  return JSON.stringify(payload, null, 2)
}

function trimCommandOutput(value = '', max = 6000) {
  const text = String(value || '')
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n[输出已截断，原始长度 ${text.length} 字符，仅保留前 ${max} 字符]`
}

function execBackground(command, execCwd) {
  const child = spawnShellCommand(command, {
    cwd: execCwd,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')

  const pid = child.pid
  if (!pid) {
    return toolJson({
      ok: false,
      tool: 'exec_command',
      mode: 'background',
      command,
      cwd: execCwd,
      error: 'process did not start',
    })
  }
  const startedAt = nowTimestamp()
  const entry = { process: child, command, startedAt, outputLines: [] }
  bgProcesses.set(pid, entry)

  child.on('exit', (code) => {
    console.log(`[exec_command] 后台进程 PID ${pid} 退出，code=${code}`)
    bgProcesses.delete(pid)
    emitEvent('process_exit', { pid, command, code })
  })

  const pushOutputLine = (stream, data) => {
    const text = data.toString()
    entry.outputLines.push({ stream, text, ts: Date.now() })
    if (entry.outputLines.length > BG_OUTPUT_MAX_LINES) entry.outputLines.shift()
    emitEvent('process_output', { pid, stream, text: text.slice(0, 500) })
  }

  child.stdout?.on('data', (data) => pushOutputLine('stdout', data))
  child.stderr?.on('data', (data) => pushOutputLine('stderr', data))

  return toolJson({
    ok: true,
    tool: 'exec_command',
    mode: 'background',
    command,
    cwd: execCwd,
    pid,
    started_at: startedAt,
    hint: 'Process is running in the background. Use list_processes to inspect it or kill_process with this pid to stop it.',
  })
}

function execForeground(command, timeoutMs, signal, execCwd, promoteToBackground = false) {
  return new Promise((resolve) => {
    throwIfAborted(signal)
    const child = spawnShellCommand(command, { cwd: execCwd })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let timer = null

    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      merged?.cleanup()
      resolve(value)
    }

    const merged = createMergedAbortSignal(signal)
    const onAbort = () => {
      child.kill()
      finish(toolJson({
        ok: false,
        tool: 'exec_command',
        mode: 'foreground',
        command,
        cwd: execCwd,
        aborted: true,
        stdout: trimCommandOutput(stdout),
        stderr: trimCommandOutput(stderr),
        error: 'command aborted',
      }))
    }
    if (merged?.signal.aborted) {
      child.kill()
      finish(toolJson({
        ok: false,
        tool: 'exec_command',
        mode: 'foreground',
        command,
        cwd: execCwd,
        aborted: true,
        stdout: '',
        stderr: '',
        error: 'command aborted before start',
      }))
      return
    }
    merged?.signal.addEventListener('abort', onAbort, { once: true })

    timer = setTimeout(() => {
      timedOut = true
      if (promoteToBackground && child.pid) {
        const pid = child.pid
        const entry = { process: child, command, startedAt: nowTimestamp(), outputLines: [] }
        bgProcesses.set(pid, entry)
        child.stdout?.on('data', (data) => {
          const text = data.toString()
          entry.outputLines.push({ stream: 'stdout', text, ts: Date.now() })
          if (entry.outputLines.length > BG_OUTPUT_MAX_LINES) entry.outputLines.shift()
          emitEvent('process_output', { pid, stream: 'stdout', text: text.slice(0, 500) })
        })
        child.stderr?.on('data', (data) => {
          const text = data.toString()
          entry.outputLines.push({ stream: 'stderr', text, ts: Date.now() })
          if (entry.outputLines.length > BG_OUTPUT_MAX_LINES) entry.outputLines.shift()
          emitEvent('process_output', { pid, stream: 'stderr', text: text.slice(0, 500) })
        })
        child.on('exit', (code) => {
          console.log(`[exec_command] 提升后台进程 PID ${pid} 退出，code=${code}`)
          bgProcesses.delete(pid)
          emitEvent('process_exit', { pid, command, code })
        })
        finish(toolJson({
          ok: true,
          tool: 'exec_command',
          mode: 'promoted_to_background',
          command,
          cwd: execCwd,
          pid,
          stdout: trimCommandOutput(stdout),
          stderr: trimCommandOutput(stderr),
          hint: `Foreground timed out after ${timeoutMs / 1000}s — process promoted to background with pid ${pid}. Use list_processes to monitor it.`,
        }))
      } else {
        child.kill()
        finish(toolJson({
          ok: false,
          tool: 'exec_command',
          mode: 'foreground',
          command,
          cwd: execCwd,
          timed_out: true,
          timeout_ms: timeoutMs,
          stdout: trimCommandOutput(stdout),
          stderr: trimCommandOutput(stderr),
          error: `command timed out after ${timeoutMs / 1000}s`,
          hint: 'If this is a long-running server, rerun with background=true or set promote_to_background=true.',
        }))
      }
    }, timeoutMs)

    child.stdout?.on('data', (d) => {
      if (timedOut) return
      const text = d.toString()
      stdout += text
      emitEvent('exec_output', { mode: 'foreground', stream: 'stdout', command, text: text.slice(0, 300) })
    })
    child.stderr?.on('data', (d) => {
      if (timedOut) return
      const text = d.toString()
      stderr += text
      emitEvent('exec_output', { mode: 'foreground', stream: 'stderr', command, text: text.slice(0, 300) })
    })

    child.on('close', (code) => {
      if (timedOut) return
      finish(toolJson({
        ok: code === 0,
        tool: 'exec_command',
        mode: 'foreground',
        command,
        cwd: execCwd,
        exit_code: code,
        stdout: trimCommandOutput(stdout),
        stderr: trimCommandOutput(stderr),
        error: code === 0 ? null : `command exited with code ${code}`,
        hint: code === 0 ? 'Command completed successfully.' : 'Inspect stderr/stdout before retrying or changing the command.',
      }))
    })

    child.on('error', (err) => {
      if (timedOut) return
      finish(toolJson({
        ok: false,
        tool: 'exec_command',
        mode: 'foreground',
        command,
        cwd: execCwd,
        stdout: trimCommandOutput(stdout),
        stderr: trimCommandOutput(stderr),
        error: err.message,
      }))
    })
  })
}

// kill_process：停止后台进程（通过 PID）
async function execKillProcess(args) {
  const pid = Number(args.pid)
  if (!pid) return toolJson({ ok: false, tool: 'kill_process', error: 'missing pid' })
  const entry = bgProcesses.get(pid)
  if (!entry) return toolJson({ ok: false, tool: 'kill_process', pid, error: 'process not found or already exited' })
  entry.process.kill()
  bgProcesses.delete(pid)
  return toolJson({
    ok: true,
    tool: 'kill_process',
    pid,
    command: entry.command,
    stopped: true,
  })
}

// list_processes：列出当前后台进程，包含最近输出行
async function execListProcesses(args = {}) {
  const tailLines = Math.min(Number(args.tail) || 20, BG_OUTPUT_MAX_LINES)
  const processes = [...bgProcesses.entries()].map(([pid, { command, startedAt, outputLines }]) => ({
    pid,
    command,
    started_at: startedAt,
    recent_output: outputLines.slice(-tailLines).map(({ stream, text, ts }) => ({ stream, text, ts })),
  }))
  return toolJson({
    ok: true,
    tool: 'list_processes',
    count: processes.length,
    processes,
  })
}

const WEB_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
}

// 从 config.json 或 process.env 读取上网工具配置
// 5 秒内复用结果，避免一次 web_search 在 5 引擎 fallback 时同步读盘 5 次
let _webConfigCache = null
let _webConfigFetchedAt = 0
const WEB_CONFIG_TTL_MS = 5000

function readWebConfig() {
  const now = Date.now()
  if (_webConfigCache && now - _webConfigFetchedAt < WEB_CONFIG_TTL_MS) {
    return _webConfigCache
  }
  _webConfigCache = getWebSearchCredentials()
  _webConfigFetchedAt = now
  return _webConfigCache
}

// 单例浏览器：避免每次 browser_read 冷启动 Chromium（耗时 3~5 秒）
let _sharedBrowser = null
let _sharedBrowserLastUsed = 0
let _playwrightChromium = null
const BROWSER_IDLE_TIMEOUT_MS = 10 * 60 * 1000  // 闲置 10 分钟后关掉

async function getSharedBrowser() {
  const now = Date.now()
  if (_sharedBrowser && now - _sharedBrowserLastUsed > BROWSER_IDLE_TIMEOUT_MS) {
    try { await _sharedBrowser.close() } catch {}
    _sharedBrowser = null
  }
  if (!_sharedBrowser) {
    _sharedBrowser = await launchReadableBrowser()
  }
  _sharedBrowserLastUsed = Date.now()
  return _sharedBrowser
}

function invalidateSharedBrowser() {
  _sharedBrowser = null
}

const BROWSER_VIEWPORT = { width: 1365, height: 900 }

function webJson(payload) {
  return JSON.stringify(payload)
}

function normalizeWebUrl(raw) {
  const value = String(raw || '').trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  return `https://${value}`
}

function decodeHtmlEntities(value = '') {
  return String(value)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function htmlToText(html = '') {
  return decodeHtmlEntities(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractTitle(html = '') {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return match ? htmlToText(match[1]).slice(0, 200) : ''
}

function isLowValuePageText(text = '') {
  const compact = String(text || '').replace(/\s+/g, ' ').trim()
  if (compact.length < 80) return true
  return /^(please wait|just a moment|checking your browser|enable javascript|access denied|forbidden|captcha|安全验证|请稍候|请稍等|正在验证|访问受限)/i.test(compact)
}

// 长文阈值：抓取结果超过此长度时落盘，识别器只看摘要 + body_path
const ARTICLE_LENGTH_THRESHOLD = 2000
const ARTICLE_SUMMARY_EXCERPT = 800

function urlHash8(url) {
  return crypto.createHash('sha1').update(String(url || '')).digest('hex').slice(0, 8)
}

function sanitizeSlugPart(value, max = 40) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max)
}

// 把长文写入 sandbox/articles/{YYYY-MM}/{date}_{titleSlug}_{hash8}.md
// 同 URL 当天再次抓取直接复用已有文件，避免重复落盘
function saveLongArticle({ url, finalUrl, title, body, source }) {
  const now = new Date()
  const yyyyMm = now.toISOString().slice(0, 7)
  const date = now.toISOString().slice(0, 10)
  const hash = urlHash8(finalUrl || url || '')
  const titleSlug = sanitizeSlugPart(title)
  const baseName = titleSlug ? `${date}_${titleSlug}_${hash}.md` : `${date}_${hash}.md`

  const monthDir = path.join(SANDBOX_ROOT, 'articles', yyyyMm)
  const absPath = path.join(monthDir, baseName)
  const relPath = path.posix.join('articles', yyyyMm, baseName)

  if (fs.existsSync(absPath)) {
    return { path: relPath, bytes: fs.statSync(absPath).size, reused: true }
  }

  fs.mkdirSync(monthDir, { recursive: true })
  const frontmatter = [
    '---',
    `title: ${JSON.stringify(title || '')}`,
    `source_url: ${url || ''}`,
    finalUrl && finalUrl !== url ? `final_url: ${finalUrl}` : null,
    `source_tool: ${source || 'fetch_url'}`,
    `fetched_at: ${now.toISOString()}`,
    '---',
    '',
  ].filter(Boolean).join('\n')
  const content = frontmatter + (title ? `# ${title}\n\n` : '') + body
  fs.writeFileSync(absPath, content, 'utf-8')
  return { path: relPath, bytes: Buffer.byteLength(content, 'utf-8'), reused: false }
}

async function launchReadableBrowser() {
  const chromium = await getPlaywrightChromium()
  const launchOptions = { headless: true }
  try {
    return await chromium.launch(launchOptions)
  } catch (firstError) {
    for (const channel of ['msedge', 'chrome']) {
      try {
        return await chromium.launch({ ...launchOptions, channel })
      } catch {}
    }
    throw firstError
  }
}

async function getPlaywrightChromium() {
  if (_playwrightChromium) return _playwrightChromium
  try {
    const mod = await import('playwright')
    _playwrightChromium = mod.chromium
    return _playwrightChromium
  } catch (err) {
    throw new Error(`Playwright is not bundled in this build: ${err.message || String(err)}`)
  }
}

async function autoScrollPage(page, signal) {
  for (let i = 0; i < 4; i++) {
    throwIfAborted(signal)
    await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight, 800)))
    await page.waitForTimeout(450)
  }
  await page.evaluate(() => window.scrollTo(0, 0))
}

function unwrapDuckDuckGoUrl(url) {
  const decoded = decodeHtmlEntities(url)
  const uddg = decoded.match(/[?&]uddg=([^&]+)/)
  if (uddg) {
    try { return decodeURIComponent(uddg[1]) } catch { return uddg[1] }
  }
  if (decoded.startsWith('//')) return `https:${decoded}`
  return decoded
}

// Bing 搜索结果常用 bing.com/ck/a?...&u=a1<base64url> 中转链接；
// 不解包的话下游 fetch_url 会拿到跳转壳页而不是真正的目标页
function unwrapBingUrl(url) {
  try {
    if (!url || !/bing\.com\/ck\/a/i.test(url)) return url
    const u = new URL(url)
    const raw = u.searchParams.get('u')
    if (!raw) return url
    let encoded = raw.startsWith('a1') ? raw.slice(2) : raw
    encoded = encoded.replace(/-/g, '+').replace(/_/g, '/')
    while (encoded.length % 4) encoded += '='
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8')
    return /^https?:\/\//i.test(decoded) ? decoded : url
  } catch {
    return url
  }
}

function parseDuckDuckGoResults(html, limit) {
  const raw = []
  const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let match
  while ((match = resultRegex.exec(html)) !== null) {
    const url = unwrapDuckDuckGoUrl(match[1])
    const title = htmlToText(match[2])
    if (!url || !title) continue
    const nextStart = resultRegex.lastIndex
    const nextMatch = html.slice(nextStart).match(/<a[^>]+class="result__a"/i)
    const block = nextMatch ? html.slice(nextStart, nextStart + nextMatch.index) : html.slice(nextStart, nextStart + 2000)
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>|class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i)
    const snippet = htmlToText(snippetMatch?.[1] || snippetMatch?.[2] || '')
    raw.push({ title, url, snippet })
  }
  return normalizeResults(raw, limit)
}

// 引擎返回约定：
//   null                              → 未配置/跳过，不计入失败
//   { ok: true, results, source }     → 成功
//   { ok: false, reason }             → 已尝试但失败，reason 会聚合到最终错误
//
// reason 用简短可读字符串（"http 401"、"empty html"、"blocked or captcha"、"network: ..."），
// 让"key 失效"和"被限速"在日志里能分清楚

const SEARCH_TITLE_MAX = 200
const SEARCH_SNIPPET_MAX = 300
const SEARCH_LOG_QUERY_MAX = 100

function hasCJK(s) {
  return /[㐀-鿿豈-﫿]/.test(s)
}

function truncateForLog(s, max = SEARCH_LOG_QUERY_MAX) {
  const str = String(s || '')
  return str.length <= max ? str : `${str.slice(0, max)}…(${str.length})`
}

// 各引擎 raw 结果统一处理：截断超长字段、丢弃空 url/title、按 URL 去重（host+path，忽略 query/fragment）
function normalizeResults(raw, limit) {
  const out = []
  const seen = new Set()
  for (const r of raw) {
    const url = String(r?.url || '').trim()
    const title = String(r?.title || '').trim().slice(0, SEARCH_TITLE_MAX)
    if (!url || !title) continue
    let dedupKey
    try {
      const u = new URL(url)
      dedupKey = `${u.host}${u.pathname.replace(/\/$/, '')}`
    } catch {
      dedupKey = url
    }
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)
    out.push({
      title,
      url,
      snippet: String(r?.snippet || '').trim().slice(0, SEARCH_SNIPPET_MAX),
    })
    if (out.length >= limit) break
  }
  return out
}

// web_search 引擎1：Serper.dev（Google SERP JSON API，最稳定）
async function searchViaSerper(query, limit, signal) {
  const { serperKey } = readWebConfig()
  if (!serperKey) return null

  const merged = createMergedAbortSignal(signal, 12000)
  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': serperKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: query,
        num: limit,
        hl: hasCJK(query) ? 'zh-cn' : 'en',
        gl: hasCJK(query) ? 'cn' : 'us',
      }),
      signal: merged?.signal,
    })
    merged?.cleanup()
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? ' (check SERPER_API_KEY)' : ''
      return { ok: false, reason: `http ${res.status}${hint}` }
    }
    const data = await res.json()
    const raw = (data.organic || []).map(r => ({ title: r.title, url: r.link, snippet: r.snippet }))
    const results = normalizeResults(raw, limit)
    if (results.length === 0) return { ok: false, reason: 'empty results' }
    return { ok: true, results, source: 'serper' }
  } catch (err) {
    merged?.cleanup()
    if (err.name === 'AbortError') throw err
    return { ok: false, reason: `network: ${err.message || err}` }
  }
}

// web_search 引擎2：SearXNG（自托管，JSON API）
async function searchViaSearXNG(query, limit, signal) {
  const { searxngUrl } = readWebConfig()
  if (!searxngUrl) return null

  if (!/^https?:\/\//i.test(searxngUrl)) {
    return { ok: false, reason: 'SEARXNG_URL must start with http:// or https://' }
  }

  const base = searxngUrl.replace(/\/$/, '').replace(/\/search$/i, '')
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&pageno=1`
  const merged = createMergedAbortSignal(signal, 12000)
  try {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: merged?.signal })
    merged?.cleanup()
    if (!res.ok) return { ok: false, reason: `http ${res.status}` }
    const data = await res.json()
    const raw = (data.results || []).map(r => ({ title: r.title, url: r.url, snippet: r.content }))
    const results = normalizeResults(raw, limit)
    if (results.length === 0) return { ok: false, reason: 'empty results' }
    return { ok: true, results, source: 'searxng' }
  } catch (err) {
    merged?.cleanup()
    if (err.name === 'AbortError') throw err
    return { ok: false, reason: `network: ${err.message || err}` }
  }
}

// web_search 引擎3：Jina Search（s.jina.ai；无 key 时也能试，但现在 Jina 新版 API 要 key）
async function searchViaJina(query, limit, signal) {
  const { jinaKey } = readWebConfig()
  const url = `https://s.jina.ai/${encodeURIComponent(query)}`
  const merged = createMergedAbortSignal(signal, 18000)
  const headers = {
    'Accept': 'text/plain',
    'X-Respond-With': 'no-references',
    'User-Agent': WEB_HEADERS['User-Agent'],
  }
  if (jinaKey) headers['Authorization'] = `Bearer ${jinaKey}`
  try {
    const res = await fetch(url, { headers, signal: merged?.signal })
    merged?.cleanup()
    if (!res.ok) {
      let hint = ''
      if (res.status === 401 || res.status === 403) hint = jinaKey ? ' (check jina_api_key)' : ' (jina now requires api key, set it in 设置 → 上网)'
      else if (res.status === 429) hint = ' (rate-limited)'
      return { ok: false, reason: `http ${res.status}${hint}` }
    }
    const text = (await res.text()).trim()
    if (!text) return { ok: false, reason: 'empty body' }
    // 短到不可能是正常 SERP（Jina 限流时常返 200 + 几十字提示）
    if (text.length < 50) return { ok: false, reason: `short body (${text.length} chars, likely rate-limited)` }

    // Jina Search 返回格式：
    // [1] 标题
    // URL: https://...
    // Description: 摘要...
    //
    // [2] ...
    const raw = []
    const blocks = text.split(/\n(?=\[\d+\])/)
    for (const block of blocks) {
      const titleMatch = block.match(/^\[\d+\]\s*(.+)/)
      const urlMatch = block.match(/^URL:\s*(\S+)/m)
      const descMatch = block.match(/^Description:\s*(.+)/m)
      if (titleMatch && urlMatch) {
        raw.push({ title: titleMatch[1], url: urlMatch[1], snippet: descMatch?.[1] || '' })
      }
    }
    const results = normalizeResults(raw, limit)
    if (results.length === 0) return { ok: false, reason: 'parsed 0 results (format may have changed)' }
    return { ok: true, results, source: 'jina_search' }
  } catch (err) {
    merged?.cleanup()
    if (err.name === 'AbortError') throw err
    return { ok: false, reason: `network: ${err.message || err}` }
  }
}

// web_search 引擎3b：Bing（国内可访问，HTML 解析）
async function searchViaBing(query, limit, signal) {
  const searchUrl = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`
  const merged = createMergedAbortSignal(signal, 15000)
  try {
    const res = await fetch(searchUrl, {
      headers: { ...WEB_HEADERS, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: merged?.signal,
    })
    merged?.cleanup()
    if (!res.ok) return { ok: false, reason: `http ${res.status}` }
    const html = await res.text()
    // Bing 的 <li class="b_algo"> 不闭合 </li>，按下一个 b_algo 切块更稳
    const parts = html.split(/<li class="b_algo"/i).slice(1)
    const raw = []
    for (const part of parts) {
      // 标题在 <h2><a href="...">...内可能嵌 <strong>...</a></h2>
      const headerMatch = part.match(/<h2[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      if (!headerMatch) continue
      const url = unwrapBingUrl(headerMatch[1])
      const title = htmlToText(headerMatch[2])
      if (!title || !url) continue
      // 摘要：优先 b_lineclamp* / b_caption 内的 <p>，兜底取第一个有内容的 <p>
      const snippetMatch =
        part.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ||
        part.match(/class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) ||
        part.match(/<p[^>]*>([\s\S]{30,}?)<\/p>/i)
      const snippet = snippetMatch ? htmlToText(snippetMatch[1]) : ''
      raw.push({ title, url, snippet })
    }
    const results = normalizeResults(raw, limit)
    if (results.length === 0) {
      const blocked = /sorry|captcha|verify|访问被拒绝/i.test(html.slice(0, 4000))
      let reason
      if (blocked) reason = 'blocked or captcha'
      else if (parts.length === 0) reason = 'no b_algo found (layout may have changed)'
      else reason = `found ${parts.length} b_algo blocks but parsed 0 (h2>a structure may have changed)`
      return { ok: false, reason }
    }
    return { ok: true, results, source: 'bing' }
  } catch (err) {
    merged?.cleanup()
    if (err.name === 'AbortError') throw err
    return { ok: false, reason: `network: ${err.message || err}` }
  }
}

// web_search 引擎4：DuckDuckGo HTML（最后兜底，不稳定）
async function searchViaDDG(query, limit, signal) {
  const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const merged = createMergedAbortSignal(signal, 15000)
  try {
    const res = await fetch(searchUrl, { headers: WEB_HEADERS, signal: merged?.signal })
    merged?.cleanup()
    if (!res.ok) return { ok: false, reason: `http ${res.status}` }
    const html = await res.text()
    // DDG 返回 403/CAPTCHA 页时 HTML 中不含 result__a
    if (!html.includes('result__a')) return { ok: false, reason: 'blocked or captcha (no result__a)' }
    const results = parseDuckDuckGoResults(html, limit)
    if (results.length === 0) return { ok: false, reason: 'parsed 0 results' }
    return { ok: true, results, source: 'duckduckgo' }
  } catch (err) {
    merged?.cleanup()
    if (err.name === 'AbortError') throw err
    return { ok: false, reason: `network: ${err.message || err}` }
  }
}

async function execWebSearch(args, context = {}) {
  throwIfAborted(context.signal)
  const query = String(args.query || args.q || args.keyword || '').trim()
  const limit = Math.max(1, Math.min(Number(args.limit) || 5, 8))
  if (!query) return webJson({ ok: false, tool: 'web_search', error: 'missing query' })

  const cacheKey = `${query}::${limit}`
  const cached = searchCacheGet(cacheKey)
  if (cached) return webJson({ ...cached, cached: true })

  console.log(`[web_search] ${truncateForLog(query)}`)

  // 依次尝试：Serper → SearXNG → Bing（国内可访问）→ Jina Search → DuckDuckGo（兜底）
  const engines = [
    ['serper',   searchViaSerper],
    ['searxng',  searchViaSearXNG],
    ['bing',     searchViaBing],
    ['jina',     searchViaJina],
    ['ddg',      searchViaDDG],
  ]
  const failures = []
  for (const [name, engine] of engines) {
    throwIfAborted(context.signal)
    let result
    try {
      result = await engine(query, limit, context.signal)
    } catch (err) {
      if (err.name === 'AbortError') throw err
      failures.push({ engine: name, reason: `threw: ${err.message || err}` })
      console.log(`[web_search] ${name} threw: ${err.message || err}`)
      continue
    }
    if (result == null) continue  // 未配置
    if (result.ok) {
      const payload = {
        ok: true, tool: 'web_search', query,
        source: result.source,
        results: result.results,
        hint: 'Open 1-3 reliable result URLs with fetch_url, then answer the user.',
      }
      searchCacheSet(cacheKey, payload)
      return webJson(payload)
    }
    failures.push({ engine: name, reason: result.reason || 'unknown' })
    console.log(`[web_search] ${name} failed: ${result.reason || 'unknown'}`)
  }

  const summary = failures.length
    ? failures.map(f => `${f.engine}: ${f.reason}`).join('; ')
    : 'no engine configured'
  return webJson({
    ok: false, tool: 'web_search', query,
    error: `all search engines failed (${summary})`,
    failures,
    hint: 'All search engines failed. Try fetch_url with a known URL, or configure SERPER_API_KEY for reliable search.',
  })
}

// fetch_url 策略一：Jina Reader（r.jina.ai）
// 服务端 Chromium 渲染 + Mozilla Readability，免费无需 key，支持 JS 页面
async function fetchViaJina(url, signal) {
  const jinaUrl = `https://r.jina.ai/${url}`
  const merged = createMergedAbortSignal(signal, 20000)
  try {
    const res = await fetch(jinaUrl, {
      headers: {
        'Accept': 'text/plain',
        'X-Return-Format': 'markdown',
        'X-Timeout': '15',
        'User-Agent': WEB_HEADERS['User-Agent'],
      },
      signal: merged?.signal,
    })
    merged?.cleanup()
    if (!res.ok) return null
    const text = (await res.text()).trim()
    if (isLowValuePageText(text)) return null
    // Jina 返回格式：第一行是 "Title: xxx"，第二行空行，然后是正文 Markdown
    let title = ''
    let body = text
    const titleMatch = text.match(/^Title:\s*(.+)/m)
    if (titleMatch) {
      title = titleMatch[1].trim()
      body = text.replace(/^Title:.*\n?/m, '').replace(/^URL Source:.*\n?/m, '').replace(/^Markdown Content:\n?/m, '').trim()
    }
    return { title, body, source: 'jina' }
  } catch (err) {
    merged?.cleanup()
    if (err.name === 'AbortError') throw err
    return null
  }
}

// fetch_url 策略二：直接 HTTP + 正则 HTML 转文本（兜底，适合简单静态页）
async function fetchViaDirect(url, signal) {
  const merged = createMergedAbortSignal(signal, 12000)
  try {
    const res = await fetch(url, { headers: WEB_HEADERS, signal: merged?.signal })
    merged?.cleanup()
    if (!res.ok) return { ok: false, status: res.status }
    const contentType = res.headers.get('content-type') || ''
    if (contentType && !/text|html|xml|json/i.test(contentType)) {
      return { ok: false, status: res.status, content_type: contentType }
    }
    const html = await res.text()
    const text = htmlToText(html)
    const title = extractTitle(html)
    if (isLowValuePageText(text)) return { ok: false, status: res.status, title, low_value: true }
    return { ok: true, status: res.status, title, body: text }
  } catch (err) {
    merged?.cleanup()
    if (err.name === 'AbortError') throw err
    return { ok: false, error: err.message }
  }
}

// fetch_url: open a known URL, extract readable text, and return structured JSON.
async function execFetchUrl(args, context = {}) {
  throwIfAborted(context.signal)
  const url = normalizeWebUrl(args.url || args.URL || args.link || args.href || args.uri)
  if (!url) return webJson({ ok: false, tool: 'fetch_url', error: 'missing url' })

  const cached = urlCache.get(url)
  const ttl = getUrlTtl(url)
  if (cached && Date.now() - cached.fetchedAt < ttl) {
    const ageMin = Math.round((Date.now() - cached.fetchedAt) / 60000)
    return webJson({ ...cached.payload, cached: true, cache_age_minutes: ageMin })
  }

  console.log(`[fetch_url] -> ${url}`)

  // 策略一：Jina Reader（处理 JS 页面、Cloudflare 防护、内容提取质量最好）
  throwIfAborted(context.signal)
  let title = ''
  let text = ''
  let fetchSource = 'jina'
  let httpStatus = null

  const jinaResult = await fetchViaJina(url, context.signal)
  if (jinaResult) {
    title = jinaResult.title
    text = jinaResult.body
  } else {
    // 策略二：直接 HTTP（静态页面兜底）
    console.log(`[fetch_url] jina failed, trying direct: ${url}`)
    fetchSource = 'direct'
    const directResult = await fetchViaDirect(url, context.signal)
    httpStatus = directResult.status

    if (!directResult.ok) {
      const hint = directResult.low_value
        ? 'The page requires JavaScript or blocks crawlers. Use browser_read instead.'
        : 'This page could not be read. Use web_search to find another accessible source.'
      return webJson({
        ok: false, tool: 'fetch_url', url,
        status: directResult.status,
        content_type: directResult.content_type,
        error: directResult.error || (directResult.low_value ? 'no readable content' : `HTTP ${directResult.status}`),
        hint,
      })
    }
    title = directResult.title || ''
    text = directResult.body || ''
  }

  const MAX = 5000
  const isLong = text.length >= ARTICLE_LENGTH_THRESHOLD
  let bodyPath = null
  let bodyBytes = null
  if (isLong) {
    try {
      const saved = saveLongArticle({ url, finalUrl: url, title, body: text, source: fetchSource })
      bodyPath = saved.path
      bodyBytes = saved.bytes
    } catch (err) {
      console.warn(`[fetch_url] 长文落盘失败: ${err.message}`)
    }
  }
  const content = isLong
    ? `${text.slice(0, ARTICLE_SUMMARY_EXCERPT)}\n\n...`
    : (text.length > MAX ? `${text.slice(0, MAX)}\n\n...` : text)
  const payload = {
    ok: true,
    tool: 'fetch_url',
    url,
    status: httpStatus,
    fetch_source: fetchSource,
    title,
    content,
    truncated: isLong || text.length > MAX,
    content_length: text.length,
    body_path: bodyPath,
    body_bytes: bodyBytes,
    hint: bodyPath
      ? `Long article saved. Full text at sandbox path: ${bodyPath}. Use read_file to open it.`
      : 'Use this page content with other sources if needed, then answer the user.',
  }

  urlCache.set(url, { payload, fetchedAt: Date.now() })
  return webJson(payload)
}

async function execBrowserRead(args, context = {}) {
  throwIfAborted(context.signal)
  const url = normalizeWebUrl(args.url || args.URL || args.link || args.href || args.uri)
  if (!url) return webJson({ ok: false, tool: 'browser_read', error: 'missing url' })

  const timeoutMs = Math.max(5000, Math.min(Number(args.timeout_ms || args.timeout || 20000), 45000))
  const maxChars = Math.max(1000, Math.min(Number(args.max_chars || args.maxChars || 8000), 12000))
  console.log(`[browser_read] -> ${url}`)

  let browserContext = null
  let page = null
  try {
    // 复用单例浏览器，避免每次冷启动 Chromium（约 3~5 秒）
    const browser = await getSharedBrowser()
    browserContext = await browser.newContext({
      viewport: BROWSER_VIEWPORT,
      locale: 'zh-CN',
      userAgent: WEB_HEADERS['User-Agent'],
    })
    page = await browserContext.newPage()
    page.setDefaultTimeout(timeoutMs)
    page.setDefaultNavigationTimeout(timeoutMs)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    // networkidle 可能挂死，限制等待时间
    await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 8000) }).catch(() => {})
    await autoScrollPage(page, context.signal)

    const title = (await page.title()).trim()
    const text = await page.evaluate(() => {
      ;['script', 'style', 'noscript', 'svg', 'canvas', 'iframe', 'header', 'footer', 'nav'].forEach(
        tag => document.querySelectorAll(tag).forEach(el => el.remove())
      )
      // 优先取语义容器，取文本最长的那个
      const candidates = [
        ...document.querySelectorAll('article, main, [role="main"], .article, .post, .content, .entry-content, #content, #main'),
      ]
      const best = candidates
        .map(el => ({ el, text: (el.innerText || '').trim() }))
        .sort((a, b) => b.text.length - a.text.length)[0]
      return (best?.text && best.text.length > 300 ? best.text : document.body?.innerText || '').trim()
    })
    const finalUrl = page.url()

    if (isLowValuePageText(text)) {
      return webJson({
        ok: false,
        tool: 'browser_read',
        url,
        final_url: finalUrl,
        title,
        error: 'no readable content rendered',
        content_preview: String(text || '').slice(0, 300),
        content_length: String(text || '').length,
        hint: 'The browser opened the page, but did not find readable article text. The page may require login, CAPTCHA, or block automation. Try another source.',
      })
    }

    const isLong = text.length >= ARTICLE_LENGTH_THRESHOLD
    let bodyPath = null
    let bodyBytes = null
    if (isLong) {
      try {
        const saved = saveLongArticle({ url, finalUrl, title, body: text, source: 'browser_read' })
        bodyPath = saved.path
        bodyBytes = saved.bytes
      } catch (err) {
        console.warn(`[browser_read] 长文落盘失败: ${err.message}`)
      }
    }
    const content = isLong
      ? `${text.slice(0, ARTICLE_SUMMARY_EXCERPT)}\n\n...`
      : (text.length > maxChars ? `${text.slice(0, maxChars)}\n\n...` : text)
    return webJson({
      ok: true,
      tool: 'browser_read',
      url,
      final_url: finalUrl,
      title,
      content,
      truncated: isLong || text.length > maxChars,
      content_length: text.length,
      body_path: bodyPath,
      body_bytes: bodyBytes,
      hint: bodyPath
        ? `Long article saved. Full text at sandbox path: ${bodyPath}. Use read_file to open it.`
        : 'Rendered page content extracted by Chromium.',
    })
  } catch (err) {
    if (err.name === 'AbortError') throw err
    // 浏览器崩溃或断开时，清掉单例让下次重建
    invalidateSharedBrowser()
    return webJson({
      ok: false,
      tool: 'browser_read',
      url,
      error: err.message || String(err),
      hint: 'Browser rendering failed. Try fetch_url or another accessible source.',
    })
  } finally {
    // 关 context（含页面），不关 browser（单例复用）
    try { await page?.close() } catch {}
    try { await browserContext?.close() } catch {}
  }
}

// search_memory：批量按关键词检索记忆。
// 优先走 keywords 数组；为兼容旧调用方，单字符串 keyword 也接受（自动转数组）。
// 输入有 keywords 时返回 JSON 字符串（结构化命中 + matched_by），用于识别器查重。
// 输入只有 keyword 时返回旧版拼接字符串，用于主对话主动检索。
async function execSearchMemory(args = {}) {
  const { keyword, limit, limit_per_keyword, type_filter } = args

  // XML tool call parser passes array values as JSON strings — parse if needed
  let keywords = args.keywords
  if (typeof keywords === 'string') {
    try { keywords = JSON.parse(keywords) } catch { keywords = [keywords] }
  }

  if (Array.isArray(keywords) && keywords.length > 0) {
    const cleaned = keywords.map(k => String(k || '').trim()).filter(Boolean).slice(0, 8)
    if (cleaned.length === 0) return JSON.stringify({ ok: false, error: 'no valid keywords' })
    const hits = searchMemoriesByKeywords(cleaned, {
      limitPerKeyword: Math.max(1, Math.min(Number(limit_per_keyword || 5), 10)),
      typeFilter: type_filter || null,
    })
    return JSON.stringify({ ok: true, count: hits.length, hits }, null, 2)
  }

  if (keyword) {
    const rows = searchMemories(keyword, Math.max(1, Math.min(Number(limit || 5), 20)))
    if (rows.length === 0) return `未找到包含"${keyword}"的记忆`
    return rows.map(m =>
      `[${m.timestamp.slice(0, 10)}] ${m.event_type}: ${m.content}\n  ${m.detail?.slice(0, 100) ?? ''}`
    ).join('\n\n')
  }

  return '错误：未提供 keywords 或 keyword'
}

// upsert_memory：识别器调用，按 mem_id 批量 upsert。
async function execUpsertMemory(args = {}, context = {}) {
  let list = null

  if (Array.isArray(args.memories)) {
    list = args.memories
  } else if (typeof args.memories === 'string') {
    // XML tool call parser passes all parameter values as strings — try to parse JSON
    try { const parsed = JSON.parse(args.memories); if (Array.isArray(parsed)) list = parsed } catch {}
  }

  // LLM forgot the memories[] wrapper and put fields at top level — auto-wrap
  if (!list && args.mem_id) {
    list = [args]
  }

  if (!list || list.length === 0) {
    return JSON.stringify({
      ok: false,
      error: 'missing memories[]',
      hint: 'Pass memories as an array: upsert_memory({ memories: [{ mem_id, type, title, content }] })',
    })
  }

  const sourceRef = context.sessionRef || context.source_ref || null
  // 同批次：无 parent 的先写，有 parent 的后写，保证父节点 mem_id 已就绪
  const roots = list.filter(m => !m.parent_mem_id)
  const children = list.filter(m => m.parent_mem_id)
  const ordered = [...roots, ...children]

  const results = []
  for (const memory of ordered) {
    try {
      // 只对 fact 兜底：fact 绝大多数是关于用户的稳定事实/偏好；
      // person/object/article/knowledge 有各自主体，不该粘上 sender ID
      const isFact = memory.type === 'fact' || (!memory.type && typeof memory.mem_id === 'string' && memory.mem_id.startsWith('fact_'))
      const entitiesEmpty = !Array.isArray(memory.entities) || memory.entities.length === 0
      // 只对新记忆兜底，避免 UPDATE 覆盖旧 entities
      if (entitiesEmpty && isFact && context.senderId && !memoryExistsByMemId(memory.mem_id)) {
        memory.entities = [context.senderId]
        console.log(`[识别器] entities 兜底注入: mem_id=${memory.mem_id} entities=[${context.senderId}]`)
      }
      const payload = { ...memory, source_ref: memory.source_ref || sourceRef }
      const r = upsertMemoryByMemId(payload)
      results.push({ mem_id: r.mem_id, action: r.updated ? 'updated' : 'inserted', id: r.id })
    } catch (err) {
      results.push({ mem_id: memory.mem_id || null, action: 'error', error: err.message })
    }
  }

  const inserted = results.filter(r => r.action === 'inserted').length
  const updated = results.filter(r => r.action === 'updated').length
  const failed = results.filter(r => r.action === 'error').length
  return JSON.stringify({ ok: failed === 0, inserted, updated, failed, results }, null, 2)
}

// skip_recognition：识别器明确表示无内容要存
async function execSkipRecognition({ reason } = {}) {
  return JSON.stringify({ ok: true, skipped: true, reason: reason || '' })
}

// merge_memories：整合器合并多条语义重复记忆。
// keep 被 PATCH 更新；drops 不再硬删除，改为软隐藏（visibility=0, merged_into=keep_mem_id）。
// 软隐藏的记忆 search/get* 不会再返回，但行、FTS5 索引、embedding 完整保留，
// 第 3 步专注帧机制可凭 mem_id 复活；merged_into 字段也保证可追踪合并去向。
async function execMergeMemories(args = {}, context = {}) {
  const { keep_mem_id, drop_mem_ids, merged_content, merged_salience, reason } = args
  if (!keep_mem_id || !Array.isArray(drop_mem_ids) || drop_mem_ids.length === 0 || !merged_content) {
    return JSON.stringify({ ok: false, error: 'missing keep_mem_id / drop_mem_ids[] / merged_content' })
  }

  const keep = getMemoryByMemId(keep_mem_id)
  if (!keep) return JSON.stringify({ ok: false, error: `keep_mem_id not found: ${keep_mem_id}` })

  let mergedEntities = []
  try { mergedEntities = JSON.parse(keep.entities || '[]') } catch {}
  let maxSalience = keep.salience || 3
  const drops = []
  for (const dmid of drop_mem_ids) {
    if (dmid === keep_mem_id) continue
    const d = getMemoryByMemId(dmid)
    if (!d) continue
    drops.push(d)
    try {
      const de = JSON.parse(d.entities || '[]')
      mergedEntities = [...mergedEntities, ...de]
    } catch {}
    if ((d.salience || 3) > maxSalience) maxSalience = d.salience || 3
  }
  mergedEntities = [...new Set(mergedEntities)]

  const finalSalience = merged_salience !== undefined ? merged_salience : maxSalience

  upsertMemoryByMemId({
    mem_id: keep_mem_id,
    content: merged_content,
    entities: mergedEntities,
    salience: finalSalience,
  })

  const hiddenAt = new Date().toISOString()
  const hidden = []
  for (const d of drops) {
    if (hideMemoryByMemId(d.mem_id, { mergedInto: keep_mem_id, hiddenAt })) {
      hidden.push(d.mem_id)
    }
  }

  console.log(`[整合器] merge: keep=${keep_mem_id} hidden=[${hidden.join(',')}] merged_into=${keep_mem_id} salience=${finalSalience} reason="${reason || ''}"`)
  emitEvent('memory_consolidated', {
    action: 'merge',
    keep_mem_id,
    hidden,
    // 'dropped' 字段保留作为向后兼容（旧 UI / 日志消费者仍期望此键），
    // 但语义已从"已删除"变为"已软隐藏"——读者请以 'hidden' 为准。
    dropped: hidden,
    merged_into: keep_mem_id,
    salience: finalSalience,
    reason: reason || '',
  })

  return JSON.stringify({ ok: true, action: 'merge', keep_mem_id, hidden, dropped: hidden, merged_into: keep_mem_id, salience: finalSalience })
}

// downgrade_memory：整合器降低记忆的 salience（不删，保留信号）
async function execDowngradeMemory(args = {}) {
  const { mem_id, new_salience, reason } = args
  if (!mem_id || new_salience === undefined) {
    return JSON.stringify({ ok: false, error: 'missing mem_id or new_salience' })
  }
  const before = getMemoryByMemId(mem_id)
  if (!before) return JSON.stringify({ ok: false, error: `mem_id not found: ${mem_id}` })
  upsertMemoryByMemId({ mem_id, salience: new_salience })
  console.log(`[整合器] downgrade: ${mem_id} ${before.salience || 3} → ${new_salience} reason="${reason || ''}"`)
  emitEvent('memory_consolidated', {
    action: 'downgrade',
    mem_id,
    before: before.salience || 3,
    after: new_salience,
    reason: reason || '',
  })
  return JSON.stringify({ ok: true, action: 'downgrade', mem_id, before: before.salience || 3, after: new_salience })
}

// skip_consolidation：整合器显式表示本批无需操作
async function execSkipConsolidation({ reason } = {}) {
  return JSON.stringify({ ok: true, skipped: true, reason: reason || '' })
}

// speak：将文字转为语音，保存为音频文件
// 有效的 MiniMax 声音 ID
const VALID_VOICE_IDS = new Set([
  'male-qn-qingse', 'male-qn-jingying', 'male-qn-badao', 'male-qn-daxuesheng',
  'female-shaonv', 'female-yujie', 'female-chengshu', 'female-tianmei',
  'presenter_male', 'presenter_female', 'audiobook_male_1', 'audiobook_female_1',
])
const DEFAULT_VOICE = 'male-qn-qingse'

async function execSpeak(args) {
  const text = args.text || args.content || args.words || args.speech
  const { filename } = args
  console.log(`[speak] args:`, JSON.stringify(args))
  if (!text) return '错误：未提供要朗读的文字'
  if (isDailyLimitReached('tts')) return '错误：今日 TTS 配额已用完'
  if (text.length > 1000) return `错误：文字过长（${text.length} 字），请控制在 1000 字以内`

  const creds = getTTSCredentials()
  const voiceId = (args.voice_id || args.voice) || creds.voiceId

  const nodeStream = await streamTTS({ text, provider: creds.provider, voiceId, keys: creds })
  const chunks = []
  for await (const chunk of nodeStream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const buffer = Buffer.concat(chunks)

  const ts = nowTimestamp().replace(/[:.+]/g, '-').slice(0, 19)
  const fname = filename ? filename.replace(/[^a-zA-Z0-9_一-龥-]/g, '') + '.mp3' : `speech_${ts}.mp3`
  const resolved = path.resolve(SANDBOX_ROOT, 'audio', fname)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, buffer)

  const relPath = `audio/${fname}`
  emitEvent('audio_created', { path: relPath, text: text.slice(0, 60), autoPlay: true })
  console.log(`[speak] 已生成: ${relPath}`)
  return `语音已生成：${relPath}`
}

// ─── 工具市场执行函数 ──────────────────────────────────────────────────────────

async function execInstallTool(args) {
  const { name, description, parameters_schema, code } = args
  return await installTool({ name, description, parameters: parameters_schema, code })
}

function execUninstallTool(args) {
  return uninstallTool({ name: args.name })
}

function execListTools() {
  const builtins = Object.entries(TOOL_SCHEMAS)
    .filter(([name]) => name !== 'express')
    .map(([name, s]) => ({ name, description: s.function.description, source: 'builtin' }))
  const installed = listInstalledTools()
  const all = [...builtins, ...installed]
  const lines = all.map(t => `[${t.source}] ${t.name}: ${t.description}`)
  return `共 ${all.length} 个工具（${builtins.length} 内置 + ${installed.length} 已安装）：\n\n${lines.join('\n')}`
}

// 语音消息自动回复 TTS：检测到用户用语音输入时，通知前端播放语音
// 由 index.js 调用，前端收到 tts_reply 事件后调用 /tts/stream 完成实际合成
export function autoSpeakForVoiceReply(text) {
  if (!text) return
  const plain = text.trim()
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
    .replace(/!\[[^\]]*\]\([^\)]+\)/g, '')
    .replace(/\n+/g, ' ')
    .trim()
  if (!plain) return
  emitEvent('tts_reply', { text: plain })
}

// generate_lyrics：生成歌词
async function execGenerateLyrics({ prompt, mode }) {
  if (!prompt) return '错误：未提供创作方向'
  if (isDailyLimitReached('lyrics')) return '错误：今日歌词生成配额已用完'

  const result = await callCapability('lyrics', { prompt, mode })

  // 自动保存歌词到 sandbox
  const ts = nowTimestamp().replace(/[:.+]/g, '-').slice(0, 19)
  const fname = `lyrics_${ts}.txt`
  const content = `# ${result.title}\n风格：${result.style}\n\n${result.lyrics}`
  const resolved = path.resolve(SANDBOX_ROOT, 'lyrics', fname)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, content, 'utf-8')

  emitEvent('lyrics_created', { path: `lyrics/${fname}`, title: result.title })
  return `歌词已生成并保存至 lyrics/${fname}\n\n标题：${result.title}\n风格：${result.style}\n\n${result.lyrics}`
}

// generate_music：生成音乐
async function execGenerateMusic({ prompt, lyrics, instrumental }) {
  if (!prompt) return '错误：未提供音乐描述'
  if (isDailyLimitReached('music')) return '错误：今日音乐生成配额已用完'

  const result = await callCapability('music', { prompt, lyrics, instrumental })

  const ts = nowTimestamp().replace(/[:.+]/g, '-').slice(0, 19)
  const fname = `music_${ts}.mp3`
  const resolved = path.resolve(SANDBOX_ROOT, 'music', fname)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, result.buffer)

  const relPath = `music/${fname}`
  emitEvent('music_created', { path: relPath, prompt: prompt.slice(0, 60) })
  console.log(`[music] 已生成: ${relPath}`)
  return `音乐已生成：${relPath}（时长约 ${result.duration ?? '?'} 秒）`
}

// generate_image：生成图片
async function execGenerateImage({ prompt, aspect_ratio = '1:1', n = 1 }) {
  if (!prompt) return '错误：未提供图片描述'
  if (isDailyLimitReached('image')) return '错误：今日图片生成配额已用完（50 次/天）'
  const validRatios = new Set(['1:1', '16:9', '4:3', '3:4', '9:16'])
  const ratio = validRatios.has(aspect_ratio) ? aspect_ratio : '1:1'
  const count = Math.min(Math.max(Math.floor(n) || 1, 1), 4)

  const result = await callCapability('image', { prompt, aspect_ratio: ratio, n: count })

  emitEvent('image_created', { urls: result.urls, prompt: prompt.slice(0, 60) })
  console.log(`[image] 已生成 ${result.urls.length} 张图片`)
  return `图片已生成（${result.urls.length} 张）：\n${result.urls.join('\n')}`
}

// manage_prefetch_task：管理预热任务
function execManagePrefetchTask({ action, source, label, url, ttl_minutes, tags }) {
  if (action === 'list') {
    const tasks = listPrefetchTasks()
    if (tasks.length === 0) return '当前没有预热任务。'
    return tasks.map(t =>
      `[${t.enabled ? '✓' : '✗'}] ${t.source}  ${t.label}  TTL=${t.ttl_minutes}min\n  URL: ${t.url}`
    ).join('\n')
  }

  if (action === 'add') {
    if (!source) return '错误：缺少 source'
    if (!label) return '错误：缺少 label'
    if (!url) return '错误：缺少 url'
    upsertPrefetchTask({ source, label, url, ttlMinutes: ttl_minutes ?? 60, tags: tags ?? [] })
    return `预热任务已保存：${source}（${label}），TTL=${ttl_minutes ?? 60}min。下次运行预热时生效。`
  }

  if (action === 'remove') {
    if (!source) return '错误：缺少 source'
    const ok = removePrefetchTask(source)
    return ok ? `预热任务已删除：${source}` : `未找到任务：${source}`
  }

  return `错误：未知 action "${action}"，可选 add / remove / list`
}

// set_tick_interval：L2 调节自身思维节奏
function execSetTickInterval({ seconds, ttl, reason }) {
  const res = setTickerInterval({ seconds, ttl, reason })
  if (!res.ok) return `错误：${res.error}`
  const parts = [`节奏已设为 ${res.seconds}s，持续 ${res.ttl} 轮`]
  if (res.clampedFrom?.seconds !== undefined) parts.push(`（seconds ${res.clampedFrom.seconds} 越界，已 clamp 到 ${res.seconds}）`)
  if (res.clampedFrom?.ttl !== undefined) parts.push(`（ttl ${res.clampedFrom.ttl} 越界，已 clamp 到 ${res.ttl}）`)
  return parts.join('')
}

// ─────────────────────────────────────────────────────────────────────────────
// ACUI · UI 控制工具
// ─────────────────────────────────────────────────────────────────────────────
function execMediaMode(args = {}) {
  const mode = String(args.mode || args.kind || '').trim()
  const action = String(args.action || 'show').trim()
  if (!['video', 'camera', 'image', 'music'].includes(mode)) {
    return JSON.stringify({ ok: false, tool: 'media_mode', error: 'mode must be video, camera, image, or music' })
  }
  if (!['show', 'hide', 'close', 'play', 'pause', 'seek', 'set_volume', 'update'].includes(action)) {
    return JSON.stringify({ ok: false, tool: 'media_mode', error: 'unsupported action' })
  }

  const payload = {
    mode,
    action,
    url: typeof args.url === 'string' ? args.url : undefined,
    src: typeof args.src === 'string' ? args.src : undefined,
    title: typeof args.title === 'string' ? args.title : undefined,
    artist: typeof args.artist === 'string' ? args.artist : undefined,
    lrc: typeof args.lrc === 'string' ? args.lrc : undefined,
    cover: typeof args.cover === 'string' ? args.cover : undefined,
    alt: typeof args.alt === 'string' ? args.alt : undefined,
    autoplay: typeof args.autoplay === 'boolean' ? args.autoplay : (mode === 'music' ? true : undefined),
    muted: typeof args.muted === 'boolean' ? args.muted : undefined,
    camera: mode === 'camera' || args.camera === true,
  }

  if (Number.isFinite(Number(args.volume))) {
    payload.volume = Math.max(0, Math.min(1, Number(args.volume)))
  }
  if (Number.isFinite(Number(args.currentTime ?? args.time ?? args.seek))) {
    payload.currentTime = Math.max(0, Number(args.currentTime ?? args.time ?? args.seek))
  }

  emitEvent('media_mode', payload)
  emitEvent('action', { tool: 'media_mode', summary: `${mode}:${action}`, detail: payload.title || payload.url || '' })
  return JSON.stringify({ ok: true, tool: 'media_mode', ...payload })
}

function execHotspotMode(args = {}) {
  const action = String(args.action || 'status').trim().toLowerCase()
  if (!['show', 'open', 'hide', 'close', 'toggle', 'status'].includes(action)) {
    return JSON.stringify({ ok: false, tool: 'hotspot_mode', error: 'unsupported action' })
  }

  let nextActive = null
  if (action === 'show' || action === 'open') nextActive = true
  if (action === 'hide' || action === 'close') nextActive = false
  if (action === 'toggle') nextActive = !getHotspotPanelState().active

  const state = typeof nextActive === 'boolean'
    ? setHotspotPanelState({ active: nextActive, source: 'agent_tool' })
    : getHotspotPanelState()

  if (typeof nextActive === 'boolean') {
    emitEvent('hotspot_mode', {
      action: state.active ? 'show' : 'hide',
      active: state.active,
      reason: typeof args.reason === 'string' ? args.reason : '',
    })
    emitEvent('action', {
      tool: 'hotspot_mode',
      summary: state.active ? '打开热点面板' : '关闭热点面板',
      detail: args.reason || '',
    })
  }

  return JSON.stringify({ ok: true, tool: 'hotspot_mode', state })
}

function execOpenDocPanel(args = {}) {
  const action = String(args.action || 'open').trim().toLowerCase()
  const nextActive = action !== 'close'
  const validTopics = ['voice_asr', 'voice_tts', 'voice_config']

  // 打开时 topic 必填；关闭时 topic 可省略（沿用当前面板已有的 topicId）
  let topic = args.topic ? String(args.topic).trim() : null
  if (nextActive && topic && !validTopics.includes(topic)) {
    if (/asr|识别|麦克风/.test(topic)) topic = 'voice_asr'
    else if (/tts|合成|声音/.test(topic)) topic = 'voice_tts'
    else topic = 'voice_config'
  }

  const state = setDocPanelState({ active: nextActive, topicId: topic, source: 'agent_tool' })

  const effectiveTopic = topic || state.topicId
  emitEvent('doc_panel_mode', {
    action: nextActive ? 'open' : 'close',
    active: nextActive,
    topic: effectiveTopic,
    reason: typeof args.reason === 'string' ? args.reason : '',
  })
  emitEvent('action', {
    tool: 'open_doc_panel',
    summary: nextActive ? `打开文档面板（${effectiveTopic}）` : '关闭文档面板',
    detail: args.reason || '',
  })

  return JSON.stringify({ ok: true, tool: 'open_doc_panel', topic: effectiveTopic, state })
}

function execPersonCardMode(args = {}) {
  const action = String(args.action || 'status').trim().toLowerCase()
  if (!['show', 'open', 'hide', 'close', 'update', 'toggle', 'status'].includes(action)) {
    return JSON.stringify({ ok: false, tool: 'person_card_mode', error: 'unsupported action' })
  }

  let nextActive = null
  if (action === 'show' || action === 'open' || action === 'update') nextActive = true
  if (action === 'hide' || action === 'close') nextActive = false
  if (action === 'toggle') nextActive = !getPersonCardPanelState().active

  const name = String(args.name || args.person || '').trim()
  const card = {
    ...(name ? getPersonCard(name) : {}),
    ...(args.card && typeof args.card === 'object' ? args.card : {}),
  }
  if (name) card.name = name
  for (const key of ['title', 'summary', 'image', 'avatar', 'source']) {
    if (typeof args[key] === 'string' && args[key].trim()) card[key] = args[key].trim()
  }
  if (Array.isArray(args.knownFor) || typeof args.knownFor === 'string') card.knownFor = args.knownFor
  if (Array.isArray(args.tags) || typeof args.tags === 'string') card.tags = args.tags
  if (Array.isArray(args.aliases) || typeof args.aliases === 'string') card.aliases = args.aliases

  const state = typeof nextActive === 'boolean'
    ? setPersonCardPanelState({
        active: nextActive,
        source: 'agent_tool',
        card: (card.name || card.summary || card.title) ? card : null,
        name,
      })
    : getPersonCardPanelState()

  if (typeof nextActive === 'boolean') {
    emitEvent('person_card_mode', {
      action: state.active ? 'show' : 'hide',
      active: state.active,
      card: state.card,
      reason: typeof args.reason === 'string' ? args.reason : '',
    })
    emitEvent('action', {
      tool: 'person_card_mode',
      summary: state.active ? `打开人物卡片${state.card?.name ? `：${state.card.name}` : ''}` : '关闭人物卡片',
      detail: args.reason || '',
    })
  }

  return JSON.stringify({ ok: true, tool: 'person_card_mode', state })
}

// ── Music Library ─────────────────────────────────────────────────────────────

const MUSIC_AUDIO_EXTS = new Set(['.mp3', '.flac', '.wav', '.aac', '.ogg', '.m4a', '.opus'])

async function fetchLrcFromNet(title, artist) {
  const headers = { 'User-Agent': 'BaiLongma/1.0' }
  // 策略1：精确匹配（title + artist）
  try {
    const params = new URLSearchParams({ track_name: title })
    if (artist) params.set('artist_name', artist)
    const res = await fetch(`https://lrclib.net/api/get?${params}`, {
      signal: AbortSignal.timeout(8000), headers,
    })
    if (res.ok) {
      const data = await res.json()
      const lrc = data.syncedLyrics || data.plainLyrics || null
      if (lrc) return lrc
    }
  } catch {}
  // 策略2：仅 title 关键词搜索，取第一条结果
  try {
    const params = new URLSearchParams({ q: title })
    const res = await fetch(`https://lrclib.net/api/search?${params}`, {
      signal: AbortSignal.timeout(8000), headers,
    })
    if (res.ok) {
      const list = await res.json()
      if (Array.isArray(list) && list.length > 0) {
        const hit = list[0]
        return hit.syncedLyrics || hit.plainLyrics || null
      }
    }
  } catch {}
  return null
}

function decodeProcessOutput(chunks) {
  const buffer = Buffer.concat(chunks)
  if (buffer.length === 0) return ''

  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
  if (!utf8.includes('\uFFFD') || !IS_WIN) return utf8

  try {
    return new TextDecoder('gb18030', { fatal: false }).decode(buffer)
  } catch {
    return utf8
  }
}

function runProcess(file, args = [], cwd) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: cwd || paths.musicDir,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
    })
    const stdoutChunks = []
    const stderrChunks = []
    child.stdout?.on('data', d => { stdoutChunks.push(Buffer.from(d)) })
    child.stderr?.on('data', d => { stderrChunks.push(Buffer.from(d)) })
    child.on('close', code => resolve({
      code,
      stdout: decodeProcessOutput(stdoutChunks),
      stderr: decodeProcessOutput(stderrChunks),
    }))
    child.on('error', err => resolve({
      code: -1,
      stdout: decodeProcessOutput(stdoutChunks),
      stderr: err.message,
    }))
  })
}

const YTDLP_LOCAL = path.join(paths.musicDir, 'yt-dlp.exe')
const YTDLP_URL   = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'

async function resolveYtDlp() {
  // 1. 系统 PATH 里有就直接用
  const sys = await runProcess('yt-dlp', ['--version'], paths.musicDir)
  if (sys.code === 0) return 'yt-dlp'

  // 2. music 目录里有本地副本就用它
  if (fs.existsSync(YTDLP_LOCAL)) {
    const local = await runProcess(YTDLP_LOCAL, ['--version'], paths.musicDir)
    if (local.code === 0) return YTDLP_LOCAL
  }

  // 3. 自动下载 yt-dlp.exe 到 music 目录
  emitEvent('action', { tool: 'music', summary: 'yt-dlp 未安装，正在自动下载…', detail: YTDLP_URL })
  const res = await fetch(YTDLP_URL, { signal: AbortSignal.timeout(60000) })
  if (!res.ok) return null
  const buf = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(YTDLP_LOCAL, buf)
  fs.chmodSync(YTDLP_LOCAL, 0o755)
  return YTDLP_LOCAL
}

async function execMusic(args = {}) {
  const action = String(args.action || 'list').trim()
  const musicDir = paths.musicDir

  // ── list ──────────────────────────────────────────────────────────────────
  if (action === 'list') {
    const rows = listMusicLibrary(Number(args.limit) || 50)
    return JSON.stringify({ ok: true, count: rows.length, tracks: rows })
  }

  // ── search ────────────────────────────────────────────────────────────────
  if (action === 'search') {
    const q = String(args.query || '').trim()
    if (!q) return JSON.stringify({ ok: false, error: 'query required' })
    const rows = searchMusicLibrary(q, Number(args.limit) || 20)
    return JSON.stringify({ ok: true, count: rows.length, tracks: rows })
  }

  // ── scan ──────────────────────────────────────────────────────────────────
  if (action === 'scan') {
    const entries = fs.readdirSync(musicDir, { withFileTypes: true })
    const added = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (!MUSIC_AUDIO_EXTS.has(ext)) continue
      const filePath = path.join(musicDir, entry.name)
      const baseName = path.basename(entry.name, ext)
      const track = upsertMusicTrack({ title: baseName, filePath })
      added.push({ id: track.id, title: track.title, file_path: track.file_path })
    }
    return JSON.stringify({ ok: true, scanned: added.length, tracks: added })
  }

  // ── add ───────────────────────────────────────────────────────────────────
  if (action === 'add') {
    const filePath = String(args.path || '').trim()
    if (!filePath) return JSON.stringify({ ok: false, error: 'path required' })
    if (!fs.existsSync(filePath)) return JSON.stringify({ ok: false, error: `file not found: ${filePath}` })
    const ext = path.extname(filePath).toLowerCase()
    if (!MUSIC_AUDIO_EXTS.has(ext)) return JSON.stringify({ ok: false, error: `unsupported format: ${ext}` })
    const baseName = path.basename(filePath, ext)
    const track = upsertMusicTrack({
      title: String(args.title || baseName),
      artist: String(args.artist || ''),
      album: String(args.album || ''),
      filePath,
    })
    return JSON.stringify({ ok: true, track })
  }

  // ── download ──────────────────────────────────────────────────────────────
  if (action === 'download') {
    const url = String(args.url || '').trim()
    if (!url) return JSON.stringify({ ok: false, error: 'url required' })

    // 自动解析 yt-dlp 路径（没有则自动下载）
    const ytdlp = await resolveYtDlp()
    if (!ytdlp) return JSON.stringify({ ok: false, error: 'yt-dlp 自动下载失败，请检查网络连接' })

    // Download: print final filepath after conversion
    const outTemplate = path.join(musicDir, '%(title)s.%(ext)s').replace(/\\/g, '/')
    const dlArgs = ['-x', '--audio-format', 'mp3', '--audio-quality', '192K', '--no-playlist', '--print', 'after_move:filepath', '-o', outTemplate]
    let result = await runProcess(ytdlp, [...dlArgs, url])

    // SSL 握手失败时降级：加 --no-check-certificates 重试一次
    if (result.code !== 0 && /ssl|EOF occurred in violation of protocol/i.test(result.stderr)) {
      result = await runProcess(ytdlp, [...dlArgs, '--no-check-certificates', url])
    }

    if (result.code !== 0) {
      return JSON.stringify({ ok: false, error: `yt-dlp failed: ${result.stderr.slice(0, 400)}` })
    }

    // Parse output filepath (last non-empty line)
    const lines = result.stdout.trim().split('\n').map(l => l.trim()).filter(Boolean)
    let filePath = lines[lines.length - 1] || ''

    // Fallback: scan for newest mp3 in musicDir
    if (!filePath || !fs.existsSync(filePath)) {
      const files = fs.readdirSync(musicDir)
        .filter(f => f.endsWith('.mp3'))
        .map(f => ({ f, mt: fs.statSync(path.join(musicDir, f)).mtimeMs }))
        .sort((a, b) => b.mt - a.mt)
      if (files.length) filePath = path.join(musicDir, files[0].f)
    }

    if (!filePath || !fs.existsSync(filePath)) {
      return JSON.stringify({ ok: false, error: 'Download completed but could not locate output file' })
    }

    const baseName = path.basename(filePath, '.mp3')
    const title  = String(args.title  || baseName)
    const artist = String(args.artist || '')

    // Auto-fetch lyrics
    let lrc = ''
    if (title) {
      lrc = await fetchLrcFromNet(title, artist) || ''
    }

    const track = upsertMusicTrack({ title, artist, album: String(args.album || ''), filePath, lrc, sourceUrl: url })
    return JSON.stringify({ ok: true, track, lrc_fetched: Boolean(lrc) })
  }

  // ── get_lyrics ────────────────────────────────────────────────────────────
  if (action === 'get_lyrics') {
    const id = Number(args.id)
    let title  = String(args.title  || '').trim()
    let artist = String(args.artist || '').trim()

    if (id) {
      const track = getMusicTrack(id)
      if (!track) return JSON.stringify({ ok: false, error: `track id=${id} not found` })
      if (!title)  title  = track.title
      if (!artist) artist = track.artist
    }
    if (!title) return JSON.stringify({ ok: false, error: 'title required' })

    const lrc = await fetchLrcFromNet(title, artist)
    if (!lrc) return JSON.stringify({ ok: true, id: id || null, title, artist, lrc: null, hint: 'lyrics not found on lrclib.net' })

    if (id) updateMusicLrc(id, lrc)
    return JSON.stringify({ ok: true, id: id || null, title, artist, lrc_length: lrc.length, lrc })
  }

  // ── delete ────────────────────────────────────────────────────────────────
  if (action === 'delete') {
    const id = Number(args.id)
    if (!id) return JSON.stringify({ ok: false, error: 'id required' })
    const track = getMusicTrack(id)
    if (!track) return JSON.stringify({ ok: false, error: `track id=${id} not found` })
    dbDeleteMusicTrack(id)
    return JSON.stringify({ ok: true, deleted: { id, title: track.title } })
  }

  return JSON.stringify({ ok: false, error: `unknown action: ${action}` })
}

const ACUI_COMPONENTS_PATH = path.resolve(__dirname, 'ui-components.json')
const ACUI_REGISTRY_PATH   = path.resolve(__dirname, '..', 'ui', 'brain-ui', 'acui', 'registry.js')
const ACUI_COMPONENTS_DIR  = path.resolve(__dirname, '..', 'ui', 'brain-ui', 'acui', 'components')

let _acuiComponentsCache = null
function loadACUIComponents() {
  if (!_acuiComponentsCache) {
    _acuiComponentsCache = JSON.parse(fs.readFileSync(ACUI_COMPONENTS_PATH, 'utf-8'))
  }
  return _acuiComponentsCache
}
function invalidateACUIComponentsCache() { _acuiComponentsCache = null }

// 校验并就地容错：number-like 字符串自动转 number，避免 LLM 把 "18" 当 18 传过来时硬挂。
function validateProps(propsSchema, props) {
  if (!props || typeof props !== 'object') return null
  for (const [name, spec] of Object.entries(propsSchema)) {
    let v = props[name]
    if (spec.required && (v === undefined || v === null)) {
      return `字段 ${name} 必填`
    }
    if (v === undefined || v === null) continue
    const t = spec.type
    if (t === 'number' && typeof v !== 'number') {
      // 容错：LLM 经常把数字当字符串传（"18"、"23.5"）。是合法 number-like 字符串就转一下。
      if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) {
        props[name] = Number(v)
        continue
      }
      return `字段 ${name} 必须为 number`
    }
    if (t === 'string' && typeof v !== 'string') return `字段 ${name} 必须为 string`
    if (t === 'array'  && !Array.isArray(v))    return `字段 ${name} 必须为 array`
    if (t === 'object' && (typeof v !== 'object' || Array.isArray(v))) return `字段 ${name} 必须为 object`
    if (t === 'boolean' && typeof v !== 'boolean') return `字段 ${name} 必须为 boolean`
  }
  return null
}

// 合并 LLM 给的 hint 和组件 propsSchema 默认值，按 placement 推断动画/拖动/遮罩默认。
function mergeHint(hint, def) {
  const h = hint && typeof hint === 'object' ? hint : {}
  const placement = ['notification', 'center', 'floating', 'stage'].includes(h.placement)
    ? h.placement
    : (def?.placement || 'notification')

  const enterDefaults = { notification: 'slide-from-right', center: 'scale-up', floating: 'fade-up', stage: 'stage-up' }
  const exitDefaults  = { notification: 'slide-to-right',   center: 'scale-down', floating: 'fade-down', stage: 'stage-down' }

  const draggable = typeof h.draggable === 'boolean' ? h.draggable
    : (typeof def?.draggable === 'boolean' ? def.draggable : (placement === 'floating'))
  const modal = typeof h.modal === 'boolean' ? h.modal
    : (typeof def?.modal === 'boolean' ? def.modal : (placement === 'center' || placement === 'stage'))

  const size = h.size ?? def?.size ?? 'md'

  // def.enter/exit 只在 placement=notification 时生效；切换到 center/floating/stage
  // 组件原来的 slide-from-right 就不合适了，按 placement 默认动画走。
  const usesDefAnim = placement === 'notification'
  return {
    placement,
    size,
    draggable,
    modal,
    enter: h.enter || (usesDefAnim ? def?.enter : null) || enterDefaults[placement],
    exit:  h.exit  || (usesDefAnim ? def?.exit  : null) || exitDefaults[placement],
  }
}

function execUIShow({ component, props, hint }) {
  console.log(`[ui_show] component=${component} props=${JSON.stringify(props)}`)
  if (!component) return '错误：未提供 component 或 mode'
  const components = loadACUIComponents()
  const def = components[component]
  if (!def) return `错误：组件 "${component}" 未注册（可用：${Object.keys(components).join(', ') || '无'}）`

  const propsErr = validateProps(def.propsSchema, props || {})
  if (propsErr) return `错误：props 校验失败 — ${propsErr}（实际 props=${JSON.stringify(props)}）`

  if (!hasACUIClient()) return '错误：当前没有 UI 客户端连接，请改用文字回答'

  // 单例组件：显示新卡前先关掉同类旧卡，避免动画重叠出现"两种"
  const SINGLETON_COMPONENTS = new Set(['SelfCheckStepCard'])
  if (SINGLETON_COMPONENTS.has(component)) {
    const existing = getActiveUICards().filter(c => c.component === component)
    for (const old of existing) {
      emitUICommand({ op: 'unmount', id: old.id })
      removeActiveUICard(old.id)
    }
  }

  const id = `${component.toLowerCase()}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
  emitUICommand({
    op: 'mount',
    id,
    component,
    props,
    hint: mergeHint(hint, def),
  })
  addActiveUICard(id, { component })
  emitEvent('action', { tool: 'ui_show', summary: `推送 ${component}`, detail: id })
  return JSON.stringify({ ok: true, id })
}

function execUIHide({ id }) {
  if (!id) return '错误：未提供 id'
  if (!getActiveUICards().find(c => c.id === id)) return `错误：卡片 "${id}" 不存在或已关闭`
  if (!hasACUIClient()) return '错误：当前没有 UI 客户端连接'
  emitUICommand({ op: 'unmount', id })
  removeActiveUICard(id)
  emitEvent('action', { tool: 'ui_hide', summary: `关闭卡片`, detail: id })
  return JSON.stringify({ ok: true, id })
}

function execUIUpdate({ id, props }) {
  if (!id) return '错误：未提供 id'
  if (!props || typeof props !== 'object' || Array.isArray(props)) return '错误：props 必须为对象'
  const card = getActiveUICards().find(c => c.id === id)
  if (!card) return `错误：卡片 "${id}" 不存在或已关闭`
  if (card.component) {
    const def = loadACUIComponents()[card.component]
    if (def) {
      const propsErr = validateProps(def.propsSchema, props)
      if (propsErr) return `错误：props 校验失败 — ${propsErr}`
    }
  }
  if (!hasACUIClient()) return '错误：当前没有 UI 客户端连接'
  emitUICommand({ op: 'update', id, props })
  emitEvent('action', { tool: 'ui_update', summary: `更新卡片`, detail: id })
  return JSON.stringify({ ok: true, id })
}


function execUIPatch({ id, op, data }) {
  if (!id) return '错误：未提供 id'
  if (!op) return '错误：未提供 op'
  if (!getActiveUICards().find(c => c.id === id)) return `错误：卡片 "${id}" 不存在或已关闭`
  if (!hasACUIClient()) return '错误：当前没有 UI 客户端连接'
  emitUICommand({ op: 'patch', id, patchOp: op, data: data || {} })
  emitEvent('action', { tool: 'ui_patch', summary: `应用补丁 ${op}`, detail: id })
  return JSON.stringify({ ok: true, id, op })
}

function execManageApp({ action, name, label, draft_id, state, hint }) {
  const appsRoot = path.resolve(SANDBOX_ROOT, 'apps')

  if (action === 'save') {
    if (!name) return '错误：save 操作必须提供 name'
    if (!draft_id) return '错误：save 操作必须提供 draft_id'
    // 从内存或草稿文件取代码
    let code = draftCodeMap.get(draft_id)
    if (!code) {
      const draftPath = path.resolve(appsRoot, '.drafts', `${draft_id}.js`)
      if (!fs.existsSync(draftPath)) return `错误：找不到草稿 ${draft_id}，请确认 draft_id 是 ui_show(mode="inline-script") 返回的 id`
      code = fs.readFileSync(draftPath, 'utf-8')
    }
    const appDir = path.resolve(appsRoot, name)
    fs.mkdirSync(appDir, { recursive: true })
    // 版本备份（若已有同名应用）
    const componentPath = path.resolve(appDir, 'component.js')
    const metaPath = path.resolve(appDir, 'meta.json')
    let newVersion = 1
    if (fs.existsSync(componentPath) && fs.existsSync(metaPath)) {
      try {
        const oldMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
        const v = oldMeta.version || 1
        fs.copyFileSync(componentPath, path.resolve(appDir, `component.v${v}.js`))
        newVersion = v + 1
      } catch (_) {}
    }
    const meta = {
      name, label: label || name,
      created_at: new Date().toISOString(),
      last_used: new Date().toISOString(),
      version: newVersion,
      draft_id,
      hint: hint || { placement: 'floating', size: 'lg' },
    }
    fs.writeFileSync(componentPath, code, 'utf-8')
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8')
    if (state) fs.writeFileSync(path.resolve(appDir, 'state.json'), JSON.stringify(state, null, 2), 'utf-8')
    appIdToName.set(draft_id, name)
    draftCodeMap.delete(draft_id)
    emitEvent('action', { tool: 'manage_app', summary: `保存应用 ${name}`, detail: draft_id })
    return JSON.stringify({ ok: true, name, path: `sandbox/apps/${name}/` })
  }

  if (action === 'open') {
    if (!name) return '错误：open 操作必须提供 name'
    const appDir = path.resolve(appsRoot, name)
    if (!fs.existsSync(appDir)) return `错误：应用 "${name}" 不存在，请先 save`
    const code = fs.readFileSync(path.resolve(appDir, 'component.js'), 'utf-8')
    const meta = JSON.parse(fs.readFileSync(path.resolve(appDir, 'meta.json'), 'utf-8'))
    let savedState = {}
    const statePath = path.resolve(appDir, 'state.json')
    if (!state && fs.existsSync(statePath)) {
      savedState = JSON.parse(fs.readFileSync(statePath, 'utf-8'))
    }
    const props = state || savedState
    const mountHint = hint || meta.hint || { placement: 'floating', size: 'lg' }
    const result = execUIShowInline({ mode: 'inline-script', code, props, hint: mountHint })
    try {
      const parsed = JSON.parse(result)
      if (parsed.ok) {
        appIdToName.set(parsed.id, name)
        meta.last_used = new Date().toISOString()
        fs.writeFileSync(path.resolve(appDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8')
      }
    } catch (e) { console.warn(`[manage_app open] 解析挂载结果失败：${e.message}`) }
    emitEvent('action', { tool: 'manage_app', summary: `打开应用 ${name}`, detail: name })
    return result
  }

  if (action === 'list') {
    if (!fs.existsSync(appsRoot)) return JSON.stringify({ ok: true, apps: [] })
    const apps = fs.readdirSync(appsRoot, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.drafts')
      .map(d => {
        try { return JSON.parse(fs.readFileSync(path.resolve(appsRoot, d.name, 'meta.json'), 'utf-8')) }
        catch { return { name: d.name } }
      })
    return JSON.stringify({ ok: true, apps })
  }

  if (action === 'delete') {
    if (!name) return '错误：delete 操作必须提供 name'
    const appDir = path.resolve(appsRoot, name)
    if (!fs.existsSync(appDir)) return `错误：应用 "${name}" 不存在`
    fs.rmSync(appDir, { recursive: true })
    emitEvent('action', { tool: 'manage_app', summary: `删除应用 ${name}`, detail: name })
    return JSON.stringify({ ok: true, name, deleted: true })
  }

  return `错误：未知 action "${action}"，可用：save / open / list / delete`
}

function isPascalCase(name) { return /^[A-Z][A-Za-z0-9]*$/.test(name) }
function pascalToKebab(name) { return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase() }

const RESERVED_COMPONENT_NAMES = new Set(['Inline', 'System', 'Base', 'Test'])

function execUIRegister({ component_name, code, props_schema, use_case, example_call }) {
  if (!component_name || !isPascalCase(component_name)) return '错误：component_name 必须为 PascalCase（如 TodoCard）'
  if (RESERVED_COMPONENT_NAMES.has(component_name)) return `错误：component_name "${component_name}" 是保留名`
  if (!code || typeof code !== 'string') return '错误：code 必填字符串'
  if (!props_schema || typeof props_schema !== 'object' || Array.isArray(props_schema)) return '错误：props_schema 必须为对象'
  if (!use_case || typeof use_case !== 'string') return '错误：use_case 必填'
  if (!example_call || typeof example_call !== 'string') return '错误：example_call 必填'

  // code 必须含 customElements.define & static tagName
  if (!/customElements\s*\.\s*define/.test(code)) return '错误：code 必须以 customElements.define(...) 注册收尾'
  if (!/static\s+tagName\s*=\s*['"`]/.test(code)) return '错误：code 必须含 static tagName = "acui-..."'

  // 占用检查
  const components = loadACUIComponents()
  if (components[component_name]) return `错误：组件名 "${component_name}" 已存在`

  // 语法预检：剥离顶层 import / export 行（new Function 不接受 module 语法）
  try {
    const stripped = code
      .replace(/^\s*import\s[^\n]*\n/gm, '')
      .replace(/^\s*export\s+default\s+/gm, '')
      .replace(/^\s*export\s*\{[^}]*\}[^\n]*\n/gm, '')
      .replace(/^\s*export\s+/gm, '')
    new Function(stripped)
  } catch (e) {
    return `错误：代码语法预检失败 — ${e.message}`
  }

  const kebab = pascalToKebab(component_name)
  const filePath = path.join(ACUI_COMPONENTS_DIR, `${kebab}.js`)

  // 文件名必须严格 kebab-case，且只能写入 components 目录内
  const resolved = path.resolve(filePath)
  if (!isPathInside(ACUI_COMPONENTS_DIR, resolved)) return '错误：目标路径越界'
  if (fs.existsSync(resolved)) return `错误：目标文件已存在：${kebab}.js`

  // 写组件文件
  fs.writeFileSync(resolved, code, 'utf-8')

  // 改 registry.js：在 import 区追加，COMPONENTS 对象内追加键
  let registry = fs.readFileSync(ACUI_REGISTRY_PATH, 'utf-8')
  const importLine = `import { ${component_name} } from './components/${kebab}.js'`
  if (!registry.includes(importLine)) {
    // 在最后一个 import 后追加
    registry = registry.replace(/((?:^import .*\n)+)/m, (m) => m + importLine + '\n')
  }
  // 在 COMPONENTS 对象里追加键
  if (!new RegExp(`\\b${component_name}\\s*[,}]`).test(registry)) {
    registry = registry.replace(/export const COMPONENTS = \{([\s\S]*?)\}/, (m, body) => {
      const trimmed = body.replace(/\s+$/, '')
      const sep = trimmed.endsWith(',') || trimmed === '' ? '' : ','
      return `export const COMPONENTS = {${trimmed}${sep}\n  ${component_name},\n}`
    })
  }
  fs.writeFileSync(ACUI_REGISTRY_PATH, registry, 'utf-8')

  // 改 ui-components.json
  components[component_name] = {
    propsSchema: props_schema,
    enter: 'slide-from-right',
    exit:  'slide-to-right',
  }
  fs.writeFileSync(ACUI_COMPONENTS_PATH, JSON.stringify(components, null, 2), 'utf-8')
  invalidateACUIComponentsCache()

  // seed skill.ui 记忆
  const skillContent = `[Skill UI] ${component_name}\nUse case: ${use_case}\nExample call: ${example_call}`
  try {
    insertMemory({
      mem_id: `skill-ui-${kebab}`,
      type: 'skill',
      content: skillContent,
      detail: skillContent,
      title: `UI component: ${component_name}`,
      tags: ['skill.ui', `component:${component_name}`],
      entities: [],
      timestamp: new Date().toISOString(),
    })
  } catch (e) {
    console.warn(`[ui_register] 写技能记忆失败：${e.message}（组件已注册成功）`)
  }

  // 通知前端热重载 registry
  emitACUIEvent('acui:reload', { component_name })

  emitEvent('action', { tool: 'ui_register', summary: `转正组件 ${component_name}`, detail: kebab })
  return JSON.stringify({ ok: true, component_name, file: `${kebab}.js` })
}

// ─────────────────────────────────────────────────────────────────────────────
// 任务管理工具（通过 context 回调通知 index.js）
// ─────────────────────────────────────────────────────────────────────────────

function execSetTask({ description, steps = [] }, context) {
  if (!description?.trim()) return '错误：未提供任务描述'
  if (!Array.isArray(steps) || steps.length === 0) return '错误：steps 不能为空，请提供具体执行步骤'
  if (!context?.onSetTask) return '错误：任务管理回调未注册'
  const cleanSteps = steps.map(s => String(s).trim()).filter(Boolean)
  context.onSetTask(description.trim(), cleanSteps)
  return `任务已开启：${description}\n步骤（${cleanSteps.length} 个）：\n${cleanSteps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`
}

function execCompleteTask({ summary = '' }, context) {
  if (!context?.onCompleteTask) return '错误：任务管理回调未注册'
  context.onCompleteTask(String(summary || '').trim())
  return `任务已完成${summary ? '：' + summary : ''}`
}

function execUpdateTaskStep({ step_index, status, note = '' }, context) {
  if (step_index === undefined || step_index === null) return '错误：未提供步骤编号'
  const idx = Number(step_index)
  if (!Number.isInteger(idx) || idx < 0) return '错误：步骤编号必须为非负整数'
  if (!['done', 'failed', 'skipped'].includes(status)) return '错误：status 必须为 done/failed/skipped'
  if (!context?.onUpdateTaskStep) return '错误：任务管理回调未注册'
  const result = context.onUpdateTaskStep(idx, status, String(note || '').trim())
  if (result?.error) return `错误：${result.error}`
  const statusLabel = { done: '完成 ✓', failed: '失败 ✗', skipped: '跳过 —' }[status]
  return `步骤 ${idx + 1} 已标记为${statusLabel}${note ? '：' + note : ''}`
}

function execFocusBanner({ action, task = '', current_step = '', tasks = [] }) {
  if (!['show', 'update', 'hide'].includes(action)) {
    return toolJson({ ok: false, error: 'action 必须是 show / update / hide' })
  }
  const bridge = global.focusBannerBridge
  if (!bridge) {
    return toolJson({ ok: false, error: '桌面功能不可用（非 Electron 环境）' })
  }
  if (action === 'hide') {
    bridge.emit('hide')
    return toolJson({ ok: true, action: 'hide', message: '专注横幅已关闭' })
  }
  const cleanTasks = Array.isArray(tasks)
    ? tasks.map(t => ({ text: String(t.text || ''), done: !!t.done }))
    : []
  bridge.emit('command', { action, task: String(task), current_step: String(current_step), tasks: cleanTasks })
  return toolJson({ ok: true, action, task, current_step, tasks: cleanTasks })
}

function execSetLocation({ city }) {
  const loc = String(city || '').trim()
  if (!loc) return toolJson({ ok: false, error: '城市名称不能为空' })
  setUserLocation(loc)
  return toolJson({ ok: true, city: loc, message: `位置已更新为：${loc}` })
}

function execSetAgentName({ name }) {
  const trimmed = String(name || '').trim()
  if (!trimmed) return toolJson({ ok: false, error: '名字不能为空' })
  if (trimmed.length > 32) return toolJson({ ok: false, error: '名字不能超过 32 个字符' })
  if (!/^[一-龥A-Za-z0-9 _-]+$/.test(trimmed)) {
    return toolJson({ ok: false, error: '名字只允许包含中文、英文字母、数字、空格、下划线、短横线' })
  }
  dbSetConfig('agent_name', trimmed)
  setStickyEvent('agent_name_updated', { name: trimmed })
  emitEvent('agent_name_updated', { name: trimmed })
  return toolJson({ ok: true, name: trimmed, message: `好的，我以后就叫 ${trimmed} 了` })
}

function execConnectWechat() {
  if (!hasACUIClient()) {
    return toolJson({ ok: false, error: '当前没有 UI 客户端，无法弹出微信连接界面。' })
  }
  emitEvent('show_wechat_popup', {})
  return toolJson({ ok: true, status: 'popup_shown', message: '已弹出微信连接二维码界面，请告知用户扫码操作。' })
}

function execSetSecurity({ file_sandbox, exec_sandbox, reason = '' }) {
  if (file_sandbox === undefined && exec_sandbox === undefined) {
    return toolJson({ ok: false, error: '至少指定 file_sandbox 或 exec_sandbox 之一' })
  }
  if (!hasACUIClient()) {
    return toolJson({ ok: false, error: '当前没有 UI 客户端，无法弹出确认框。请告知用户到设置页面手动修改安全沙箱配置。' })
  }

  const props = { reason: reason || '' }
  if (file_sandbox !== undefined) props.file_sandbox = file_sandbox
  if (exec_sandbox !== undefined) props.exec_sandbox = exec_sandbox

  const id = `security-confirm-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
  emitUICommand({ op: 'mount', id, component: 'SecurityConfirmCard', props, hint: { placement: 'center' } })
  addActiveUICard(id, { component: 'SecurityConfirmCard' })
  emitEvent('action', { tool: 'set_security', summary: '等待用户确认安全设置变更', detail: id })
  return toolJson({ ok: true, id, status: 'pending_confirmation', message: '已弹出确认卡片，等待用户确认。' })
}

// 把 Agent 的文档信息格式化成错误响应里的引导字段
function agentDocsHint(agent) {
  if (!agent) return {}
  const hint = {}
  if (agent.docs_url) {
    hint.docs_url = agent.docs_url
    hint.docs_hint = `调用失败。建议先用 fetch_url("${agent.docs_url}") 查阅 ${agent.name} 当前版本（${agent.version || 'unknown'}）的使用文档，确认正确的参数格式后重试。`
  } else if (agent.docs_search_query) {
    hint.docs_search_query = agent.docs_search_query
    hint.docs_hint = `调用失败。建议先用 web_search("${agent.docs_search_query}") 查找 ${agent.name} 当前版本（${agent.version || 'unknown'}）的使用文档，确认正确的调用方式后重试。`
  }
  return hint
}

async function execDelegateToAgent({ agent_id, prompt: agentPrompt, context: agentContext = '', timeout = 60 }) {
  if (!isDelegationAllowed()) {
    return toolJson({ ok: false, error: '尚未获得 Agent 委托权限，请先询问用户并通过 grant_agent_delegation 获取授权。' })
  }

  const agent = getAgentById(String(agent_id || ''))
  if (!agent) {
    return toolJson({ ok: false, error: `未找到 Agent：${agent_id}。请先用 list_known_agents 查看可用列表。` })
  }
  if (!agent.available) {
    return toolJson({
      ok: false,
      error: `Agent ${agent.name} 当前不可用（上次检测：${agent.detected_at}）。`,
      ...agentDocsHint(agent),
    })
  }

  const fullPrompt = agentContext
    ? `${agentContext.trim()}\n\n${agentPrompt.trim()}`
    : agentPrompt.trim()

  const timeoutSec = Math.min(Math.max(Number(timeout) || 60, 5), 300)

  if (agent.invoke_type === 'cli') {
    const safePrompt = fullPrompt.replace(/"/g, '\\"').replace(/\n/g, ' ')
    const cmdArgs = (agent.invokeArgs || []).map(a => a === '{prompt}' ? `"${safePrompt}"` : a).join(' ')
    const cmd = `${agent.invoke_cmd} ${cmdArgs}`
    const result = await execCommand({ command: cmd, timeout: timeoutSec, background: false }, {})
    // CLI 调用失败时注入文档引导
    try {
      const parsed = typeof result === 'string' ? JSON.parse(result) : result
      if (parsed?.ok === false || (parsed?.exit_code !== undefined && parsed.exit_code !== 0)) {
        return toolJson({ ...parsed, ...agentDocsHint(agent) })
      }
    } catch { /* result 不是 JSON，直接返回 */ }
    return result
  }

  if (agent.invoke_type === 'http') {
    const base = agent.invoke_cmd.replace(/\/$/, '')
    // Ollama API（端口 11434）有专属格式，需要带 model 字段
    const isOllama = base.includes(':11434')
    const ollamaModel = agent.notes?.match(/ollama[^)]*\(([^)]+)\)/i)?.[1]
      || agent.id   // 用 agent id 作为 model 名的兜底

    const endpoints = isOllama
      ? [{ path: '/api/chat', body: { model: ollamaModel, messages: [{ role: 'user', content: fullPrompt }], stream: false } },
         { path: '/api/generate', body: { model: ollamaModel, prompt: fullPrompt, stream: false } }]
      : [{ path: '/api/chat', body: { message: fullPrompt, messages: [{ role: 'user', content: fullPrompt }] } },
         { path: '/v1/chat/completions', body: { messages: [{ role: 'user', content: fullPrompt }] } },
         { path: '/chat', body: { message: fullPrompt } },
         { path: '/query', body: { query: fullPrompt } }]

    for (const ep of endpoints) {
      try {
        const res = await fetch(`${base}${ep.path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ep.body),
          signal: AbortSignal.timeout(timeoutSec * 1000),
        })
        if (res.ok) {
          const data = await res.json()
          const reply = data?.message?.content || data?.response || data?.message
            || data?.content || data?.choices?.[0]?.message?.content || JSON.stringify(data)
          return toolJson({ ok: true, agent_id, agent_name: agent.name, reply: String(reply).slice(0, 4000) })
        }
      } catch { /* 尝试下一个端点 */ }
    }
    return toolJson({
      ok: false,
      error: `无法连接到 ${agent.name}（${base}），所有端点均不响应。`,
      ...agentDocsHint(agent),
    })
  }

  return toolJson({ ok: false, error: `不支持的调用类型：${agent.invoke_type}` })
}

function execGrantAgentDelegation({ allowed, note = '' }) {
  try {
    dbSetConfig('agent_delegation_asked', 'true')
    dbSetConfig('agent_delegation_allowed', allowed ? 'true' : 'false')
  } catch (e) {
    console.error('[Agents] grant_agent_delegation 写入失败：', e.message)
    return toolJson({ ok: false, error: e.message })
  }
  const msg = allowed
    ? `已记录授权：Bailongma 可以指挥本地 AI 小伙伴工作。`
    : `已记录：用户暂不授权 Agent 委托功能。`
  return toolJson({ ok: true, allowed: !!allowed, note: String(note || ''), message: msg })
}

function normalizeSelfCheckResults(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const normalized = {}
  for (const [key, item] of Object.entries(value)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      normalized[key] = { status: String(item || 'unknown') }
      continue
    }
    normalized[key] = {
      status: String(item.status || item.state || 'unknown').slice(0, 40),
      detail: String(item.detail || item.message || '').slice(0, 500),
    }
  }
  return normalized
}

function execCompleteStartupSelfCheck({ summary = '', results = {} } = {}, context = {}) {
  if (!context?.startupSelfCheck?.active || !context?.onCompleteStartupSelfCheck) {
    return toolJson({
      ok: false,
      tool: 'complete_startup_self_check',
      error: 'startup self-check is not active',
    })
  }

  const cleanResults = normalizeSelfCheckResults(results)
  const completed = context.onCompleteStartupSelfCheck({
    summary: String(summary || '').slice(0, 1000),
    results: cleanResults,
  })
  return toolJson({
    ok: true,
    tool: 'complete_startup_self_check',
    version: completed.version,
    status: completed.status,
    completed_at: completed.completed_at,
    results: cleanResults,
  })
}

async function execRecallMemory({ query }, context) {
  if (!query?.trim()) return '错误：未提供查询内容'
  if (context?.onRecall) context.onRecall(query.trim())
  const rows = searchMemories(query.trim(), 8)
  if (rows.length === 0) return `记忆库中未找到与"${query}"相关的内容，已标记下轮持续关注此主题。`
  const results = rows.map(m =>
    `[${m.timestamp.slice(0, 10)}] ${m.event_type || m.type || ''}: ${m.content}\n  ${(m.detail || '').slice(0, 100)}`
  ).join('\n\n')
  return `已找到 ${rows.length} 条相关记忆（下轮将持续注入此主题）：\n\n${results}`
}
