// 通过 Chrome DevTools Protocol 操作正在运行的 Twilight Echo 渲染进程。
// 用法：
//   node dev/ui.mjs text                 打印页面文字大纲（可点元素 + 按钮）
//   node dev/ui.mjs eval "<js>"          在页面里求值并打印结果
//   node dev/ui.mjs click "<css>"        点击选择器命中的第一个元素
//   node dev/ui.mjs clicktext "<文本>"   点击文字等于/包含该文本的元素
//   node dev/ui.mjs shot <路径.png>      截图
const [, , cmd, arg] = process.argv

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const pages = list.filter((t) => t.type === 'page')
// 主窗口没有 window= 查询参数；桌面歌词等辅助窗口有。默认取主窗口，可用 UI_TARGET=lyrics 指定。
const want = (process.env.UI_TARGET || 'main').toLowerCase()
const page =
  want === 'main'
    ? (pages.find((t) => !/[?&]window=/.test(t.url)) ?? pages[0])
    : (pages.find((t) => new RegExp(`[?&]window=${want}`).test(t.url)) ?? pages[0])
if (!page) throw new Error('没有找到页面，应用是不是没带 --remote-debugging-port=9222 启动？')

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
})

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

function send(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? '页面脚本报错')
  return result.result.value
}

const helpers = `
  window.__big = (el) => {
    const r = el.getBoundingClientRect()
    return r.width > 20 && r.height > 12 && r.top < innerHeight && r.bottom > 0
  }
  window.__label = (el) => (
    (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').replace(/\\s+/g, ' ').trim()
  )
`

if (cmd === 'text') {
  await evaluate(helpers)
  const outline = await evaluate(`(() => {
    const items = [...document.querySelectorAll('button, [role=button], a, input, [class*=step], [class*=dot]')]
      .filter(__big)
      .map((el) => {
        const tag = el.tagName.toLowerCase()
        const cls = (el.className && String(el.className).slice(0, 60)) || ''
        return tag + (cls ? '.' + cls.split(/\\s+/).slice(0, 2).join('.') : '') + ' :: ' + __label(el).slice(0, 60)
      })
    const headings = [...document.querySelectorAll('h1,h2,h3')].map((h) => 'H: ' + h.textContent.trim()).filter(Boolean)
    return headings.concat(items).join('\\n')
  })()`)
  console.log(outline || '(没有可点元素)')
} else if (cmd === 'eval') {
  console.log(JSON.stringify(await evaluate(arg), null, 2))
} else if (cmd === 'click') {
  const ok = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(arg)})
    if (!el) return 'notfound'
    el.scrollIntoView({ block: 'center' })
    el.click()
    return 'clicked: ' + (el.textContent || '').trim().slice(0, 40)
  })()`)
  console.log(ok)
} else if (cmd === 'clicktext') {
  await evaluate(helpers)
  const ok = await evaluate(`(() => {
    const want = ${JSON.stringify(arg)}
    const els = [...document.querySelectorAll('button, [role=button], a, div, span')]
      .filter((el) => __label(el) === want && __big(el))
    const el = els[els.length - 1]
    if (!el) return 'notfound'
    el.scrollIntoView({ block: 'center' })
    el.click()
    return 'clicked: ' + __label(el)
  })()`)
  console.log(ok)
} else if (cmd === 'clickaria') {
  const ok = await evaluate(`(() => {
    const want = ${JSON.stringify(arg)}
    const el = document.querySelector('[aria-label="' + want.replace(/"/g, '\\\\"') + '"]')
    if (!el) return 'notfound'
    el.click()
    return 'clicked: ' + want
  })()`)
  console.log(ok)
} else if (cmd === 'tap') {
  const rect = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(arg)})
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  if (!rect) {
    console.log('notfound')
  } else {
    const base = { x: rect.x, y: rect.y, button: 'left', clickCount: 1, buttons: 1 }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 })
    console.log(`tapped (${Math.round(rect.x)},${Math.round(rect.y)})`)
  }
} else if (cmd === 'typetext') {
  await send('Input.insertText', { text: arg })
  console.log('typed: ' + arg)
} else if (cmd === 'key') {
  const map = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8 }
  const code = map[arg] ?? 0
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: arg, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: arg, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
  console.log('key: ' + arg)
} else if (cmd === 'shot') {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(arg, Buffer.from(data, 'base64'))
  console.log('saved ' + arg)
} else {
  console.log('用法: text | eval <js> | click <css> | clicktext <文本> | shot <png>')
}

ws.close()
