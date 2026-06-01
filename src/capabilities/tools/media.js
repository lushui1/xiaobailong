import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { nowTimestamp } from '../../time.js'
import {
  upsertMusicTrack,
  getMusicTrack,
  searchMusicLibrary,
  listMusicLibrary,
  updateMusicLrc,
  deleteMusicTrack as dbDeleteMusicTrack,
} from '../../db.js'
import { emitEvent } from '../../events.js'
import { callCapability } from '../../providers/registry.js'
import { isDailyLimitReached } from '../../quota.js'
import { getTTSCredentials } from '../../config.js'
import { streamTTS } from '../../voice/tts-providers.js'
import { paths } from '../../paths.js'
import { SANDBOX_ROOT } from '../sandbox.js'

const IS_WIN = process.platform === 'win32'

// speak：将文字转为语音，保存为音频文件
// 有效的 MiniMax 声音 ID
const VALID_VOICE_IDS = new Set([
  'male-qn-qingse', 'male-qn-jingying', 'male-qn-badao', 'male-qn-daxuesheng',
  'female-shaonv', 'female-yujie', 'female-chengshu', 'female-tianmei',
  'presenter_male', 'presenter_female', 'audiobook_male_1', 'audiobook_female_1',
])
const DEFAULT_VOICE = 'male-qn-qingse'

export async function execSpeak(args) {
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
export async function execGenerateLyrics({ prompt, mode }) {
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
export async function execGenerateMusic({ prompt, lyrics, instrumental }) {
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
export async function execGenerateImage({ prompt, aspect_ratio = '1:1', n = 1 }) {
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

export function execMediaMode(args = {}) {
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

export async function execMusic(args = {}) {
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
