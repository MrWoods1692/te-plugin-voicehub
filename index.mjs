/**
 * VoiceHub 音源插件 · Twilight Echo
 *
 * 把一个自建 VoiceHub 点歌台（https://github.com/laoshuikaixue/VoiceHub）的音源接进 Twilight Echo。
 *
 * 每个平台一个 provider（宿主按 track.source 路由，一个 provider 只能对应一个音源）：
 *   voicehub-bilibili  哔哩哔哩  /api/bilibili/search + /api/bilibili/playurl
 *   voicehub-migu      咪咕音乐  /api/native-api/search/mg + /api/native-api/migu/playurl + lyric/mg
 *   voicehub-tencent   QQ 音乐   /api/native-api/search/tx + /api/music/resolve-url + lyric/tx
 *   voicehub-netease   网易云    /api/api-enhanced/netease/*（站点没开这个代理时会 502/504，默认不注册）
 *
 * 站点没开放某个音源是常态（缺音源插件、缺 cookie、代理挂了），所以：
 *   - 每个音源独立探测健康度，失败只降级自己，不影响别的音源；
 *   - 失败时静默返回空结果 + 一次性 notify 说明原因，而不是把异常抛给宿主；
 *   - 设置面板里有「检测音源」按钮，能直接看到四个音源各自的状态。
 */

// ---------- 常量 ----------

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000'
// 宿主给 searchSongs / getPlaybackUrl / getLyrics 的超时是 30s
// （Twilight_Echo/src/core/plugins/providerRouting.ts 的 PLUGIN_PROVIDER_MEDIUM_TIMEOUT_MS），
// 这里留 5s 余量：站点冷启动或上游慢时 12s 常常不够，会白白变成「搜不到」。
const REQUEST_TIMEOUT_MS = 25_000
// /api/bilibili/search 会让站点去 B 站现查，实测 13~15s 才回，单独放宽但与宿主上限保持距离
const BILIBILI_TIMEOUT_MS = 25_000
// QQ 搜索/歌词在上游坏掉时会无限期挂着，快速失败比干等更有用
const TENCENT_TIMEOUT_MS = 15_000
const PROBE_TIMEOUT_MS = 15_000
// 歌词失败不弹窗，但也不能让用户盯着「歌词加载失败」等 25s：单独给一个更短的超时
const LYRIC_TIMEOUT_MS = 10_000
// 搜索结果是纯文本，重复搜同一个词很常见；缓存 90s 能省掉 B 站那种 15s 的等待
const SEARCH_CACHE_TTL_MS = 90_000
const PLAYBACK_CACHE_TTL_MS = 120_000
const PLAYBACK_NEGATIVE_TTL_MS = 20_000
const NOTIFY_COOLDOWN_MS = 5 * 60_000
// 播放链接跨音源兜底：QQ 的聚合源经常 502，但它搜到的曲目在咪咕/B 站通常也有同一首
const FALLBACK_PLATFORMS = ['migu', 'tencent', 'bilibili', 'netease']

const PROVIDER_BILIBILI = 'voicehub-bilibili'
const PROVIDER_MIGU = 'voicehub-migu'
const PROVIDER_TENCENT = 'voicehub-tencent'
const PROVIDER_NETEASE = 'voicehub-netease'

const CAPABILITIES = ['search', 'playbackUrl', 'lyrics']

// Twilight 侧音质 → VoiceHub 侧参数
const TX_QUALITY = { '128k': '4', '192k': '4', '320k': '8', flac: '10', flac24bit: '10', master: '10' }
const MG_QUALITY = { '128k': 'PQ', '192k': 'PQ', '320k': 'HQ', flac: 'SQ', flac24bit: 'ZQ24', master: 'ZQ24' }
const WY_QUALITY = {
  '128k': 'standard',
  '192k': 'higher',
  '320k': 'exhigh',
  flac: 'lossless',
  flac24bit: 'hires',
  master: 'jymaster'
}
// 设置项里的「默认音质」直接用 Twilight 侧的值，播放时没指定音质就用它
const QUALITY_OPTIONS = [
  { label: '标准 128k', value: '128k' },
  { label: '较高 192k', value: '192k' },
  { label: '极高 320k', value: '320k' },
  { label: '无损 FLAC', value: 'flac' },
  { label: 'Hi-Res 24bit', value: 'flac24bit' },
  { label: '臻品母带', value: 'master' }
]

const PANEL_COMMAND = 'voicehub.settings.panel'
const SAVE_COMMAND = 'voicehub.settings.save'
const TEST_COMMAND = 'voicehub.settings.test'
const PROBE_COMMAND = 'voicehub.settings.probe'

const PLATFORM_LABELS = {
  bilibili: '哔哩哔哩',
  migu: '咪咕音乐',
  tencent: 'QQ 音乐',
  netease: '网易云'
}

// ---------- 运行时状态 ----------

let ctx = null
let config = null
const playbackCache = new Map()
const inflight = new Map()
const health = new Map() // platform -> { ok, message, at }
const lastNotified = new Map() // platform -> timestamp
let unsubscribers = []

// ---------- 配置 ----------

function normalizeBaseUrl(raw) {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) return DEFAULT_BASE_URL

  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
  let parsed
  try {
    parsed = new URL(withScheme)
  } catch {
    throw new Error(`VoiceHub 地址无法解析：${trimmed}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`VoiceHub 地址必须是 http 或 https：${trimmed}`)
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
}

async function loadConfig(force = false) {
  if (config && !force) return config
  const get = (key) => ctx.settings.get(key)
  const [baseUrl, apiKey, quality, enableNetease, autoFallback] = await Promise.all([
    get('baseUrl'),
    get('apiKey'),
    get('quality'),
    get('enableNetease'),
    get('autoFallback')
  ])
  config = {
    baseUrl: normalizeBaseUrl(baseUrl),
    apiKey: String(apiKey ?? '').trim(),
    quality: String(quality ?? '320k').trim() || '320k',
    enableNetease: String(enableNetease ?? 'false') === 'true',
    // 默认开：某个音源放不出来时自动去别的音源找同一首
    autoFallback: String(autoFallback ?? 'true') !== 'false'
  }
  return config
}

function invalidateConfig() {
  config = null
}

// ---------- HTTP ----------

class VoiceHubError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'VoiceHubError'
    this.status = status
  }
}

async function request(path, { method = 'GET', query, body, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const { baseUrl, apiKey } = await loadConfig()
  const url = new URL(`${baseUrl}${path}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }

  const headers = { Accept: 'application/json' }
  if (apiKey) headers['X-API-Key'] = apiKey
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let response
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (error) {
    const message = error?.name === 'TimeoutError' ? `请求超时（${timeoutMs / 1000}s）` : error?.message || '网络错误'
    throw new VoiceHubError(`${method} ${path} 失败：${message}`, 0)
  }

  const text = await response.text()
  if (!response.ok) {
    let detail = text.slice(0, 200)
    try {
      const parsed = JSON.parse(text)
      detail = parsed?.message || parsed?.statusMessage || detail
    } catch {
      /* 非 JSON 错误体，保留原文 */
    }
    const hint =
      response.status === 401 || response.status === 403
        ? '（站点可能需要登录或额外鉴权）'
        : response.status === 502 || response.status === 504
          ? '（上游音源代理不可用，站点侧没配好）'
          : ''
    throw new VoiceHubError(`${method} ${path} 返回 ${response.status}：${detail}${hint}`, response.status)
  }

  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new VoiceHubError(`${method} ${path} 返回的不是 JSON，确认地址指向 VoiceHub 站点`, response.status)
  }
}

// ---------- 健康度 / 提示 ----------

function markHealthy(platform) {
  health.set(platform, { ok: true, message: '', at: Date.now() })
}

function markBroken(platform, message) {
  health.set(platform, { ok: false, message, at: Date.now() })
}

async function notifyBroken(platform, message) {
  const last = lastNotified.get(platform) ?? 0
  if (Date.now() - last < NOTIFY_COOLDOWN_MS) return
  lastNotified.set(platform, Date.now())
  const label = PLATFORM_LABELS[platform] ?? platform
  try {
    await ctx.twilight.ui.notify({ kind: 'warn', message: `${label} 音源不可用：${message}` })
  } catch {
    /* notify 失败不影响业务 */
  }
  ctx.logger.warn(`[voicehub] ${label} 不可用：${message}`)
}

/** 统一处理音源失败：记录健康度、节流提示，然后返回兜底值 */
async function degrade(platform, error, fallback) {
  const message = error?.message || String(error)
  markBroken(platform, message)
  await notifyBroken(platform, message)
  return fallback
}

// ---------- 工具 ----------

function parseSize(text) {
  const match = /^([\d.]+)\s*(B|KB|MB|GB)$/i.exec(String(text ?? '').trim())
  if (!match) return 0
  const value = Number(match[1])
  if (!Number.isFinite(value)) return 0
  const unit = match[2].toUpperCase()
  const factor = unit === 'GB' ? 1024 ** 3 : unit === 'MB' ? 1024 ** 2 : unit === 'KB' ? 1024 : 1
  return Math.round(value * factor)
}

function toSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value))
  const text = String(value ?? '').trim()
  if (!text) return 0
  if (/^\d+$/.test(text)) return Number(text)
  const parts = text.split(':').map((item) => Number(item))
  if (parts.some((item) => !Number.isFinite(item))) return 0
  return parts.reduce((acc, item) => acc * 60 + item, 0)
}

function splitLocalId(trackId, providerId) {
  const text = String(trackId ?? '')
  const prefix = `${providerId}:`
  return text.startsWith(prefix) ? text.slice(prefix.length) : null
}

function pickQuality(requested, fallback) {
  const key = String(requested ?? '').trim().toLowerCase()
  if (key && QUALITY_OPTIONS.some((option) => option.value === key)) return key
  return fallback
}

function emptyResult() {
  return { items: [], total: 0 }
}

// ---------- 搜索缓存 ----------

const searchCache = new Map()

function pruneSearchCache() {
  if (searchCache.size <= 60) return
  const now = Date.now()
  for (const [key, entry] of searchCache) {
    if (entry.expiresAt <= now) searchCache.delete(key)
  }
  while (searchCache.size > 60) {
    const oldest = searchCache.keys().next().value
    if (oldest === undefined) break
    searchCache.delete(oldest)
  }
}

function withSearchCache(platform, keywords, limit, offset, run) {
  const key = `${platform}|${keywords}|${limit}|${offset}`
  const entry = searchCache.get(key)
  if (entry && entry.expiresAt > Date.now()) return entry.promise
  const promise = run()
  searchCache.set(key, { promise, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS })
  pruneSearchCache()
  // 失败的搜索不要留在缓存里，否则用户重试还是拿到同一个空结果
  promise.catch(() => searchCache.delete(key))
  return promise
}

// ---------- 同一首歌的识别（跨音源兜底用） ----------

function normalizeTerm(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[（(\[【].*?[)）\]】]/g, ' ')
    .replace(/[\s\-_·、,，.!！?？'"“”‘’/]/g, '')
    .trim()
}

function primaryArtist(artist) {
  return normalizeTerm(String(artist ?? '').split(/[/、,&]|feat\.?|ft\.?/i)[0])
}

function isSameSong(track, candidate) {
  const a = normalizeTerm(track?.title)
  const b = normalizeTerm(candidate?.title)
  if (!a || !b) return false
  const titleOk = a === b || a.includes(b) || b.includes(a)
  if (!titleOk) return false
  const artist = primaryArtist(track?.artist)
  const candArtist = primaryArtist(candidate?.artist)
  if (!artist || !candArtist) return true
  return candArtist.includes(artist) || artist.includes(candArtist)
}

function fallbackPlatforms(platform) {
  const { enableNetease } = config ?? {}
  return FALLBACK_PLATFORMS.filter((item) => item !== platform && (item !== 'netease' || enableNetease))
}

/** 在别的音源上找同一首歌并取直链；找不到就返回 null，绝不抛错 */
async function resolveElsewhere(platform, track, quality) {
  for (const other of fallbackPlatforms(platform)) {
    const spec = getSpec(other)
    if (!spec) continue
    try {
      const keywords = `${track.title} ${String(track.artist ?? '').split(/[/、,&]/)[0]}`.trim()
      const result = await spec.search(keywords, 5, 0)
      const candidate = (result?.items ?? []).find((item) => isSameSong(track, item))
      if (!candidate) continue
      const localId = splitLocalId(candidate.id, spec.id)
      if (!localId) continue
      const url = await spec.resolve(localId, candidate, quality)
      if (!url) continue
      ctx?.logger.info(`[voicehub] ${PLATFORM_LABELS[platform]} 取链失败，已切到 ${PLATFORM_LABELS[other]} 播放《${candidate.title}》`)
      return url
    } catch {
      /* 这个音源也不行，试下一个 */
    }
  }
  return null
}

// ---------- 曲目映射 ----------

function toTrack({ providerId, localId, title, artist, album, duration, cover, size }) {
  return {
    id: `${providerId}:${localId}`,
    title: String(title ?? '').trim() || '未知曲目',
    artist: String(artist ?? '').trim() || '未知艺术家',
    album: String(album ?? '').trim(),
    duration: Math.max(0, Math.round(Number(duration) || 0)),
    size: Math.max(0, Math.round(Number(size) || 0)),
    cover: cover || null,
    lyrics: null,
    filePath: '',
    fileName: '',
    source: providerId
  }
}

function mapTencent(item) {
  const types = Array.isArray(item?.types) ? item.types : []
  const best = types.find((entry) => entry?.type === 'flac') ?? types.find((entry) => entry?.type === '320k') ?? types[0]
  return toTrack({
    providerId: PROVIDER_TENCENT,
    localId: String(item?.songmid ?? '').trim(),
    title: item?.name,
    artist: item?.singer,
    album: item?.albumName,
    duration: item?.duration,
    cover: item?.img,
    size: parseSize(best?.size)
  })
}

function mapMigu(item) {
  return toTrack({
    providerId: PROVIDER_MIGU,
    localId: String(item?.songmid ?? '').trim(),
    title: item?.name,
    artist: item?.singer,
    album: item?.albumName,
    duration: item?.duration,
    cover: item?.img
  })
}

function mapBilibili(item) {
  const bvid = String(item?.id ?? '').trim()
  const cid = Array.isArray(item?.pages) && item.pages[0]?.cid ? String(item.pages[0].cid) : ''
  return toTrack({
    providerId: PROVIDER_BILIBILI,
    localId: cid ? `${bvid}:${cid}` : bvid,
    title: item?.title,
    artist: item?.artist,
    album: item?.album,
    duration: item?.duration,
    cover: item?.cover
  })
}

function mapNetease(item) {
  const artists = Array.isArray(item?.ar) ? item.ar.map((entry) => entry?.name).filter(Boolean).join('、') : ''
  return toTrack({
    providerId: PROVIDER_NETEASE,
    localId: String(item?.id ?? '').trim(),
    title: item?.name,
    artist: artists,
    album: item?.al?.name,
    duration: typeof item?.dt === 'number' ? Math.round(item.dt / 1000) : 0,
    cover: item?.al?.picUrl
  })
}

// ---------- 搜索 ----------

async function searchTencent(keywords, limit, offset) {
  const page = Math.floor(offset / limit) + 1
  // QQ 搜索正常时 0.6~4s 就回，坏的时候会一直挂到 60s 以上（站点上游聚合源的问题）。
  // 与其让用户干等 25s，不如 15s 就宣告失败、走降级提示。
  const data = await request('/api/native-api/search/tx', {
    query: { str: keywords, page, limit },
    timeoutMs: TENCENT_TIMEOUT_MS
  })
  const list = Array.isArray(data?.list) ? data.list : []
  const items = list.map(mapTencent).filter((track) => track.id !== `${PROVIDER_TENCENT}:`)
  const total = Number(data?.total)
  return { items, total: Number.isFinite(total) && total > 0 ? total : offset + items.length }
}

async function searchMigu(keywords, limit, offset) {
  const page = Math.floor(offset / limit) + 1
  const data = await request('/api/native-api/search/mg', {
    query: { str: keywords, page, limit }
  })
  const list = Array.isArray(data?.list) ? data.list : []
  const items = list.map(mapMigu).filter((track) => track.id !== `${PROVIDER_MIGU}:`)
  // 咪咕 v5 接口没有真实 total，服务端按「满页即还有下一页」推算，这里保持同样口径
  const serverTotal = Number(data?.total)
  const total =
    Number.isFinite(serverTotal) && serverTotal > 0 ? Math.max(serverTotal, offset + items.length) : offset + items.length + (items.length >= limit ? limit : 0)
  return { items, total }
}

async function searchBilibili(keywords, limit, offset) {
  // /api/bilibili/search 只接受 keyword，没有分页参数，本地切片。
  // 站点这边要现去 B 站调接口，慢的时候 15s 都回不来，所以单独放宽超时。
  const data = await request('/api/bilibili/search', { query: { keyword: keywords }, timeoutMs: BILIBILI_TIMEOUT_MS })
  const list = Array.isArray(data) ? data : []
  const mapped = list.map(mapBilibili).filter((track) => !track.id.endsWith(':') && track.id !== PROVIDER_BILIBILI)
  return {
    items: offset > 0 ? mapped.slice(offset, offset + limit) : mapped.slice(0, limit),
    total: mapped.length
  }
}

async function searchNetease(keywords, limit, offset) {
  const data = await request('/api/api-enhanced/netease/cloudsearch', {
    query: { keywords, limit, offset, type: 1 }
  })
  const songs = Array.isArray(data?.result?.songs) ? data.result.songs : []
  const items = songs.map(mapNetease).filter((track) => track.id !== `${PROVIDER_NETEASE}:`)
  const total = Number(data?.result?.songCount)
  return { items, total: Number.isFinite(total) && total > 0 ? total : offset + items.length }
}

// ---------- 播放链接 ----------

function cacheKey(platform, localId, quality) {
  return `${platform}|${localId}|${quality ?? ''}`
}

function readCache(key) {
  const entry = playbackCache.get(key)
  if (!entry) return undefined
  if (entry.expiresAt <= Date.now()) {
    playbackCache.delete(key)
    return undefined
  }
  return entry.url
}

function writeCache(key, url, ttl) {
  playbackCache.set(key, { url, expiresAt: Date.now() + ttl })
  if (playbackCache.size > 200) {
    const oldest = playbackCache.keys().next().value
    if (oldest !== undefined) playbackCache.delete(oldest)
  }
}

async function resolveTencent(localId, name, quality) {
  const data = await request('/api/music/resolve-url', {
    method: 'POST',
    timeoutMs: TENCENT_TIMEOUT_MS,
    body: {
      platform: 'tencent',
      musicId: localId,
      quality: TX_QUALITY[quality] ?? '8',
      name: name || undefined
    }
  })
  const url = String(data?.url ?? '').trim()
  if (!url) throw new VoiceHubError('QQ 音乐未返回播放链接', 502)
  return url
}

async function resolveMigu(localId, quality) {
  const data = await request('/api/native-api/migu/playurl', {
    query: { contentId: localId, toneFlag: MG_QUALITY[quality] ?? 'HQ' }
  })
  const url = String(data?.url ?? '').trim()
  if (!url) throw new VoiceHubError('咪咕未返回播放链接（可能是版权/会员限制）', 502)
  return url
}

async function resolveBilibili(localId) {
  const [bvid, cid] = localId.split(':')
  const data = await request('/api/bilibili/playurl', { query: { id: bvid, cid: cid || undefined }, timeoutMs: BILIBILI_TIMEOUT_MS })
  const url = String(data?.url ?? '').trim()
  if (!url) throw new VoiceHubError('哔哩哔哩未返回播放链接', 502)
  return url
}

async function resolveNetease(localId, quality) {
  const data = await request('/api/api-enhanced/netease/song/url/v1', {
    query: { id: localId, level: WY_QUALITY[quality] ?? 'exhigh' }
  })
  const entry = Array.isArray(data?.data) ? data.data[0] : null
  const url = String(entry?.url ?? '').trim()
  if (!url) throw new VoiceHubError('网易云未返回播放链接（可能需要登录或该曲目无版权）', 502)
  return url
}

// ---------- 歌词 ----------

async function lyricsTencent(localId, track) {
  const data = await request('/api/native-api/lyric/tx', {
    timeoutMs: LYRIC_TIMEOUT_MS,
    query: {
      songmid: localId,
      name: track.title,
      artist: track.artist,
      album: track.album,
      duration: track.duration
    }
  })
  return {
    lyrics: normalizeLyric(data?.data?.lrc ?? data?.lrc),
    translatedLyrics: normalizeLyric(data?.data?.trans ?? data?.trans)
  }
}

async function lyricsMigu(localId) {
  const data = await request('/api/native-api/lyric/mg', {
    query: { contentId: localId },
    timeoutMs: LYRIC_TIMEOUT_MS
  })
  return {
    lyrics: normalizeLyric(data?.data?.lrc ?? data?.lrc),
    translatedLyrics: normalizeLyric(data?.data?.trans ?? data?.trans)
  }
}

async function lyricsNetease(localId) {
  const data = await request('/api/api-enhanced/netease/lyric', { query: { id: localId } })
  return {
    lyrics: normalizeLyric(data?.lrc?.lyric),
    translatedLyrics: normalizeLyric(data?.tlyric?.lyric)
  }
}

function normalizeLyric(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  // 部分接口会把空歌词包成 "[00:00.00]" 之类，视为无歌词
  if (!/\[[^\]]*[1-9]/.test(text) && !/[^\s\[]/.test(text.replace(/\[[^\]]*\]/g, ''))) return null
  return text
}

/** 自己音源没歌词时，去别的音源找同一首的歌词（B 站没有歌词接口，跳过） */
async function lyricsElsewhere(platform, track) {
  for (const other of fallbackPlatforms(platform).filter((item) => item !== 'bilibili')) {
    const spec = getSpec(other)
    if (!spec?.lyrics) continue
    try {
      const keywords = `${track.title} ${String(track.artist ?? '').split(/[/、,&]/)[0]}`.trim()
      const result = await spec.search(keywords, 5, 0)
      const candidate = (result?.items ?? []).find((item) => isSameSong(track, item))
      if (!candidate) continue
      const localId = splitLocalId(candidate.id, spec.id)
      if (!localId) continue
      const found = await spec.lyrics(localId, candidate)
      if (found?.lyrics) {
        ctx?.logger.info(`[voicehub] 歌词改用 ${PLATFORM_LABELS[other]}：${candidate.title}`)
        return found
      }
    } catch {
      /* 换下一个音源 */
    }
  }
  return null
}

// ---------- provider 工厂 ----------

let SPECS = null

function getSpec(platform) {
  SPECS ??= {
    bilibili: {
      id: PROVIDER_BILIBILI,
      name: 'VoiceHub · 哔哩哔哩',
      search: searchBilibili,
      resolve: (localId) => resolveBilibili(localId),
      lyrics: null
    },
    migu: {
      id: PROVIDER_MIGU,
      name: 'VoiceHub · 咪咕音乐',
      search: searchMigu,
      resolve: (localId, _track, quality) => resolveMigu(localId, quality),
      lyrics: (localId) => lyricsMigu(localId)
    },
    tencent: {
      id: PROVIDER_TENCENT,
      name: 'VoiceHub · QQ 音乐',
      search: searchTencent,
      resolve: (localId, track, quality) => resolveTencent(localId, track.title, quality),
      lyrics: lyricsTencent
    },
    netease: {
      id: PROVIDER_NETEASE,
      name: 'VoiceHub · 网易云',
      search: searchNetease,
      resolve: (localId, _track, quality) => resolveNetease(localId, quality),
      lyrics: (localId) => lyricsNetease(localId)
    }
  }
  return SPECS[platform] ?? null
}

function makeProvider(platform) {
  const spec = getSpec(platform)
  const provider = {
    id: spec.id,
    name: spec.name,
    capabilities: CAPABILITIES,
    ui: { icon: 'pi pi-cloud', authType: 'settings', color: '#2f80ed' },

    async searchSongs(keywords, limit = 20, offset = 0) {
      const text = String(keywords ?? '').trim()
      if (!text) return emptyResult()
      const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100)
      const safeOffset = Math.max(Number(offset) || 0, 0)

      try {
        const result = await withSearchCache(platform, text, safeLimit, safeOffset, () =>
          spec.search(text, safeLimit, safeOffset)
        )
        markHealthy(platform)
        return { items: (result?.items ?? []).map((item) => ({ ...item })), total: result?.total ?? 0 }
      } catch (error) {
        return degrade(platform, error, emptyResult())
      }
    },

    async getPlaybackUrl(track, options = {}) {
      const localId = splitLocalId(track?.id, spec.id)
      if (!localId) {
        ctx?.logger.warn(`[voicehub] 曲目 ID 与音源不匹配：${track?.id}`)
        return null
      }

      const quality = pickQuality(options?.quality, (await loadConfig()).quality)
      const key = cacheKey(platform, localId, quality)
      const cached = readCache(key)
      if (cached !== undefined) return cached || null
      if (inflight.has(key)) return inflight.get(key)

      const task = (async () => {
        try {
          const url = await spec.resolve(localId, track, quality)
          markHealthy(platform)
          writeCache(key, url, PLAYBACK_CACHE_TTL_MS)
          return url
        } catch (error) {
          // 兜底一：别的音源上找同一首（QQ 聚合源 502 时最常见）
          if ((config ?? (await loadConfig())).autoFallback) {
            const fallbackUrl = await resolveElsewhere(platform, track, quality)
            if (fallbackUrl) {
              writeCache(key, fallbackUrl, PLAYBACK_CACHE_TTL_MS)
              return fallbackUrl
            }
          }
          // 播放链接是短时效直链，失败只做短负缓存，避免连点反复打站点
          writeCache(key, '', PLAYBACK_NEGATIVE_TTL_MS)
          return degrade(platform, error, null)
        } finally {
          inflight.delete(key)
        }
      })()

      inflight.set(key, task)
      return task
    },

    async getLyrics(track) {
      const localId = splitLocalId(track?.id, spec.id)
      if (!localId) return { lyrics: null, translatedLyrics: null }

      const empty = { lyrics: null, translatedLyrics: null }
      let own = null
      if (spec.lyrics) {
        try {
          const result = await spec.lyrics(localId, track)
          own = { lyrics: result?.lyrics ?? null, translatedLyrics: result?.translatedLyrics ?? null }
        } catch (error) {
          // 歌词缺失很常见，不值得弹通知
          ctx?.logger.info(`[voicehub] ${spec.name} 歌词获取失败：${error?.message || error}`)
        }
      }
      if (own?.lyrics) return own

      // 兜底：换个音源找同一首的歌词（咪咕歌词接口经常超时，QQ 一般更快）
      if ((config ?? (await loadConfig())).autoFallback) {
        const other = await lyricsElsewhere(platform, track)
        if (other?.lyrics) return { lyrics: other.lyrics, translatedLyrics: other.translatedLyrics ?? null }
      }
      return own ?? empty
    }
  }

  return provider
}

// ---------- 音源探测 ----------

async function probePlatform(platform) {
  const started = Date.now()
  try {
    const spec = {
      bilibili: () => request('/api/bilibili/search', { query: { keyword: 'test' }, timeoutMs: PROBE_TIMEOUT_MS }),
      migu: () => request('/api/native-api/search/mg', { query: { str: 'test', page: 1, limit: 1 }, timeoutMs: PROBE_TIMEOUT_MS }),
      tencent: () => request('/api/native-api/search/tx', { query: { str: 'test', page: 1, limit: 1 }, timeoutMs: PROBE_TIMEOUT_MS }),
      netease: () =>
        request('/api/api-enhanced/netease/cloudsearch', {
          query: { keywords: 'test', limit: 1, type: 1 },
          timeoutMs: PROBE_TIMEOUT_MS
        })
    }[platform]

    await spec()
    const elapsed = Date.now() - started
    markHealthy(platform)
    return { platform, ok: true, message: `正常（${elapsed}ms）` }
  } catch (error) {
    const message = error?.message || String(error)
    markBroken(platform, message)
    return { platform, ok: false, message }
  }
}

async function probeAll() {
  const platforms = ['bilibili', 'migu', 'tencent'].concat((await loadConfig()).enableNetease ? ['netease'] : [])
  return Promise.all(platforms.map((platform) => probePlatform(platform)))
}

function healthSummary() {
  const entries = ['bilibili', 'migu', 'tencent', 'netease']
    .map((platform) => {
      const item = health.get(platform)
      if (!item) return null
      const label = PLATFORM_LABELS[platform]
      const state = item.ok ? '正常' : `不可用（${item.message}）`
      return `${label}：${state}`
    })
    .filter(Boolean)

  if (entries.length === 0) return '还没检测过音源，点「检测音源」看看站点开放了哪些。'
  return `上次检测 — ${entries.join('；')}`
}

// ---------- 设置面板 ----------

async function buildSettingsForm() {
  const current = await loadConfig(true)
  const status = healthSummary()

  return {
    kind: 'settings-form',
    title: 'VoiceHub 音源设置',
    notice: status,
    submitCommand: SAVE_COMMAND,
    resetCommand: 'voicehub.settings.reset',
    fields: [
      {
        key: 'baseUrl',
        label: 'VoiceHub 地址',
        type: 'url',
        value: current.baseUrl,
        required: true,
        placeholder: 'https://music.example.com',
        description: '部署好的 VoiceHub 站点根地址，末尾斜杠会自动去掉',
        group: '连接'
      },
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        value: '',
        placeholder: current.apiKey ? '已保存，留空表示不修改' : '留空表示匿名访问',
        description: '仅在站点对音乐接口开启鉴权时需要；一般留空即可',
        group: '连接'
      },
      {
        key: 'connectionTest',
        label: '测试连接',
        type: 'button',
        command: TEST_COMMAND,
        description: '用当前填写的地址探一次搜索接口，不改动已保存的配置',
        group: '连接'
      },
      {
        key: 'sourceProbe',
        label: '检测音源',
        type: 'button',
        command: PROBE_COMMAND,
        description: '逐个探测哔哩哔哩 / 咪咕 / QQ / 网易云，站点没开放的音源会在这里标出来',
        group: '音源'
      },
      {
        key: 'enableNetease',
        label: '启用网易云音源',
        type: 'toggle',
        value: current.enableNetease ? 'true' : 'false',
        description: '网易云走 /api/api-enhanced/netease 代理，站点没配好会 502/504；改动后需重启应用生效',
        group: '音源'
      },
      {
        key: 'quality',
        label: '默认音质',
        type: 'select',
        value: current.quality,
        options: QUALITY_OPTIONS,
        description: '播放器没指定音质时使用；音源不支持会自动降级',
        group: '播放'
      },
      {
        key: 'autoFallback',
        label: '跨音源兜底',
        type: 'toggle',
        value: current.autoFallback ? 'true' : 'false',
        description: '某个音源放不出来时，自动去其它音源找同一首歌；歌词缺失时也会换源找',
        group: '播放'
      }
    ]
  }
}

async function handleTest(payload) {
  const values = payload?.values ?? payload ?? {}
  let baseUrl
  try {
    baseUrl = normalizeBaseUrl(values?.baseUrl)
  } catch (error) {
    return { message: error.message, form: await buildSettingsForm() }
  }

  // 用表单里填的值临时探一次，不落盘、也不污染已保存的配置
  const current = await loadConfig()
  const formKey = typeof values?.apiKey === 'string' ? values.apiKey.trim() : ''
  const key = formKey || current.apiKey

  try {
    const url = new URL(`${baseUrl}/api/native-api/search/mg`)
    url.searchParams.set('str', 'test')
    url.searchParams.set('limit', '1')
    const headers = { Accept: 'application/json' }
    if (key) headers['X-API-Key'] = key

    const response = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (response.ok) {
      return { message: `连接正常：${baseUrl} 的搜索接口有响应`, form: await buildSettingsForm() }
    }
    return {
      message: `连接失败：搜索接口返回 ${response.status}（地址能连上，但这个接口不通）`,
      form: await buildSettingsForm()
    }
  } catch (error) {
    const message = error?.name === 'TimeoutError' ? '请求超时' : error?.message || '网络错误'
    return { message: `连接失败：${message}`, form: await buildSettingsForm() }
  }
}

async function handleProbe() {
  const results = await probeAll()
  const lines = results.map((item) => `${PLATFORM_LABELS[item.platform]}：${item.ok ? item.message : `不可用 — ${item.message}`}`)
  const broken = results.filter((item) => !item.ok).length
  const head = broken === 0 ? '四个音源都通' : `${broken} 个音源不可用`
  return {
    message: `${head}｜${lines.join('；')}`,
    form: await buildSettingsForm()
  }
}

async function handleSave(payload) {
  const values = payload?.values ?? payload ?? {}
  let baseUrl
  try {
    baseUrl = normalizeBaseUrl(values?.baseUrl)
  } catch (error) {
    return { message: error.message }
  }

  const quality = pickQuality(values?.quality, '320k')
  const apiKeyInput = typeof values?.apiKey === 'string' ? values.apiKey.trim() : undefined
  const enableNetease = String(values?.enableNetease ?? '') === 'true'
  const autoFallback = String(values?.autoFallback ?? 'true') !== 'false'

  await ctx.settings.set('baseUrl', baseUrl)
  await ctx.settings.set('quality', quality)
  await ctx.settings.set('enableNetease', enableNetease ? 'true' : 'false')
  await ctx.settings.set('autoFallback', autoFallback ? 'true' : 'false')
  if (apiKeyInput) await ctx.settings.set('apiKey', apiKeyInput)

  invalidateConfig()
  playbackCache.clear()
  searchCache.clear()
  await loadConfig(true)

  const notes = []
  if (enableNetease) notes.push('网易云音源需重启应用后出现在音源列表')
  return {
    message: notes.length > 0 ? `已保存（${notes.join('；')}）` : '已保存',
    form: await buildSettingsForm()
  }
}

// ---------- 生命周期 ----------

export async function activate(context) {
  ctx = context
  await loadConfig(true)

  await context.twilight.providers.register(makeProvider('bilibili'))
  await context.twilight.providers.register(makeProvider('migu'))
  await context.twilight.providers.register(makeProvider('tencent'))

  // 网易云依赖站点的 api-enhanced 代理，默认不注册，避免音源列表里挂一个永远搜不到东西的条目
  if (config.enableNetease) {
    await context.twilight.providers.register(makeProvider('netease'))
  }

  unsubscribers = [
    context.twilight.ui.onCommand(PANEL_COMMAND, async () => buildSettingsForm()),
    context.twilight.ui.onCommand(SAVE_COMMAND, handleSave),
    context.twilight.ui.onCommand(TEST_COMMAND, handleTest),
    context.twilight.ui.onCommand(PROBE_COMMAND, handleProbe),
    context.twilight.ui.onCommand('voicehub.settings.reset', async () => {
      await handleSave({ baseUrl: DEFAULT_BASE_URL, quality: '320k', apiKey: '', enableNetease: 'false', autoFallback: 'true' })
      await ctx.settings.delete('apiKey')
      invalidateConfig()
      return { message: '已恢复默认设置', form: await buildSettingsForm() }
    })
  ]

  await context.twilight.ui.register({
    id: 'voicehub.settings',
    kind: 'settingsPanel',
    title: 'VoiceHub 音源',
    description: '配置 VoiceHub 站点地址、默认音质，并检测各音源是否可用',
    command: PANEL_COMMAND,
    autoLoad: true
  })

  context.logger.info(
    `[voicehub] 已注册音源：哔哩哔哩 / 咪咕 / QQ${config.enableNetease ? ' / 网易云' : ''}，站点 ${config.baseUrl}`
  )

  // 启动后台探测一次，让设置面板首次打开就有状态可用（失败不影响加载）
  probeAll().catch((error) => context.logger.debug(`[voicehub] 启动探测失败：${error?.message || error}`))
}

export function deactivate() {
  for (const off of unsubscribers) {
    try {
      off()
    } catch {
      /* 注销失败不影响卸载 */
    }
  }
  unsubscribers = []
  playbackCache.clear()
  searchCache.clear()
  inflight.clear()
  health.clear()
  lastNotified.clear()
  invalidateConfig()
  ctx = null
}
