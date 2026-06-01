import crypto from 'crypto'
import { nowTimestamp } from '../time.js'
import { normalizeConversationPartyId, upsertPrefetchTask, removePrefetchTask, listPrefetchTasks, insertConversation, setConfig as dbSetConfig, markConversationOpenQuestion } from '../db.js'
import { emitEvent, emitUICommand, hasACUIClient, addActiveUICard, setStickyEvent } from '../events.js'
import { dispatchSocialMessage } from '../social/dispatch.js'
import { setCustomInterval as setTickerInterval, getStatus as getTickerStatus } from '../ticker.js'
import { setHotspotPanelState, getHotspotPanelState } from '../hotspots.js'
import { setPersonCardPanelState, getPersonCardPanelState, getPersonCard } from '../person-cards.js'
import { setDocPanelState, getDocPanelState } from '../docs.js'
import { setUserLocation } from '../weather.js'
import { getAgentById, isDelegationAllowed } from '../agents/registry.js'
import { installTool, uninstallTool, listInstalledTools, isInstalledTool, executeInstalledTool } from './marketplace/index.js'
import { TOOL_SCHEMAS } from './schemas.js'
import { throwIfAborted } from './abort-utils.js'
import { execUIHide, execUIRegister, execUIShow, execUIUpdate, execUIPatch, execManageApp } from './tools/ui.js'
import { evaluateToolPolicy } from './tool-policy.js'
import { inferToolStatus, writeToolAuditLog } from './tool-audit.js'
import { execDeleteFile, execListDir, execMakeDir, execReadFile, execWriteFile } from './tools/filesystem.js'
import { execCommand, execKillProcess, execListProcesses } from './tools/shell.js'
import { execBrowserRead, execFetchUrl, execWebSearch } from './tools/web.js'
import { execDowngradeMemory, execMergeMemories, execRecallMemory, execSearchMemory, execSkipConsolidation, execSkipRecognition, execUpsertMemory } from './tools/memory.js'
import { execManageReminder } from './tools/reminders.js'
import { execGenerateImage, execGenerateLyrics, execGenerateMusic, execMediaMode, execMusic, execSpeak } from './tools/media.js'
import { execManageRule } from './tools/rules.js'
export { calculateNextDueAt } from './tools/reminders.js'
export { autoSpeakForVoiceReply } from './tools/media.js'
export { persistAppState } from './tools/ui.js'

import { config, setSecurity } from '../config.js'
import { lookupReplyTarget, normalizeChannel, suggestProactiveChannel } from '../identity.js'

// P0-2：识别 send_message 末尾是否留了"非澄清型 follow-up question"。
//   触发条件：
//     - 结尾包含问号（? / ？）
//     - 问号所在句子里有"要 / 想 / 需要 / 是否 / 要不要 / 需不需要 / 帮 / 给 / 行不行"
//       或英文 "should/want/need/shall/would you like/do you want"
//   澄清型（"在哪个城市？"/"几点？"）也会被命中——可接受，因为标记本身不影响
//   当前轮输出，只在后续轮该悬念过期时降权，避免代词被钩偏。
const FOLLOWUP_VERB_RE = /(要不要|需不需要|要么|要|想|需要|是否|帮我?|给我?|行不行|可以吗|好吗|可否|能否)/
const FOLLOWUP_EN_RE = /\b(should|want|need|shall|would you like|do you want|may i|can i)\b/i
export function detectOpenFollowupQuestion(text = '') {
  const s = String(text || '').trim()
  if (!s) return false
  // 必须有问号
  if (!/[?？]\s*$/.test(s) && !/[?？]\s*[")'』」】）)]?\s*$/.test(s)) return false
  // 取末尾问号所在的句子片段
  const segs = s.split(/[。!！\n]+/).filter(Boolean)
  const lastSeg = segs[segs.length - 1] || s
  return FOLLOWUP_VERB_RE.test(lastSeg) || FOLLOWUP_EN_RE.test(lastSeg)
}

// 工具执行器：根据工具名和参数执行对应操作，返回结果字符串
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
      case 'manage_rule':
        return execManageRule(args)
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

  const resolvedId = normalizeConversationPartyId(target_id)
  const cleanedContent = String(content).trim()

  const delivery = resolveDeliveryTarget(resolvedId, channel, context)
  if (delivery.error) return `错误：${delivery.error}`

  const timestamp = nowTimestamp()
  const channelLabel = delivery.deliveryChannel || (delivery.isLocal ? 'TUI' : '')
  console.log(`\n[消息发送] → ${resolvedId}${delivery.externalTargetId ? ` via ${delivery.externalTargetId}` : ''}${channelLabel ? ` [${channelLabel}]` : ''}`)
  console.log(`  ${cleanedContent}`)
  console.log(`  时间：${timestamp}`)

  // 顺序：先写数据库（source of truth），再广播 SSE，最后外部投递。
  // 外部投递失败时仍保留对话记录，下次 LLM 仍能看到自己发过这句话；前端也已经显示。
  // P0-2：检测末尾是否留了"非澄清型 follow-up question"——这是后续轮次代词被钩偏的源头。
  //   保守判定：以问号收尾（? / ？）且至少含一个动词+助词组合（要 / 需 / 想 / 帮 / 给 / 是否）
  //   或英文 should/want/need/shall。澄清型疑问（"在哪个城市？"/"几点？"）也会被命中——
  //   接受这点：标 open_question 不阻止模型输出，只在后续轮过期时降权，不伤当前回合。
  const isOpenFollowup = detectOpenFollowupQuestion(cleanedContent)
  const insertedId = insertConversation({
    role: 'jarvis',
    from_id: 'jarvis',
    to_id: resolvedId,
    content: cleanedContent,
    timestamp,
    channel: channelLabel,
    external_party_id: delivery.externalTargetId || '',
    open_question: isOpenFollowup ? 1 : 0,
  })
  if (isOpenFollowup && insertedId) {
    // 写入时 open_question 已设；此处保留兜底（万一上面 column 没生效）
    try { markConversationOpenQuestion(insertedId, true) } catch {}
  }

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

function toolJson(payload) {
  return JSON.stringify(payload, null, 2)
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
