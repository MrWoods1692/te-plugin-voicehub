#!/usr/bin/env node
/**
 * VoiceHub 站点联调脚本：探一遍插件会用到的接口，告诉你这台站点开放了哪些音源。
 *
 *   node smoke.mjs https://music.example.com
 *   node smoke.mjs http://127.0.0.1:3000 晴天
 *   node smoke.mjs https://music.example.com 晴天 <apiKey>
 *
 * 只发读请求，不改站点任何数据。
 */

const baseUrlArg = process.argv[2]
if (!baseUrlArg) {
  console.error('用法: node smoke.mjs <baseUrl> [keyword] [apiKey]')
  process.exit(2)
}

const base = baseUrlArg.replace(/\/+$/, '')
const keyword = process.argv[3] || '晴天'
const apiKey = process.argv[4] || ''

const headers = { Accept: 'application/json' }
if (apiKey) headers['X-API-Key'] = apiKey

async function call(path, { method = 'GET', query, body, timeoutMs = 15000 } = {}) {
  const url = new URL(`${base}${path}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  const response = await fetch(url, {
    method,
    headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  })
  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    /* 保留 null */
  }
  return { status: response.status, ok: response.ok, data, text }
}

const rows = []
function report(label, ok, detail) {
  rows.push({ label, ok, detail })
  const mark = ok ? '✓' : '✗'
  console.log(`  ${mark} ${label}${detail ? `  — ${detail}` : ''}`)
}

async function tryStep(label, fn) {
  try {
    const detail = await fn()
    report(label, true, detail)
    return true
  } catch (error) {
    report(label, false, error?.message || String(error))
    return false
  }
}

function fail(response) {
  const message = response?.data?.message || response?.data?.statusMessage || (response?.text || '').slice(0, 80)
  throw new Error(`HTTP ${response?.status}${message ? `：${message}` : ''}`)
}

console.log(`\n探测站点 ${base}，关键词「${keyword}」${apiKey ? '（带 API Key）' : '（匿名）'}\n`)

// ---------- QQ 音乐 ----------

let txTrack = null
await tryStep('QQ 搜索  /api/native-api/search/tx', async () => {
  const response = await call('/api/native-api/search/tx', { query: { str: keyword, page: 1, limit: 3 } })
  if (!response.ok) fail(response)
  const list = response.data?.list || []
  if (list.length === 0) throw new Error('搜索为空（该站可能没配 QQ 音源）')
  txTrack = list[0]
  return `${list.length} 条，首条：${txTrack.name} - ${txTrack.singer}`
})

if (txTrack?.songmid) {
  await tryStep('QQ 播放  /api/music/resolve-url', async () => {
    const response = await call('/api/music/resolve-url', {
      method: 'POST',
      body: { platform: 'tencent', musicId: txTrack.songmid, quality: '8', name: txTrack.name }
    })
    if (!response.ok) fail(response)
    const url = response.data?.url || ''
    if (!url) throw new Error('没有返回 url')
    return `${response.data?.source || 'ok'}：${url.slice(0, 60)}…`
  })

  await tryStep('QQ 歌词  /api/native-api/lyric/tx', async () => {
    const response = await call('/api/native-api/lyric/tx', {
      query: { songmid: txTrack.songmid, name: txTrack.name, artist: txTrack.singer, album: txTrack.albumName, duration: txTrack.duration }
    })
    if (!response.ok) fail(response)
    const lrc = response.data?.data?.lrc || ''
    if (!lrc) throw new Error('返回空歌词')
    return `${lrc.length} 字符`
  })
}

// ---------- 咪咕音乐 ----------

let mgTrack = null
await tryStep('咪咕搜索  /api/native-api/search/mg', async () => {
  const response = await call('/api/native-api/search/mg', { query: { str: keyword, page: 1, limit: 3 } })
  if (!response.ok) fail(response)
  const list = response.data?.list || []
  if (list.length === 0) throw new Error('搜索为空（该站可能没配咪咕音源）')
  mgTrack = list[0]
  return `${list.length} 条，首条：${mgTrack.name} - ${mgTrack.singer}`
})

if (mgTrack?.songmid) {
  await tryStep('咪咕播放  /api/native-api/migu/playurl', async () => {
    const response = await call('/api/native-api/migu/playurl', { query: { contentId: mgTrack.songmid, toneFlag: 'HQ' } })
    if (!response.ok) fail(response)
    const url = response.data?.url || ''
    if (!url) throw new Error('没有返回 url（可能版权受限）')
    return `音质 ${response.data?.quality || '?'}：${url.slice(0, 60)}…`
  })

  await tryStep('咪咕歌词  /api/native-api/lyric/mg', async () => {
    const response = await call('/api/native-api/lyric/mg', { query: { contentId: mgTrack.songmid } })
    if (!response.ok) fail(response)
    const lrc = response.data?.data?.lrc || ''
    if (!lrc) throw new Error('返回空歌词')
    return `${lrc.length} 字符`
  })
}

// ---------- 哔哩哔哩 ----------

let biliItem = null
await tryStep('哔哩哔哩搜索  /api/bilibili/search', async () => {
  const response = await call('/api/bilibili/search', { query: { keyword }, timeoutMs: 40000 })
  if (!response.ok) fail(response)
  const list = Array.isArray(response.data) ? response.data : []
  if (list.length === 0) throw new Error('搜索为空（该站可能没配哔哩哔哩音源）')
  biliItem = list[0]
  return `${list.length} 条，首条：${biliItem.title?.slice(0, 40)}`
})

if (biliItem?.id) {
  await tryStep('哔哩哔哩播放  /api/bilibili/playurl', async () => {
    const cid = biliItem.pages?.[0]?.cid
    const response = await call('/api/bilibili/playurl', { query: { id: biliItem.id, cid } })
    if (!response.ok) fail(response)
    const url = response.data?.url || ''
    if (!url) throw new Error('没有返回 url')
    return `${url.slice(0, 60)}…`
  })
}

// ---------- 网易云 ----------

await tryStep('网易云搜索  /api/api-enhanced/netease/cloudsearch', async () => {
  const response = await call('/api/api-enhanced/netease/cloudsearch', {
    query: { keywords: keyword, limit: 3, type: 1 },
    timeoutMs: 25000
  })
  if (!response.ok) fail(response)
  const songs = response.data?.result?.songs || []
  if (songs.length === 0) throw new Error('搜索为空')
  return `${songs.length} 条，首条：${songs[0].name}`
})

// ---------- 汇总 ----------

const find = (prefix) => rows.find((row) => row.label.startsWith(prefix))
const state = (prefix) => {
  const row = find(prefix)
  if (!row) return '未测'
  return row.ok ? '通' : '不通'
}

const summary = [
  ['QQ 音乐', 'QQ 搜索', 'QQ 播放'],
  ['咪咕音乐', '咪咕搜索', '咪咕播放'],
  ['哔哩哔哩', '哔哩哔哩搜索', '哔哩哔哩播放'],
  ['网易云', '网易云搜索', null]
]

console.log('\n汇总：')
for (const [name, searchPrefix, playPrefix] of summary) {
  const search = state(searchPrefix)
  const play = playPrefix ? state(playPrefix) : null
  const mark = search === '通' ? (play === '不通' ? '⚠' : '✓') : '✗'
  console.log(`  ${mark} ${name}：搜索${search}${play === null ? '' : `，播放${play}`}`)
}

const usable = summary.filter(([, searchPrefix]) => state(searchPrefix) === '通').map(([name]) => name)
console.log(`\n可用音源：${usable.length > 0 ? usable.join(' / ') : '无'}`)
if (usable.length === 0) {
  console.log('⚠ 一个都没通：先确认 baseUrl 指向 VoiceHub 站点，再看站点后台是否配置了音源插件。')
} else if (state('网易云搜索') !== '通') {
  console.log('提示：网易云走 /api/api-enhanced/netease 代理，这台站点不通，插件默认就不注册它。')
}
console.log('')
