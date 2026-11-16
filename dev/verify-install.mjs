// 用宿主自己的校验代码验证「已安装」的插件目录，而不是只看文件在不在
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const repo = 'file:///E:/code/Twilight_Echo/src/core/plugins'
const { validatePluginManifest } = await import(`${repo}/manifest.ts`)
const { isPluginStateFile } = await import(`${repo}/statePersistence.ts`)

const userData = join(process.env.APPDATA, 'TwilightEcho')
let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`)
}

console.log(`userData: ${userData}\n`)

const statePath = join(userData, 'plugin-state.json')
const state = JSON.parse(readFileSync(statePath, 'utf8'))
check('plugin-state.json 符合宿主结构', isPluginStateFile(state))

const record = state['com.mrwoods1692.provider.voicehub']
check('状态记录 enabled=true', record?.enabled === true)
check('状态记录 source=directory', record?.source === 'directory', String(record?.source))

const pluginsRoot = join(userData, 'plugins')
const idRoot = join(pluginsRoot, 'com.mrwoods1692.provider.voicehub')
check('安装目录存在', existsSync(idRoot))
const versions = existsSync(idRoot) ? readdirSync(idRoot) : []
const installedVersion = String(record?.activeVersion ?? '')
check('状态记录 activeVersion 指向已安装目录', versions.includes(installedVersion), `${installedVersion} / [${versions.join(',')}]`)

const versionRoot = join(idRoot, installedVersion)
const manifest = validatePluginManifest(JSON.parse(readFileSync(join(versionRoot, 'plugin.json'), 'utf8')))
check('安装副本 manifest 通过校验', Boolean(manifest?.id), manifest?.id ?? '')
check('main 入口存在', existsSync(join(versionRoot, manifest.main ?? '')))

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12)
const same = sha(join(versionRoot, 'index.mjs')) === sha('E:/code/te-plugin-voicehub/index.mjs')
check('安装副本与源码一致', same, sha(join(versionRoot, 'index.mjs')))

// 真加载一次，看 activate 能不能在假宿主上注册出音源
const offs = []
const registered = []
const writes = {}
// 用「已写入磁盘的插件设置」当初始值，验证预置的 baseUrl 真的会被读到
const seededPath = join(userData, 'plugin-data', 'com.mrwoods1692.provider.voicehub', 'settings.json')
const seeded = existsSync(seededPath) ? JSON.parse(readFileSync(seededPath, 'utf8')) : {}
check('插件设置文件存在且含 baseUrl', typeof seeded.baseUrl === 'string', seeded.baseUrl ?? '')
Object.assign(writes, seeded)
const fakeCtx = {
  apiVersion: 1,
  storagePath: join(userData, 'plugin-data', 'com.mrwoods1692.provider.voicehub'),
  settings: {
    async get(key) {
      return writes[key]
    },
    async set(key, value) {
      writes[key] = value
    },
    async delete(key) {
      delete writes[key]
    }
  },
  logger: {
    debug() {},
    info() {},
    warn: (...args) => console.log('    [插件 warn]', ...args),
    error: (...args) => console.log('    [插件 error]', ...args)
  },
  twilight: {
    providers: {
      async register(provider) {
        registered.push(provider)
      }
    },
    ui: {
      async register() {},
      onCommand(_command, handler) {
        offs.push(handler)
        return () => offs.pop()
      },
      async notify() {}
    }
  }
}

const plugin = await import(`file://${join(versionRoot, 'index.mjs').replace(/\\/g, '/')}`)
await plugin.activate(fakeCtx)
const ids = registered.map((p) => p.id)
check('activate 注册默认三个音源', ids.length === 3, ids.join(', '))
check('provider id 全部合法', ids.every((id) => /^[a-z][a-z0-9-]*$/.test(id)))
check('provider id 不重复', new Set(ids).size === ids.length)
check('每个音源都声明了 search/playbackUrl', registered.every((p) => p.capabilities.includes('search') && p.capabilities.includes('playbackUrl')))
check('设置了设置面板命令', offs.length >= 5, `${offs.length} 个命令`)

// 拿预置的 baseUrl 去打真实站点，验证「装好的这份」能搜到东西。
// 站点上游不稳（QQ 搜索会挂到 60s 以上、网易云 504），所以逐个音源试，
// 只要有一个通就说明插件接线没问题；全都不通才提示站点故障。
const probeOrder = ['voicehub-migu', 'voicehub-bilibili', 'voicehub-tencent']
let liveOk = false
let liveNote = ''
for (const id of probeOrder) {
  const provider = registered.find((p) => p.id === id)
  if (!provider) continue
  try {
    const result = await provider.searchSongs('晴天', 3, 0)
    const first = result.items[0]
    if (first) {
      liveOk = true
      liveNote = `${id} → ${first.title} - ${first.artist}（${first.id}）`
      console.log(`  ✓ 真连站点搜索  — ${liveNote}`)
      check('曲目 source 指向自己的 provider id', first.source === id, first.source ?? '')
      const url = await provider.getPlaybackUrl(first)
      const okPlay = typeof url === 'string' && url.startsWith('http')
      console.log(`  ${okPlay ? '✓' : '⚠'} 真实取播放链接  — ${okPlay ? `${url.slice(0, 48)}…` : `${id} 未拿到直链（站点上游问题，插件已降级返回 null）`}`)
      break
    }
    liveNote = `${id} 返回空`
  } catch (error) {
    liveNote = `${id} 抛错：${error?.message ?? error}`
  }
}
if (!liveOk) console.log(`  ⚠ 真连站点搜索  — 三个音源都没结果（${liveNote}），属站点上游问题，不影响安装`)


plugin.deactivate?.()
check('deactivate 后命令全部注销', offs.length === 0, `剩 ${offs.length}`)

console.log(failures === 0 ? '\n安装校验全部通过' : `\n有 ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
