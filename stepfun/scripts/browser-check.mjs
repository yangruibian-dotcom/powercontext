// 用无头 Edge 真实跑一遍浏览器端流程：加载模型（WASM 降级）→ 导入 → 检索 → 基准
import { chromium } from 'playwright-core'

const URL = process.env.URL || 'http://127.0.0.1:5199'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'],
})
const page = await browser.newPage()
if (process.env.FORCE_WASM === '1') {
  // 模拟不支持 WebGPU 的环境，验证自动降级到 WASM
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { get: () => undefined, configurable: true })
  })
}
page.on('console', (m) => console.log('[browser]', m.type(), m.text().slice(0, 200)))
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)))

await page.goto(URL, { waitUntil: 'domcontentloaded' })
console.log('page loaded')

// 等模型加载完成（状态栏出现“推理后端”）
await page.waitForFunction(
  () => {
    const el = document.getElementById('backendText')
    return el && /推理后端：(WebGPU|WASM)/.test(el.textContent) && !/加载中|回退/.test(el.textContent)
  },
  { timeout: 240000 },
)
const statusLine = await page.textContent('#status')
console.log('STATUS:', statusLine.replace(/\s+/g, ' ').trim())

// 导入
await page.click('#btnLoadCorpus')
await page.waitForTimeout(500)
await page.click('#btnImport')
await page.waitForFunction(() => /端到端/.test(document.getElementById('importLog').textContent), { timeout: 300000 })
console.log('--- importLog ---')
console.log(await page.textContent('#importLog'))

// 检索
await page.fill('#queryInput', '手冲咖啡水温多少合适')
await page.click('#btnSearch')
await page.waitForFunction(() => document.querySelectorAll('#results li').length > 0, { timeout: 120000 })
console.log('--- timing ---')
console.log(await page.textContent('#timing'))
const first = await page.textContent('#results li')
console.log('--- top1 ---')
console.log(first.replace(/\s+/g, ' ').slice(0, 200))

// 基准
await page.fill('#benchRepeats', '3')
await page.click('#btnBench')
await page.waitForFunction(() => /Recall@5/.test(document.getElementById('benchLog').textContent), { timeout: 600000 })
const bench = await page.textContent('#benchLog')
console.log('--- benchLog ---')
console.log(bench.slice(-1500))

await browser.close()
console.log('BROWSER_OK')
