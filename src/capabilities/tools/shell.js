import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { nowTimestamp } from '../../time.js'
import { emitEvent } from '../../events.js'
import { config } from '../../config.js'
import { createMergedAbortSignal, throwIfAborted } from '../abort-utils.js'
import { SANDBOX_ROOT, assertInSandbox } from '../sandbox.js'

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

function resolveExecCwd(cwdArg) {
  if (!cwdArg) return config.security?.execSandbox === false ? process.cwd() : SANDBOX_ROOT
  if (config.security?.execSandbox === false) return path.resolve(process.cwd(), cwdArg)
  const resolved = path.resolve(SANDBOX_ROOT, cwdArg)
  assertInSandbox(resolved)
  return resolved
}

function toolJson(payload) {
  return JSON.stringify(payload, null, 2)
}

function trimCommandOutput(value = '', max = 6000) {
  const text = String(value || '')
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n[输出已截断，原始长度 ${text.length} 字符，仅保留前 ${max} 字符]`
}

// exec_command：在沙盒目录内执行 shell 命令
// background=true 时后台运行，返回 PID；否则等待完成，返回输出
export function isLikelyLongRunningCommand(command = '') {
  const text = String(command || '').trim()
  if (!text) return false
  return /\b(watch|tail\s+-f|tail\s+--follow|journalctl\b.*\s-f|ping\s+-t|top|htop|npm\s+run\s+(dev|start)|pnpm\s+(dev|start)|yarn\s+(dev|start)|vite\b|next\s+dev|node\s+.*server|python\s+.*server|uvicorn|gunicorn)\b/i.test(text)
    || /\bssh\b[\s\S]*\b(watch|tail\s+-f|journalctl\b.*\s-f|top|htop)\b/i.test(text)
}

function terminateProcessTree(child, pid = child?.pid) {
  if (!pid) {
    try { child?.kill?.() } catch {}
    return { ok: false, error: 'missing pid' }
  }
  if (IS_WIN) {
    const result = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    if (result.status === 0) return { ok: true }
    try { child?.kill?.() } catch {}
    return {
      ok: false,
      error: (result.stderr || result.stdout || `taskkill exited with ${result.status}`).trim(),
    }
  }
  try {
    child?.kill?.()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

export function getCommandFailureHint(command = '', stderr = '', stdout = '') {
  const combined = `${stderr || ''}\n${stdout || ''}`
  const text = String(combined)
  if (/\bssh\b/i.test(command) && /syntax error:\s*unexpected end of file/i.test(text)) {
    return 'The remote shell command reached bash with broken quoting or an unfinished block. Do not retry the same SSH command. Simplify the remote command, avoid multiline nested quotes from PowerShell, or pass a small bash -lc script with carefully escaped single quotes.'
  }
  if (/\bssh\b/i.test(command) && /unexpected EOF while looking for matching/i.test(text)) {
    return 'SSH itself likely connected, but the remote command quoting was unbalanced. Fix the quote escaping before retrying; this is not evidence that the server service is down.'
  }
  if (/The string is missing the terminator/i.test(text)) {
    return 'Local PowerShell rejected the command before it reached the target. Fix local quote escaping; avoid multiline remote shell snippets inside a single PowerShell command.'
  }
  return null
}

export async function execCommand(args, context = {}) {
  throwIfAborted(context.signal)
  const command = String(args.command || args.cmd || '').trim()
  if (!command) return toolJson({ ok: false, tool: 'exec_command', error: 'missing command' })

  const background = args.background === true || args.background === 'true'
  const autoPromote = isLikelyLongRunningCommand(command)
  const promoteToBackground = args.promote_to_background === true || args.promote_to_background === 'true' || autoPromote
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
  emitEvent('exec_command', { command, background, cwd: execCwd, auto_promote: autoPromote })

  if (background) {
    return execBackground(command, execCwd)
  } else {
    return execForeground(command, timeoutMs, context.signal, execCwd, promoteToBackground)
  }
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
      terminateProcessTree(child)
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
      terminateProcessTree(child)
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
        terminateProcessTree(child)
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
      const failureHint = code === 0 ? null : getCommandFailureHint(command, stderr, stdout)
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
        hint: code === 0 ? 'Command completed successfully.' : (failureHint || 'Inspect stderr/stdout before retrying or changing the command.'),
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
export async function execKillProcess(args) {
  const pid = Number(args.pid)
  if (!pid) return toolJson({ ok: false, tool: 'kill_process', error: 'missing pid' })
  const entry = bgProcesses.get(pid)
  if (!entry) return toolJson({ ok: false, tool: 'kill_process', pid, error: 'process not found or already exited' })
  const stopped = terminateProcessTree(entry.process, pid)
  bgProcesses.delete(pid)
  return toolJson({
    ok: stopped.ok,
    tool: 'kill_process',
    pid,
    command: entry.command,
    stopped: stopped.ok,
    error: stopped.ok ? null : stopped.error,
  })
}

// list_processes：列出当前后台进程，包含最近输出行
export async function execListProcesses(args = {}) {
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
