import fs from 'fs'
import path from 'path'
import { execSync, execFileSync } from 'child_process'
import { paths } from '../../paths.js'

const IS_WIN = process.platform === 'win32'

const TOOLS_DIR = path.join(paths.sandboxDir, 'installed_tools')

// 运行时注册表：name → { schema, execute }
const registry = new Map()

// 不允许覆盖的内置工具名（关键工具保护）
const BUILTIN_NAMES = new Set([
  'express', 'send_message', 'read_file', 'list_dir', 'write_file', 'delete_file',
  'make_dir', 'exec_command', 'kill_process', 'list_processes', 'web_search',
  'fetch_url', 'browser_read', 'search_memory', 'upsert_memory', 'skip_recognition',
  'speak', 'generate_lyrics', 'generate_music', 'generate_image', 'set_tick_interval',
  'media_mode', 'hotspot_mode', 'open_doc_panel', 'person_card_mode', 'music',
  'manage_reminder', 'schedule_reminder', 'manage_prefetch_task', 'ui_show', 'ui_update',
  'ui_hide', 'ui_patch', 'manage_app', 'ui_register', 'focus_banner',
  'set_location', 'delegate_to_agent', 'grant_agent_delegation', 'recall_memory',
  'complete_startup_self_check', 'set_task', 'complete_task', 'update_task_step',
  'install_tool', 'uninstall_tool', 'list_tools', 'set_security', 'connect_wechat',
])

function ensureToolsDir() {
  fs.mkdirSync(TOOLS_DIR, { recursive: true })
}

function buildSchema(name, description, parameters) {
  return {
    type: 'function',
    function: { name, description, parameters },
  }
}

// helpers 暴露给已安装工具代码使用的受控能力
function buildHelpers() {
  return {
    fetch: (...args) => globalThis.fetch(...args),

    exec: (command, opts = {}) => {
      try {
        const execOpts = {
          encoding: 'utf-8',
          timeout: opts.timeout ?? 30_000,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
        }
        if (IS_WIN) {
          // 走 PowerShell 显式调用，并三层同步 UTF-8 编码（chcp + OutputEncoding + InputEncoding），
          // 避免中文 Windows 默认 GBK 代码页让原生命令输出被按 UTF-8 解码成乱码。
          const wrapped =
            `chcp 65001 > $null; ` +
            `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ` +
            `[Console]::InputEncoding=[System.Text.Encoding]::UTF8; ` +
            `$OutputEncoding=[System.Text.Encoding]::UTF8; ` +
            command
          return execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', wrapped], execOpts)
        }
        return execSync(command, execOpts)
      } catch (err) {
        return `Error: ${err.message}`
      }
    },

    log: (msg) => console.log('[installed_tool]', msg),
  }
}

// 把工具代码字符串编译为可调用的 async 函数
// 代码是函数体（不含 function 声明），可用变量：args, helpers
function compileExecute(name, code) {
  let fn
  try {
    // AsyncFunction 构造器接受参数名列表 + 函数体
    // eslint-disable-next-line no-new-func
    fn = new Function('args', 'helpers', `"use strict";\nreturn (async () => {\n${code}\n})()`)
  } catch (err) {
    throw new Error(`工具 "${name}" 代码语法错误：${err.message}`)
  }
  return async (args) => {
    const helpers = buildHelpers()
    return await fn(args ?? {}, helpers)
  }
}

function validateName(name) {
  if (!name || typeof name !== 'string') throw new Error('工具名称不能为空')
  if (!/^[a-z][a-z0-9_]{1,49}$/.test(name)) {
    throw new Error('工具名称只能含小写字母、数字、下划线，长度 2-50，且以字母开头')
  }
  if (BUILTIN_NAMES.has(name)) throw new Error(`"${name}" 是保留名称，不允许覆盖`)
}

function validateParameters(parameters) {
  if (!parameters || typeof parameters !== 'object') throw new Error('parameters_schema 必须是对象')
  if (parameters.type !== 'object') throw new Error('parameters_schema.type 必须是 "object"')
  if (!parameters.properties || typeof parameters.properties !== 'object') {
    throw new Error('parameters_schema.properties 必须是对象')
  }
}

// ─── 对外 API ────────────────────────────────────────────────────────────────

export async function installTool({ name, description, parameters, code }) {
  validateName(name)
  if (!description || typeof description !== 'string') throw new Error('description 不能为空')
  validateParameters(parameters)
  if (!code || typeof code !== 'string') throw new Error('code 不能为空')

  // 先编译，语法错误立即报告
  const executeFn = compileExecute(name, code)

  ensureToolsDir()

  const meta = {
    name,
    description,
    parameters,
    code,
    installed_at: new Date().toISOString(),
  }
  fs.writeFileSync(
    path.join(TOOLS_DIR, `${name}.json`),
    JSON.stringify(meta, null, 2),
    'utf-8',
  )

  registry.set(name, { schema: buildSchema(name, description, parameters), execute: executeFn })
  console.log(`[marketplace] 工具 "${name}" 安装完成`)
  return `工具 "${name}" 安装成功。下一轮对话起即可调用。`
}

export function uninstallTool({ name }) {
  if (!name) throw new Error('name 不能为空')
  if (!registry.has(name)) return `工具 "${name}" 未安装。`

  registry.delete(name)

  const filePath = path.join(TOOLS_DIR, `${name}.json`)
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath)

  console.log(`[marketplace] 工具 "${name}" 已卸载`)
  return `工具 "${name}" 已卸载。`
}

export function listInstalledTools() {
  return [...registry.entries()].map(([name, { schema }]) => ({
    name,
    description: schema.function.description,
    source: 'installed',
  }))
}

export function getInstalledToolNames() {
  return [...registry.keys()]
}

export function getInstalledToolSchema(name) {
  return registry.get(name)?.schema ?? null
}

export function isInstalledTool(name) {
  return registry.has(name)
}

export async function executeInstalledTool(name, args) {
  const tool = registry.get(name)
  if (!tool) throw new Error(`已安装工具 "${name}" 不存在`)
  const result = await tool.execute(args)
  if (result === undefined || result === null) return `工具 "${name}" 执行完成（无返回值）`
  return typeof result === 'string' ? result : JSON.stringify(result)
}

// 启动时从磁盘加载所有已安装工具
export async function loadInstalledTools() {
  ensureToolsDir()
  const files = fs.readdirSync(TOOLS_DIR).filter(f => f.endsWith('.json'))
  let loaded = 0
  for (const file of files) {
    const filePath = path.join(TOOLS_DIR, file)
    try {
      const meta = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      const { name, description, parameters, code } = meta
      if (!name || !code) {
        console.warn(`[marketplace] 跳过无效工具文件 ${file}`)
        continue
      }
      const executeFn = compileExecute(name, code)
      registry.set(name, { schema: buildSchema(name, description, parameters), execute: executeFn })
      loaded++
    } catch (err) {
      console.warn(`[marketplace] 加载工具 ${file} 失败：${err.message}`)
    }
  }
  if (loaded > 0) console.log(`[marketplace] 已加载 ${loaded} 个已安装工具`)
}
