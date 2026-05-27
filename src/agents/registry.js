import { getDB, getConfig, setConfig } from '../db.js'
import { detectAgents } from './detector.js'

const CONFIG_KEY_ASKED = 'agent_delegation_asked'
const CONFIG_KEY_ALLOWED = 'agent_delegation_allowed'

// 确保 known_agents 表存在（db.js initSchema 调用前的兜底，也可直接在 db.js 里加）
function ensureTable() {
  const db = getDB()
  db.exec(`
    CREATE TABLE IF NOT EXISTS known_agents (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      description       TEXT NOT NULL DEFAULT '',
      available         INTEGER NOT NULL DEFAULT 0,
      version           TEXT,
      invoke_type       TEXT,
      invoke_cmd        TEXT,
      invoke_args       TEXT NOT NULL DEFAULT '[]',
      notes             TEXT NOT NULL DEFAULT '',
      docs_url          TEXT,
      docs_search_query TEXT,
      detected_at       TEXT NOT NULL,
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
}

// 保存一批 Agent 探测结果到数据库
function saveAgents(agents) {
  const db = getDB()
  const stmt = db.prepare(`
    INSERT INTO known_agents (id, name, description, available, version, invoke_type, invoke_cmd, invoke_args, notes, docs_url, docs_search_query, detected_at, updated_at)
    VALUES (@id, @name, @description, @available, @version, @invoke_type, @invoke_cmd, @invoke_args, @notes, @docs_url, @docs_search_query, @detected_at, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name              = excluded.name,
      description       = excluded.description,
      available         = excluded.available,
      version           = excluded.version,
      invoke_type       = excluded.invoke_type,
      invoke_cmd        = excluded.invoke_cmd,
      invoke_args       = excluded.invoke_args,
      notes             = excluded.notes,
      docs_url          = excluded.docs_url,
      docs_search_query = excluded.docs_search_query,
      detected_at       = excluded.detected_at,
      updated_at        = datetime('now')
  `)
  const insertAll = db.transaction((list) => {
    for (const a of list) stmt.run({
      id:                a.id,
      name:              a.name,
      description:       a.description,
      available:         a.available ? 1 : 0,
      version:           a.version || null,
      invoke_type:       a.invokeType || null,
      invoke_cmd:        a.invokeCmd || null,
      invoke_args:       JSON.stringify(a.invokeArgs || []),
      notes:             a.notes || '',
      docs_url:          a.docsUrl || null,
      docs_search_query: a.docsSearchQuery || null,
      detected_at:       a.detectedAt || new Date().toISOString(),
    })
  })
  insertAll(agents)
}

// 读取所有可用 Agent
export function getAvailableAgents() {
  ensureTable()
  const db = getDB()
  return db.prepare(`
    SELECT * FROM known_agents WHERE available = 1 ORDER BY id ASC
  `).all().map(row => ({
    ...row,
    invokeArgs: JSON.parse(row.invoke_args || '[]'),
    available: !!row.available,
  }))
}

// 读取所有 Agent（含不可用）
export function getAllAgents() {
  ensureTable()
  const db = getDB()
  return db.prepare(`SELECT * FROM known_agents ORDER BY available DESC, id ASC`).all().map(row => ({
    ...row,
    invokeArgs: JSON.parse(row.invoke_args || '[]'),
    available: !!row.available,
  }))
}

// 按 id 获取单个 Agent
export function getAgentById(id) {
  ensureTable()
  const db = getDB()
  const row = db.prepare(`SELECT * FROM known_agents WHERE id = ?`).get(id)
  if (!row) return null
  return { ...row, invokeArgs: JSON.parse(row.invoke_args || '[]'), available: !!row.available }
}

// ── 委托权限管理 ─────────────────────────────────────────────────────────────

export function hasDelegationBeenAsked() {
  return getConfig(CONFIG_KEY_ASKED) === 'true'
}

export function isDelegationAllowed() {
  return getConfig(CONFIG_KEY_ALLOWED) === 'true'
}

export function markDelegationAsked() {
  setConfig(CONFIG_KEY_ASKED, 'true')
}

export function grantDelegation() {
  setConfig(CONFIG_KEY_ALLOWED, 'true')
}

export function revokeDelegation() {
  setConfig(CONFIG_KEY_ALLOWED, 'false')
}

// ── 启动入口：探测 + 落盘 ──────────────────────────────────────────────────

export async function collectAgents() {
  ensureTable()
  console.log('[Agents] 开始扫描本地 AI Agent...')
  try {
    const results = await detectAgents()
    saveAgents(results)
    const found = results.filter(a => a.available)
    console.log(`[Agents] 扫描完成：发现 ${found.length}/${results.length} 个可用 Agent`)
    return results
  } catch (err) {
    console.error('[Agents] 扫描失败：', err.message)
    return []
  }
}

// ── 生成用于系统提示词注入的文本块 ────────────────────────────────────────

export function buildAgentContextBlock() {
  if (!isDelegationAllowed()) return ''
  const agents = getAvailableAgents()
  if (!agents.length) return ''

  const lines = agents.map(a => {
    const invoke = a.invoke_type === 'cli'
      ? `exec_command("${a.invoke_cmd} ...")`
      : `fetch_url("${a.invoke_cmd}/...")`
    return `- **${a.name}** (${a.id})：${a.description}。调用：${invoke}`
  })

  return `## 可协作的 AI 小伙伴
你已获得指挥权，遇到复杂任务时可通过 delegate_to_agent 工具调用以下 Agent：
${lines.join('\n')}
调用前先向用户说明你打算让谁做什么，得到确认后再执行。`
}

// ── 生成"首次发现 Agent，需要询问用户"的方向指令文本 ─────────────────────

export function buildDelegationAskDirections() {
  if (hasDelegationBeenAsked()) return null
  const available = getAvailableAgents()
  if (!available.length) {
    return `【系统扫描结果】启动时已扫描本地环境，未发现其他 AI 智能体（Claude Code、Codex、Hermes、OpenClaw 均未检测到）。你无需向用户提及本次扫描。`
  }

  const names = available.map(a => a.name).join('、')
  return `【新发现】系统启动时检测到你的电脑上安装了以下 AI 工具：${names}。
这些工具可以作为你的小伙伴协助处理复杂任务（比如代码开发、自动化流程等）。
请用 send_message 自然地问用户：你能指挥这些小伙伴工作吗？
等用户回复后：
- 如果用户同意（说"可以"、"好的"、"行"等）→ 调用 grant_agent_delegation 工具落盘权限
- 如果用户拒绝 → 调用 grant_agent_delegation 工具传入 allowed=false 落盘
无论哪种回复都必须调用 grant_agent_delegation 落盘，避免重复询问。`
}
