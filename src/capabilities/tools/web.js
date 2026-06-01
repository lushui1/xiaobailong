import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { getWebSearchCredentials } from '../../config.js'
import { createMergedAbortSignal, throwIfAborted } from '../abort-utils.js'
import { SANDBOX_ROOT } from '../sandbox.js'

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

export async function execWebSearch(args, context = {}) {
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
export async function execFetchUrl(args, context = {}) {
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

export async function execBrowserRead(args, context = {}) {
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
