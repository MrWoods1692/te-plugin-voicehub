#!/usr/bin/env node
/**
 * 离线自测：起一个 mock VoiceHub，用假宿主 context 加载插件，验证契约与降级行为。
 * 不依赖 Twilight Echo，也不需要真的 VoiceHub。
 *
 *   node dev/selftest.mjs
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

const PROVIDER_BILIBILI = 'voicehub-bilibili'
const PROVIDER_MIGU = 'voicehub-migu'
const PROVIDER_TENCENT = 'voicehub-tencent'
const PROVIDER_NETEASE = 'voicehub-netease'

// ---------- mock VoiceHub ----------

const observed = { calls: [], apiKeys: [], bodies: [] }

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  let raw = ''
  req.on('data', (chunk) => { raw += chunk })
  req.on('end', () => {
    observed.calls.push(`${req.method} ${url.pathname}`)
    if (req.headers['x-api-key']) observed.apiKeys.push(String(req.headers['x-api-key']))

    const json = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    const body = () => {
      try { return raw ? JSON.parse(raw) : {} } catch { return {} }
    }
    if (raw) observed.bodies.push(body())

    const path = url.pathname

    if (path === '/api/native-api/search/tx') {
      return json(200, {
        list: [
          {
            singer: '周杰伦',
            name: '晴天',
            albumName: '叶惠美',
            source: 'tx',
            interval: '04:29',
            duration: 269,
            songid: 97773,
            songmid: '0039MnYb0qxYhV',
            strMediaMid: '003Qui1q2u1Zho',
            img: 'https://y.gtimg.cn/music/photo_new/T002R500x500M000000MkMni19ClKG.jpg',
            types: [{ type: '128k', size: '4.12MB' }, { type: '320k', size: '10.29MB' }, { type: 'flac', size: '52.83MB' }]
          },
          {
            // 没有 songmid 的脏数据，应被过滤
            singer: '周杰伦',
            name: '没有歌曲 ID 的条目',
            albumName: ''
          }
        ],
        total: 42,
        page: 1,
        limit: 10,
        source: 'tx'
      })
    }

    if (path === '/api/native-api/search/mg') {
      if (url.searchParams.get('str') === 'boom') return json(500, { message: '咪咕上游炸了' })
      return json(200, {
        list: [
          {
            singer: '周杰伦',
            name: '晴天',
            albumName: '叶惠美',
            source: 'mg',
            interval: '04:30',
            duration: 270,
            songmid: '600902000006889366',
            copyrightId: '60054701923',
            img: 'https://d.musicapp.migu.cn/data/oss/x.webp',
            lrc: null,
            mrcUrl: null,
            types: ['PQ', 'HQ', 'SQ', 'Z3D']
          }
        ],
        total: 1
      })
    }

    if (path === '/api/bilibili/search') {
      return json(200, [
        {
          id: 'BV1BZbSzZEGT',
          title: '【Hi-Res无损】《晴天》- 周杰伦',
          artist: 'VV音乐局',
          source: 'bilibili',
          musicPlatform: 'bilibili',
          cover: 'https://i0.hdslb.com/bfs/archive/b72e06e.jpg',
          duration: 270,
          album: 'Bilibili Video',
          pages: [{ cid: 31268997329, page: 1, part: 'P1', duration: 270 }]
        },
        {
          id: 'BV1d4411N7zD',
          title: '晴天 (Live)',
          artist: '某UP主',
          cover: '',
          duration: 200,
          album: 'Bilibili Video',
          pages: [{ cid: 200, page: 1, part: 'P1', duration: 200 }]
        }
      ])
    }

    if (path === '/api/music/resolve-url' && req.method === 'POST') {
      const payload = body()
      if (payload.musicId !== '0039MnYb0qxYhV') return json(502, { message: 'QQ 聚合源解析失败' })
      return json(200, { success: true, url: `http://127.0.0.1:${port}/stream/tx.mp3`, source: 'yuafeng-tx' })
    }

    if (path === '/api/native-api/migu/playurl') {
      const contentId = url.searchParams.get('contentId')
      const toneFlag = url.searchParams.get('toneFlag')
      if (contentId !== '600902000006889366') return json(400, { message: 'contentId 无效' })
      return json(200, { success: true, url: `http://127.0.0.1:${port}/stream/mg-${toneFlag}.mp3`, quality: toneFlag, source: 'migu' })
    }

    if (path === '/api/bilibili/playurl') {
      const id = url.searchParams.get('id')
      const cid = url.searchParams.get('cid')
      return json(200, { url: `http://127.0.0.1:${port}/stream/${id}-${cid}.mp4`, pay: false })
    }

    if (path === '/api/native-api/lyric/tx') {
      return json(200, { success: true, data: { lrc: '[00:00.00]晴天', qrc: '', trans: '[00:00.00]晴天（译）', roma: '' } })
    }

    if (path === '/api/native-api/lyric/mg') {
      if (url.searchParams.get('contentId') === 'nolrc') return json(500, { message: '咪咕歌词挂了' })
      return json(200, { success: true, data: { lrc: '[00:00.000]晴天 - 周杰伦', trans: '', yrc: '', ttml: '' } })
    }

    // 站点没开放网易云代理的样子：网关超时
    if (path.startsWith('/api/api-enhanced/netease/')) {
      return json(502, { message: '网易云接口调用失败' })
    }

    return json(404, { message: 'Not Found' })
  })
})

const port = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})
const baseUrl = `http://127.0.0.1:${port}`

// ---------- 假宿主 ----------

const store = new Map()
const registered = []
const commands = new Map()
const uiContributions = []
const notifications = []

const context = {
  apiVersion: 1,
  storagePath: 'C:\\tmp\\voicehub-plugin',
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  settings: {
    get: async (key) => store.get(key),
    set: async (key, value) => { store.set(key, value) },
    delete: async (key) => { store.delete(key) }
  },
  twilight: {
    providers: { register: async (provider) => { registered.push(provider) } },
    ui: {
      register: async (contribution) => { uiContributions.push(contribution) },
      onCommand: (command, handler) => {
        commands.set(command, handler)
        return () => commands.delete(command)
      },
      notify: async (notice) => { notifications.push(notice) }
    }
  }
}

const plugin = await import(pathToFileURL(path.join(root, 'index.mjs')).href)

function provider(id) {
  const found = registered.find((item) => item.id === id)
  assert.ok(found, `没有注册 provider ${id}`)
  return found
}

// ---------- 用例 ----------

const checks = []
function check(name, fn) {
  checks.push({ name, fn })
}

check('模块导出 activate / deactivate', () => {
  assert.equal(typeof plugin.activate, 'function')
  assert.equal(typeof plugin.deactivate, 'function')
})

check('activate 注册三个默认音源，id 合法', async () => {
  store.set('baseUrl', `${baseUrl}/`) // 故意带尾斜杠
  await plugin.activate(context)
  assert.deepEqual(registered.map((p) => p.id).sort(), [PROVIDER_BILIBILI, PROVIDER_MIGU, PROVIDER_TENCENT])
  for (const item of registered) {
    // 宿主校验：/^[a-z][a-z0-9-]*$/，不允许点号
    assert.match(item.id, /^[a-z][a-z0-9-]*$/)
    assert.ok(item.name)
    assert.deepEqual(item.capabilities, ['search', 'playbackUrl', 'lyrics'])
    assert.equal(typeof item.searchSongs, 'function')
    assert.equal(typeof item.getPlaybackUrl, 'function')
    assert.equal(typeof item.getLyrics, 'function')
  }
})

check('register 的 id 不重复', () => {
  const ids = registered.map((p) => p.id)
  assert.equal(new Set(ids).size, ids.length)
})

let txTrack = null
check('QQ 搜索映射出合法 Track', async () => {
  const result = await provider(PROVIDER_TENCENT).searchSongs('晴天', 10, 0)
  assert.equal(result.items.length, 1, '缺 songmid 的脏数据应被过滤')
  assert.equal(result.total, 42)

  txTrack = result.items[0]
  assert.equal(txTrack.id, `${PROVIDER_TENCENT}:0039MnYb0qxYhV`)
  assert.equal(txTrack.title, '晴天')
  assert.equal(txTrack.artist, '周杰伦')
  assert.equal(txTrack.album, '叶惠美')
  assert.equal(txTrack.duration, 269)
  assert.equal(txTrack.size, Math.round(52.83 * 1024 * 1024), 'size 应取最高音质并换算成字节')
  assert.equal(txTrack.source, PROVIDER_TENCENT, 'track.source 必须是 provider id，否则播放路由找不到音源')
  assert.equal(txTrack.filePath, '')
  assert.equal(txTrack.lyrics, null)
})

check('空关键词不发请求', async () => {
  observed.calls.length = 0
  const result = await provider(PROVIDER_TENCENT).searchSongs('   ', 10, 0)
  assert.deepEqual(result, { items: [], total: 0 })
  assert.equal(observed.calls.length, 0)
})

check('QQ 搜索把 offset 换算成 page', async () => {
  const captured = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    captured.push(String(input))
    return original(input, init)
  }
  try {
    await provider(PROVIDER_TENCENT).searchSongs('晴天', 10, 30)
  } finally {
    globalThis.fetch = original
  }
  assert.equal(captured.length, 1)
  const url = new URL(captured[0])
  assert.equal(url.searchParams.get('page'), '4', 'offset 30 / limit 10 应换算成第 4 页')
  assert.equal(url.searchParams.get('limit'), '10')
  assert.equal(url.searchParams.get('str'), '晴天')
})

check('咪咕搜索映射出合法 Track', async () => {
  const result = await provider(PROVIDER_MIGU).searchSongs('晴天', 10, 0)
  assert.equal(result.items.length, 1)
  const track = result.items[0]
  assert.equal(track.id, `${PROVIDER_MIGU}:600902000006889366`)
  assert.equal(track.source, PROVIDER_MIGU)
  assert.equal(track.cover, 'https://d.musicapp.migu.cn/data/oss/x.webp')
})

check('哔哩哔哩搜索把 cid 编进曲目 ID', async () => {
  const result = await provider(PROVIDER_BILIBILI).searchSongs('晴天', 1, 0)
  assert.equal(result.total, 2)
  assert.equal(result.items.length, 1, 'limit=1 应在本地截断')
  const track = result.items[0]
  assert.equal(track.id, `${PROVIDER_BILIBILI}:BV1BZbSzZEGT:31268997329`)
  assert.equal(track.source, PROVIDER_BILIBILI)
  assert.equal(track.album, 'Bilibili Video')
})

check('QQ 播放链接按音质映射成数字并带上歌名', async () => {
  observed.bodies.length = 0
  const url = await provider(PROVIDER_TENCENT).getPlaybackUrl(txTrack, { quality: '320k' })
  assert.equal(url, `${baseUrl}/stream/tx.mp3`)
  const payload = observed.bodies.at(-1)
  assert.equal(payload.platform, 'tencent')
  assert.equal(payload.musicId, '0039MnYb0qxYhV')
  assert.equal(payload.quality, '8', '320k 应映射成 QQ 的 8')
  assert.equal(payload.name, '晴天', '要带歌名，聚合源回退时靠它匹配')
})

check('播放链接命中缓存，不重复打站点', async () => {
  observed.calls.length = 0
  const url = await provider(PROVIDER_TENCENT).getPlaybackUrl(txTrack, { quality: '320k' })
  assert.equal(url, `${baseUrl}/stream/tx.mp3`)
  assert.equal(observed.calls.length, 0, '缓存期内不应再发请求')
})

check('咪咕播放链接按音质映射成 toneFlag', async () => {
  observed.calls.length = 0
  const track = (await provider(PROVIDER_MIGU).searchSongs('晴天', 10, 0)).items[0]
  const url = await provider(PROVIDER_MIGU).getPlaybackUrl(track, { quality: '320k' })
  assert.equal(url, `${baseUrl}/stream/mg-HQ.mp3`)
  assert.ok(observed.calls.includes('GET /api/native-api/migu/playurl'))
})

check('哔哩哔哩播放链接带上 bvid 与 cid', async () => {
  const track = (await provider(PROVIDER_BILIBILI).searchSongs('晴天', 1, 0)).items[0]
  const url = await provider(PROVIDER_BILIBILI).getPlaybackUrl(track, {})
  assert.equal(url, `${baseUrl}/stream/BV1BZbSzZEGT-31268997329.mp4`)
})

check('曲目 ID 与音源不匹配时返回 null', async () => {
  const url = await provider(PROVIDER_TENCENT).getPlaybackUrl({ ...txTrack, id: `${PROVIDER_MIGU}:0039MnYb0qxYhV` }, {})
  assert.equal(url, null)
})

check('QQ 歌词解析 lrc 与翻译', async () => {
  const lyrics = await provider(PROVIDER_TENCENT).getLyrics(txTrack)
  assert.equal(lyrics.lyrics, '[00:00.00]晴天')
  assert.equal(lyrics.translatedLyrics, '[00:00.00]晴天（译）')
})

check('咪咕歌词走 contentId', async () => {
  const track = (await provider(PROVIDER_MIGU).searchSongs('晴天', 10, 0)).items[0]
  const lyrics = await provider(PROVIDER_MIGU).getLyrics(track)
  assert.match(lyrics.lyrics, /晴天/)
})

check('哔哩哔哩没有歌词接口，静默返回 null', async () => {
  const track = (await provider(PROVIDER_BILIBILI).searchSongs('晴天', 1, 0)).items[0]
  const lyrics = await provider(PROVIDER_BILIBILI).getLyrics(track)
  assert.equal(lyrics.lyrics, null)
  assert.equal(lyrics.translatedLyrics, null)
})

check('单个音源 500 时只降级自己，返回空结果', async () => {
  notifications.length = 0
  const result = await provider(PROVIDER_MIGU).searchSongs('boom', 10, 0)
  assert.deepEqual(result, { items: [], total: 0 })
  assert.equal(notifications.length, 1, '应弹一次提示说明原因')
  assert.match(notifications[0].message, /咪咕音乐 音源不可用/)
  // 其它音源不受影响
  const ok = await provider(PROVIDER_TENCENT).searchSongs('晴天', 5, 0)
  assert.equal(ok.items.length, 1)
})

check('网易云默认不注册；开了开关才注册', async () => {
  assert.equal(registered.some((p) => p.id === PROVIDER_NETEASE), false)
  plugin.deactivate()
  registered.length = 0
  commands.clear()
  uiContributions.length = 0
  store.set('enableNetease', 'true')
  await plugin.activate(context)
  assert.ok(registered.some((p) => p.id === PROVIDER_NETEASE))
})

check('网易云代理 502 时降级为空结果而不抛错', async () => {
  notifications.length = 0
  const result = await provider(PROVIDER_NETEASE).searchSongs('晴天', 10, 0)
  assert.deepEqual(result, { items: [], total: 0 })
  assert.match(notifications[0].message, /网易云 音源不可用/)
})

check('提示有冷却，不会刷屏', async () => {
  notifications.length = 0
  await provider(PROVIDER_NETEASE).searchSongs('晴天', 10, 0)
  assert.equal(notifications.length, 0, '同一音源 5 分钟内只提示一次')
})

check('注册了设置面板 UI 扩展点', () => {
  const panel = uiContributions.find((item) => item.kind === 'settingsPanel')
  assert.ok(panel)
  assert.equal(panel.command, 'voicehub.settings.panel')
  assert.equal(panel.autoLoad, true)
})

check('设置表单 DTO 通过宿主校验规则', async () => {
  const form = await commands.get('voicehub.settings.panel')({ source: 'settingsPanel', panelId: 'voicehub.settings' })
  assert.equal(form.kind, 'settings-form')
  assert.ok(form.submitCommand.length >= 1 && form.submitCommand.length <= 160)
  assert.ok(Array.isArray(form.fields) && form.fields.length > 0 && form.fields.length <= 40)
  assert.ok(typeof form.notice === 'string' && form.notice.length <= 500)

  const allowedTypes = new Set(['text', 'password', 'url', 'select', 'toggle', 'range', 'color', 'button'])
  for (const field of form.fields) {
    assert.match(field.key, /^[A-Za-z0-9_.:-]{1,80}$/, `key 不合法: ${field.key}`)
    assert.ok(field.label.length > 0 && field.label.length <= 100)
    assert.ok(allowedTypes.has(field.type), `type 不合法: ${field.type}`)
    if (typeof field.description === 'string') assert.ok(field.description.length <= 200)
    if (typeof field.group === 'string') assert.ok(field.group.length <= 60)
    if (field.type === 'select') {
      assert.ok(field.options.length > 0 && field.options.length <= 30)
      for (const option of field.options) assert.ok(option.label.length <= 100 && option.value.length <= 200)
    }
    if (field.type === 'password') assert.equal(field.value, '')
    if (field.type === 'button') assert.ok(typeof field.command === 'string' && field.command.length > 0)
  }

  const baseField = form.fields.find((f) => f.key === 'baseUrl')
  assert.equal(baseField.value, baseUrl, '尾斜杠应被归一化掉')
  assert.equal(baseField.required, true)
  assert.ok(form.fields.some((f) => f.key === 'sourceProbe' && f.command === 'voicehub.settings.probe'))
  assert.ok(form.fields.some((f) => f.key === 'enableNetease' && f.type === 'toggle'))
})

check('保存命令写盘并归一化音质', async () => {
  const result = await commands.get('voicehub.settings.save')({
    baseUrl: `${baseUrl}/`,
    apiKey: '  secret-key  ',
    quality: '320k',
    enableNetease: 'false'
  })
  assert.equal(result.message, '已保存')
  assert.equal(store.get('baseUrl'), baseUrl)
  assert.equal(store.get('apiKey'), 'secret-key')
  assert.equal(store.get('quality'), '320k')
  assert.equal(store.get('enableNetease'), 'false')
  assert.equal(result.form.kind, 'settings-form')
})

check('保存后请求带上 X-API-Key', async () => {
  observed.apiKeys.length = 0
  await provider(PROVIDER_TENCENT).searchSongs('晴天', 5, 0)
  assert.deepEqual(observed.apiKeys, ['secret-key'])
})

check('非法地址报错且不落盘', async () => {
  const before = store.get('baseUrl')
  const result = await commands.get('voicehub.settings.save')({ baseUrl: 'ftp://nope.example.com' })
  assert.match(result.message, /http 或 https/)
  assert.equal(store.get('baseUrl'), before)
})

check('空地址回落到默认值', async () => {
  const result = await commands.get('voicehub.settings.save')({ baseUrl: '   ', quality: 'flac' })
  assert.equal(result.message, '已保存')
  assert.equal(store.get('baseUrl'), 'http://127.0.0.1:3000')
  await commands.get('voicehub.settings.save')({ baseUrl, apiKey: 'secret-key', quality: '320k' })
})

check('保存后新地址立即生效', async () => {
  await commands.get('voicehub.settings.save')({ baseUrl: 'http://127.0.0.1:1', quality: '320k' })
  assert.deepEqual(await provider(PROVIDER_TENCENT).searchSongs('晴天', 5, 0), { items: [], total: 0 })
  await commands.get('voicehub.settings.save')({ baseUrl, quality: '320k' })
  const result = await provider(PROVIDER_TENCENT).searchSongs('晴天', 5, 0)
  assert.equal(result.items.length, 1)
})

check('测试连接命令可用', async () => {
  const result = await commands.get('voicehub.settings.test')({ action: 'connectionTest', values: { baseUrl } })
  assert.match(result.message, /连接正常/)
  assert.equal(store.get('baseUrl'), baseUrl, '测试不应改动已保存配置')
})

check('测试连接失败时给出可读错误', async () => {
  const result = await commands.get('voicehub.settings.test')({ action: 'connectionTest', values: { baseUrl: 'http://127.0.0.1:1' } })
  assert.match(result.message, /连接失败/)
})

check('检测音源命令汇总各音源状态', async () => {
  const result = await commands.get('voicehub.settings.probe')({ action: 'sourceProbe', values: {} })
  assert.match(result.message, /哔哩哔哩|咪咕音乐|QQ 音乐/)
  assert.match(result.message, /不可用|正常/)
  assert.equal(result.form.kind, 'settings-form')
})

check('重置命令恢复默认并清掉密钥', async () => {
  const result = await commands.get('voicehub.settings.reset')({})
  assert.match(result.message, /已恢复默认/)
  assert.equal(store.get('baseUrl'), 'http://127.0.0.1:3000')
  assert.equal(store.get('apiKey'), undefined)
})

check('同一关键词第二次搜索走缓存，不重复打站点', async () => {
  await commands.get('voicehub.settings.save')({ baseUrl, quality: '320k' })
  observed.calls.length = 0
  await provider(PROVIDER_MIGU).searchSongs('缓存关键词', 5, 0)
  const afterFirst = observed.calls.filter((call) => call === 'GET /api/native-api/search/mg').length
  await provider(PROVIDER_MIGU).searchSongs('缓存关键词', 5, 0)
  const afterSecond = observed.calls.filter((call) => call === 'GET /api/native-api/search/mg').length
  assert.equal(afterFirst, 1)
  assert.equal(afterSecond, 1, '第二次应命中缓存，不再发请求')
})

check('播放取链失败时自动切到别的音源放同一首', async () => {
  const broken = {
    id: `${PROVIDER_TENCENT}:BROKEN-ID`,
    title: '晴天',
    artist: '周杰伦',
    album: '叶惠美',
    duration: 269,
    source: PROVIDER_TENCENT
  }
  const url = await provider(PROVIDER_TENCENT).getPlaybackUrl(broken, { quality: '320k' })
  assert.ok(url, '应有兜底直链')
  assert.match(String(url), /\/stream\/mg-HQ\.mp3$/, '应回退到咪咕 HQ 直链')
})

check('关掉跨音源兜底后不再换源', async () => {
  await commands.get('voicehub.settings.save')({ baseUrl, quality: '320k', autoFallback: 'false' })
  assert.equal(store.get('autoFallback'), 'false')
  const broken = {
    id: `${PROVIDER_TENCENT}:BROKEN-2`,
    title: '晴天',
    artist: '周杰伦',
    album: '叶惠美',
    duration: 269,
    source: PROVIDER_TENCENT
  }
  assert.equal(await provider(PROVIDER_TENCENT).getPlaybackUrl(broken, { quality: '320k' }), null)
  await commands.get('voicehub.settings.save')({ baseUrl, quality: '320k', autoFallback: 'true' })
})

check('自己音源没歌词时换源取歌词', async () => {
  const track = {
    id: `${PROVIDER_MIGU}:nolrc`,
    title: '晴天',
    artist: '周杰伦',
    album: '叶惠美',
    duration: 270,
    source: PROVIDER_MIGU
  }
  const result = await provider(PROVIDER_MIGU).getLyrics(track)
  assert.ok(result.lyrics, '应拿到别处的歌词')
  assert.match(result.lyrics, /晴天/)
})

check('deactivate 注销命令', () => {
  plugin.deactivate()
  assert.equal(commands.size, 0)
})
// ---------- 执行 ----------

let failed = 0
for (const { name, fn } of checks) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed += 1
    console.log(`  ✗ ${name}`)
    console.log(`      ${err?.message ?? err}`)
  }
}

server.close()
console.log(`\n${checks.length - failed}/${checks.length} 通过`)
if (failed > 0) process.exitCode = 1
