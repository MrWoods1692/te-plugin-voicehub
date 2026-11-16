# VoiceHub 音源插件（Twilight Echo）

把自建 [VoiceHub](https://github.com/laoshuikaixue/VoiceHub) 点歌台的音源接进 Twilight Echo：装完在「音源」里多出 **哔哩哔哩 / 咪咕音乐 / QQ 音乐**（网易云可选），能像内置音源一样搜索、播放、看歌词；某个音源取不到播放链接时，自动去别的音源找同一首歌放。

- 插件 id：`com.mrwoods1692.provider.voicehub`
- 类型：`provider` + `ui`（provider 提供音源，ui 提供设置面板）
- 权限：`network`、`settings`、`ui:inject`
- 宿主要求：Twilight Echo `>= 2.0.0`
- 许可：MIT（图标取自 VoiceHub 项目）

## 目录

```
te-plugin-voicehub/
├── plugin.json      # manifest
├── index.mjs        # 插件本体（四个 provider + 设置面板 + 降级 / 跨音源兜底）
├── icon.png         # 插件图标（256×256，取自 VoiceHub）
├── smoke.mjs        # 联调脚本：探你的 VoiceHub 站点到底开放了哪些音源
├── dev/selftest.mjs # 离线自测：本地 mock VoiceHub + 假宿主，36 个用例
├── dev/verify-install.mjs # 装完后校验：用宿主真实代码检查安装目录、状态文件、真连站点
├── dist/*.tep       # 打包产物，给「从本地安装包」用
├── LICENSE
└── README.md
```

## 一、四路音源与实测状态

插件把 VoiceHub 的接口按平台拆成四个 provider，**互不影响**：某一个平台在站点侧挂了，只影响它自己，其余照常搜、照常放。

| 音源 | provider id | 搜索 | 播放链接 | 歌词 | 默认注册 |
| --- | --- | --- | --- | --- | --- |
| 哔哩哔哩 | `voicehub-bilibili` | `/api/bilibili/search` | `/api/bilibili/playurl` | 无接口 | ✅ |
| 咪咕音乐 | `voicehub-migu` | `/api/native-api/search/mg` | `/api/native-api/migu/playurl` | `/api/native-api/lyric/mg` | ✅ |
| QQ 音乐 | `voicehub-tencent` | `/api/native-api/search/tx` | `POST /api/music/resolve-url` | `/api/native-api/lyric/tx` | ✅ |
| 网易云 | `voicehub-netease` | `/api/api-enhanced/netease/cloudsearch` | `/api/api-enhanced/netease/song/url/v1` | `/api/api-enhanced/netease/lyric` | ⚙️ 默认关闭 |

网易云默认不注册，因为 VoiceHub 的网易云能力全靠 `**/api/api-enhanced/netease/**` 代理上游 NeteaseCloudMusicApiEnhanced，站点一旦连不上上游就整条链路废掉（表现为 502 / 504 `NETEASE_UPSTREAM_TIMEOUT`）。如果你自己的站点网易云是通的，在设置面板里打开「注册网易云音源」，重启应用即可。

### 在 `https://music.idoknow.top` 上实测（2026-11-16）

```
✓ QQ 搜索   3 条，首条：晴天 - 周杰伦
✗ QQ 播放   HTTP 502：Server Error          ← 依赖上游聚合源，此刻上游挂了
✓ QQ 歌词   1388 字符
✓ 咪咕搜索  20 条，首条：晴天 - 周杰伦
✓ 咪咕播放  音质 HQ
✓ 咪咕歌词  1492 字符
✓ 哔哩哔哩搜索  15 条，首条：《晴天》- 周杰伦   ← 头一次 15s 超时，放宽到 30s 后第二次就通了
✓ 哔哩哔哩播放  拿到 bilivideo.com 直链（.mp4）
✗ 网易云搜索   HTTP 504：NETEASE_UPSTREAM_TIMEOUT
```

**结论：这台站点上「哔哩哔哩 / 咪咕」搜索播放全通，QQ 只能搜到、暂时放不出来（上游聚合源 502），网易云不可用。** 你自己部署的 VoiceHub 状态会不一样，先跑一次 `smoke.mjs` 看结果。

关于你给的那个 key（`vhub_...`）：**音乐接口用不到它**。native-api 与 `/api/bilibili/*` 全是匿名开放；`/api/platform-config` 无论带不带 `X-API-Key` 都返回 401（那是要登录态的接口）。VoiceHub 的 API Key 是给 `/api/open/*` 校务接口用的，权限枚举只有 `schedules / songs / card-codes / backup`，没有音乐解析权限。所以插件里的「API Key」设置只在你给站点加了自建网关鉴权（认 `X-API-Key`）时才需要填，默认留空。

## 二、先探站点，再装插件

```bash
node smoke.mjs https://music.idoknow.top
node smoke.mjs http://127.0.0.1:3000 晴天
node smoke.mjs https://vh.example.com 晴天 你的key
```

脚本按「QQ 搜索→播放→歌词 / 咪咕 搜索→播放→歌词 / 哔哩哔哩 搜索→播放 / 网易云 搜索」逐项打，最后打印可用音源汇总。它只发读请求，不改站点数据。

## 三、安装到 Twilight Echo

开发期用文件夹安装，改完重启应用即可，不用每次打包：

1. 打开 Twilight Echo → 设置 → 扩展中心
2. 开启「开发者模式」
3. 选「从文件夹安装（开发）」，指向 `E:\code\te-plugin-voicehub`（含 `plugin.json` 的那一层）
4. 应用重启后「音源」里出现 **VoiceHub · 哔哩哔哩**、**VoiceHub · 咪咕音乐**、**VoiceHub · QQ 音乐**

正式分发时把 `plugin.json`、`index.mjs`、`icon.png`、`README.md` 放到 zip 根目录打包成 `.tep` 即可，不要把 `dev/`、`smoke.mjs` 塞进去。仓库里 `dist/com.mrwoods1692.provider.voicehub-0.3.0.tep` 就是这么打出来的（根目录四个文件）。

### 手动装到 userData（应用没开也能装）

宿主扫描的是 Electron userData 目录，按 `plugins/<id>/<version>/` 放好文件、再在 `plugin-state.json` 里登记一条就行：

```
%APPDATA%\TwilightEcho\
├── plugins\com.mrwoods1692.provider.voicehub\0.3.0\{plugin.json, index.mjs, icon.png, README.md}
├── plugin-data\com.mrwoods1692.provider.voicehub\settings.json   # baseUrl / quality / enableNetease / autoFallback
└── plugin-state.json   # { "<id>": { enabled: true, installedAt, updatedAt, source: "directory", activeVersion: "0.3.0" } }
```

`source` 只能是 `directory` / `tep` / `bundled` / `index`，时间戳必须是可解析的 ISO 字符串，否则宿主会把状态文件判为损坏。装完跑一次：

```bash
node dev/verify-install.mjs
```

它会用宿主自己的 `validatePluginManifest`、`isPluginStateFile` 校验安装副本，再真加载一次插件、读盘里的设置、连站点搜一次「晴天」，最后检查 `deactivate` 有没有把命令注销干净。

## 四、配置

设置 → 插件 → **VoiceHub 音源**（面板会自动加载一次，把各音源的健康状态写在顶部提示里）：

> ⚠️ **Twilight Echo 2.0.2 正式版里看不到这个面板**：该版本的渲染进程调用 `extensions:list` 时主进程没注册这个 handler（`No handler registered for 'extensions:list'`），所以所有插件 UI 扩展点（设置面板、侧栏页、播放栏按钮）都不会显示。这是宿主版本的问题，不是插件没装好——音源本身仍然工作。2.0.2 上改配置请直接编辑 `%APPDATA%\TwilightEcho\plugin-data\com.mrwoods1692.provider.voicehub\settings.json`：

```json
{
  "baseUrl": "https://music.idoknow.top",
  "quality": "320k",
  "enableNetease": "false",
  "autoFallback": "true"
}
```

改完重启应用即可（插件启动时读取，播放链接缓存 120 秒内不刷新）。

| 设置项 | 说明 |
| --- | --- |
| `baseUrl` | 默认 `http://127.0.0.1:3000`；末尾斜杠自动去掉，没写协议补 `http://`，非 http(s) 会被拒绝 |
| `apiKey` | 站点额外加了 `X-API-Key` 鉴权才需要；VoiceHub 原生音乐接口不需要，留空 |
| `quality` | `128k` / `192k` / `320k` / `flac` / `flac24bit` / `master`，调用方没指定时用它 |
| `enableNetease` | `"true"` 才注册网易云音源，默认 `"false"`。改了要重启应用才重新注册 |
| `autoFallback` | `"false"` 关掉跨音源兜底（默认 `"true"`）。开着时某个音源取链失败会去别的音源找同一首歌 |

在支持插件 UI 的宿主版本上，面板里还有「测试连接」「检测音源」两个按钮（命令 `voicehub.settings.test` / `voicehub.settings.probe`），保存后立即生效（播放缓存会清空），不用重启插件。

> 这台机器上预置的就是 `https://music.idoknow.top`（那台测试站点），自己起 VoiceHub 之后记得改回 `http://127.0.0.1:3000`。


## 五、接口细节与音质映射

| 能力 | 请求 | 返回 |
| --- | --- | --- |
| QQ 搜索 | `GET /api/native-api/search/tx?str=&page=&limit=` | `{ list[], total }`，默认 50/页 |
| 咪咕搜索 | `GET /api/native-api/search/mg?str=&page=&limit=` | `{ list[], total }`，默认 30/页 |
| 哔哩哔哩搜索 | `GET /api/bilibili/search?keyword=` | **裸数组**，无分页参数，插件本地切片 |
| QQ 播放 | `POST /api/music/resolve-url` `{ platform:'tencent', musicId, name, quality }` | `{ success, url, source }`；只支持 tencent |
| 咪咕播放 | `GET /api/native-api/migu/playurl?contentId=&toneFlag=` | `{ success, url, quality }` |
| 哔哩哔哩播放 | `GET /api/bilibili/playurl?id=&cid=` | `{ url, pay }` |
| QQ 歌词 | `GET /api/native-api/lyric/tx?songmid=&name=&artist=&album=&duration=` | `{ data:{ lrc, qrc, trans } }` |
| 咪咕歌词 | `GET /api/native-api/lyric/mg?contentId=` | `{ data:{ lrc, trans } }` |
| 网易云 | 全部走 `GET\|POST /api/api-enhanced/netease/<endpoint>` | 上游 NeteaseCloudMusicApi 的原始返回 |

音质映射：

- QQ（数字 `'4'/'8'/'10'`）：`128k→4`、`192k→4`、`320k→8`、`flac→10`、`flac24bit→10`、`master→10`
- 咪咕（toneFlag）：`128k→PQ`、`320k→HQ`、`flac→SQ`、`flac24bit→ZQ24`
- 网易云（level）：`128k→standard`、`192k→higher`、`320k→exhigh`、`flac→lossless`、`flac24bit→hires`、`master→jymaster`

哔哩哔哩的曲目 ID 会把 cid 编进去：`voicehub-bilibili:BV1xxxx:31268997329`，播放时拆出 `id` 与 `cid` 一起发给站点。其余音源形如 `voicehub-migu:600123456`、`voicehub-tencent:0039MnYb0qxYhV`。

**曲目前缀必须等于 provider id**：宿主靠 `track.source` 决定走哪个音源，靠 ID 前缀反推远端曲目 ID（`getProviderLocalId`），两者不一致就会「找到了但放不出来」。另外 provider id 只允许 `^[a-z][a-z0-9-]*$`——**不能带点号**，写成 `voicehub.netease` 会被宿主直接拒绝注册。

## 六、降级行为（接口不全开放时）

这是插件最要紧的部分，避免某个平台挂了以后整个音源列表变成一块死按钮：

- **单个平台的搜索失败 → 返回空结果**（`{ items: [], total: 0 }`），不抛错、不阻塞其它平台。
- **播放链接失败 → 先换源，再返回 null**：拿不到直链时，插件会用「歌名 + 主艺人」去别的音源搜一遍，标题与艺人对得上就换成那家的直链播（日志里会写「QQ 音乐 取链失败，已切到 咪咕音乐 播放《晴天》」）。都失败才返回 null，宿主给出通用的「无法播放」提示；同时 20 秒内不再重复打同一个曲目（负缓存），免得连点几次把站点打进限流。
- **歌词也换源**：自己这条音源没歌词（比如哔哩哔哩压根没接口）或歌词接口报错，会去别的音源找同一首歌的歌词，找到就用。
- **跨音源兜底可以关**：设置项 `autoFallback`（或面板里的「跨音源兜底」开关）。想只听指定平台、不要串台时关掉即可。
- **失败会弹一次警告**（`ui.notify`），同一个平台 5 分钟内只弹一次，不会刷屏；歌词失败只写 info 日志，不打扰。
- **健康状态记在内存里**，设置面板顶部的提示与「检测音源」按钮展示的就是它；重启插件会重新探测。
- 播放链接**正缓存 120 秒**（VoiceHub 返回的是短时效直链），并发取同一首歌会合并成一次请求；搜索**正缓存 90 秒**，同样的关键词反复输入不会重复打站点。

## 七、已知限制

- **QQ 播放链接不稳定**：`/api/music/resolve-url` 依赖上游聚合源（`yuafeng-tx`、`HelloWorld` 之类），同一首歌有时 200 有时 502，且必须带 `name`（歌名）才更容易成功——插件已经带上搜索返回的歌名了。实测这台站点 2026-11-16 一直是 502，属于上游问题，换咪咕或哔哩哔哩即可。
- **QQ 搜索会假死**：同一个 `/api/native-api/search/tx`，成功时 0.6~4 秒就回，坏的时候能挂 60 秒以上（上游聚合源卡住）。插件给 QQ 单独设了 **15 秒**超时，快速失败并弹提示，不让用户干等；咪咕 / 哔哩哔哩用 25 秒。
- **超时上限是 25 秒，不是随便定的**：宿主给 `searchSongs` / `getPlaybackUrl` / `getLyrics` 的超时是 30 秒（`Twilight_Echo/src/core/plugins/providerRouting.ts` 的 `PLUGIN_PROVIDER_MEDIUM_TIMEOUT_MS`），插件必须比它早返回，否则会变成宿主侧的「音源无响应」。
- **哔哩哔哩搜索慢**：站点是实时代查 B 站，实测 13~15 秒才回。插件把这条路由的超时放宽到 25 秒，仍可能超时，重试通常就好。
- **这台测试站点本身很不稳**：2026-11-16 16:30 前后连续实测，同一条咪咕搜索有时 14.6 秒返回、有时 25 秒超时；QQ 搜索连挂两次 60 秒后第三次 4.1 秒才通。搜索空了先重试一次再判断插件问题。
- **哔哩哔哩没有歌词接口**：VoiceHub 只提供 QQ / 咪咕歌词，所以 B 站曲目歌词为空（不报错）。
- **网易云整条链路取决于站点上游**，本实例 502/504；默认关闭，需要时手动打开。
- **匿名限流**：`resolve-url` 与 `migu/playurl` 开头都有 `enforceAnonymousMusicResolveRateLimit`，短时间大量取链接会被限。插件有缓存和负缓存，正常听歌不会触发。
- 没有实现歌单、收藏、登录（`capabilities` 只有 `search`、`playbackUrl`、`lyrics`）。哔哩哔哩搜索接口本身不带分页，所以「加载更多」对它是本地切片，翻完就到底。

## 八、排查

- 插件日志：`<Electron userData>/logs/plugins/com.mrwoods1692.provider.voicehub.log`
- 音源列表里没有某个平台：它默认没注册（网易云），或注册时被宿主拒了（看日志里 `Provider id 必须是小写前缀`）
- 搜索空：先 `node smoke.mjs <baseUrl>`，多数是站点侧音源没配
- 能搜不能放：看日志 `取播放链接失败` 后面的 HTTP 状态；QQ 502 是上游问题，不是插件问题
- 面板保存不了：地址必须是 http(s)，看提示里的原话

## 九、离线自测

```bash
node dev/selftest.mjs
```

本地起 mock VoiceHub（22 条路由，含失败注入）+ 假宿主 context，加载 `index.mjs` 跑 36 个用例：注册 id 合法性、脏数据过滤、空关键词不发请求、`offset→page` 换算、音质映射、缓存命中零请求、负缓存、502 降级、QQ 取链失败自动切咪咕、关掉兜底后不换源、歌词换源兜底、网易云开关、notify 冷却、设置面板 DTO 逐字段校验、保存与密钥头、非法地址不落盘、探测汇总、重置、`deactivate` 注销命令。改插件后先跑这个，比装进应用里试快得多。

## License

MIT
