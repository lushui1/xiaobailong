// 天气上下文注入模块
// 触发关键词 → 拉取用户当前城市天气 → 格式化为参考上下文注入提示词
// 不要求模型必须回复天气，天气是上下文信息，模型按需使用

import { getConfig, setConfig } from './db.js'

const CACHE_TTL_MS = 30 * 60 * 1000  // 30 分钟
const FETCH_TIMEOUT_MS = 8000

// 触发天气注入的关键词（中英双语）
const WEATHER_RE = /天气|气温|温度|下雨|下雪|晴天?|阴天?|多云|刮风|风大|雾霾|冷不冷|热不热|穿什么|穿衣|要下[雨雪]|今天冷|今天热|weather|forecast|raining|snowing|temperature|how.*cold|how.*hot/i

let cache = null  // { location, formatted, cardProps, fetchedAt }

/* ── 位置存取 ── */

export function getUserLocation() {
  return (getConfig('user_location') || '').trim()
}

export function setUserLocation(city) {
  const loc = String(city || '').trim()
  if (!loc) return
  setConfig('user_location', loc)
  cache = null  // 位置变了，让缓存失效
  console.log(`[天气] 用户位置已更新：${loc}`)
}

/* ── 缓存检查 ── */

function isCacheFresh(location) {
  if (!cache || cache.location !== location) return false
  return Date.now() - cache.fetchedAt < CACHE_TTL_MS
}

/* ── 拉取 & 解析 wttr.in ── */

async function fetchWeatherData(location) {
  const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1`
  const res = await globalThis.fetch(url, {
    headers: { 'User-Agent': 'Bailongma/1.0 (+https://localhost)' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

const WEATHER_DESC_ZH = {
  'Sunny': '晴',
  'Clear': '晴',
  'Partly cloudy': '多云',
  'Cloudy': '阴天',
  'Overcast': '阴云密布',
  'Mist': '薄雾',
  'Fog': '雾',
  'Freezing fog': '冻雾',
  'Light rain': '小雨',
  'Moderate rain': '中雨',
  'Heavy rain': '大雨',
  'Light snow': '小雪',
  'Moderate snow': '中雪',
  'Heavy snow': '大雪',
  'Blizzard': '暴风雪',
  'Thundery outbreaks possible': '可能有雷暴',
  'Patchy rain possible': '局部有雨',
  'Patchy snow possible': '局部有雪',
  'Blowing snow': '吹雪',
  'Light drizzle': '细雨',
  'Freezing drizzle': '冻雨',
  'Heavy freezing drizzle': '强冻雨',
  'Light sleet': '小冻雨',
  'Moderate or heavy sleet': '中到大冻雨',
  'Thundery outbreaks in nearby': '附近有雷暴',
  'Patchy light rain with thunder': '局部雷阵雨',
  'Moderate or heavy rain with thunder': '雷雨',
}

function localizeDesc(desc = '') {
  return WEATHER_DESC_ZH[desc] || desc
}

function parseWeatherData(data, location) {
  const cur = data?.current_condition?.[0]
  if (!cur) return null

  const desc = localizeDesc(cur.weatherDesc?.[0]?.value || '')
  const tempC = cur.temp_C
  const feelsC = cur.FeelsLikeC
  const humidity = cur.humidity
  const windKmph = cur.windspeedKmph
  const windDir = cur.winddir16Point || ''
  const visKm = cur.visibility

  const today = data?.weather?.[0]
  const maxC = today?.maxtempC
  const minC = today?.mintempC

  const forecastDays = (data?.weather || []).slice(1, 3).map(d => ({
    day: d.date || '',
    condition: localizeDesc(d.hourly?.[4]?.weatherDesc?.[0]?.value || ''),
    high: d.maxtempC,
    low: d.mintempC,
  }))

  const formatted = [
    `📍 ${location} 实时天气`,
    `天气：${desc}  气温：${tempC}°C（体感 ${feelsC}°C）`,
    `今日：${minC}～${maxC}°C  湿度：${humidity}%  风：${windDir} ${windKmph} km/h`,
    ...(visKm && Number(visKm) < 10 ? [`能见度：${visKm} km`] : []),
    ...(forecastDays.length ? [`未来预报：\n${forecastDays.map(d => `  ${d.day}  ${d.low}～${d.high}°C  ${d.condition}`).join('\n')}`] : []),
  ].join('\n')

  const cardProps = {
    city: location,
    temp: tempC,
    condition: desc,
    feel: feelsC,
    high: maxC,
    low: minC,
    wind: windDir ? `${windDir} ${windKmph} km/h` : `${windKmph} km/h`,
    forecast: forecastDays,
  }

  return { formatted, cardProps }
}

/* ── 公开 API ── */

export async function fetchAndCacheWeather(location) {
  if (!location) return null
  if (isCacheFresh(location)) return cache

  try {
    console.log(`[天气] 拉取 ${location} 天气...`)
    const data = await fetchWeatherData(location)
    const parsed = parseWeatherData(data, location)
    if (!parsed) return null
    cache = { location, ...parsed, fetchedAt: Date.now() }
    return cache
  } catch (err) {
    console.warn(`[天气] 拉取失败：${err.message}`)
    return (cache?.location === location) ? cache : null
  }
}

export function isWeatherQuery(message = '') {
  return WEATHER_RE.test(String(message))
}

// 关键词触发 → 注入天气上下文（异步）
// 返回空字符串表示不注入；同时在 cache.cardProps 里存放卡片数据
export async function buildWeatherRuntimeContext(message = '') {
  if (!isWeatherQuery(message)) return ''

  const location = getUserLocation()
  if (!location) return ''

  const result = await fetchAndCacheWeather(location)
  if (!result?.formatted) return ''

  const age = result.fetchedAt
    ? Math.round((Date.now() - result.fetchedAt) / 60000)
    : 0

  return `## Weather Reference
The following live weather was automatically fetched by the system. Treat it only as background context; do not proactively read or summarize it. Cite it only when useful.
Data age: about ${age} minutes (refreshed every 30 minutes)

${result.formatted}`
}

// 关键词触发时返回 WeatherCard 所需 props；无数据返回 null
export async function getWeatherCardProps(message = '') {
  if (!isWeatherQuery(message)) return null

  const location = getUserLocation()
  if (!location) return null

  const result = await fetchAndCacheWeather(location)
  return result?.cardProps ?? null
}
