// 下载 all-MiniLM-L6-v2（q8 量化版）到 models/，供服务端本地推理使用
import fs from 'node:fs'
import path from 'node:path'

const REPO = 'Xenova/all-MiniLM-L6-v2'
const MIRROR = (process.env.HF_ENDPOINT || 'https://hf-mirror.com').replace(/\/$/, '')
const OUT = path.resolve('models', 'all-MiniLM-L6-v2')

const REQUIRED = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']
const OPTIONAL = ['special_tokens_map.json']

async function download(rel, { optional = false } = {}) {
  const dst = path.join(OUT, rel)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  if (fs.existsSync(dst) && fs.statSync(dst).size > 0) {
    console.log(`skip  ${rel} (${(fs.statSync(dst).size / 1048576).toFixed(2)} MB)`)
    return true
  }
  const url = `${MIRROR}/${REPO}/resolve/main/${rel}`
  let lastErr = ''
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      process.stdout.write(`get   ${rel} ... `)
      const res = await fetch(url)
      if (res.status === 404 && optional) {
        console.log('not found (optional)')
        return false
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const len = Number(res.headers.get('content-length') || 0)
      const buf = Buffer.from(await res.arrayBuffer())
      if (!buf.length) throw new Error('empty response')
      if (len && buf.length !== len) throw new Error(`truncated ${buf.length}/${len}`)
      fs.writeFileSync(dst, buf)
      console.log(`${(buf.length / 1048576).toFixed(2)} MB`)
      return true
    } catch (e) {
      lastErr = e.message
      console.log(`失败（第 ${attempt} 次）：${e.message}`)
      if (attempt < 5) await new Promise((r) => setTimeout(r, 2000 * attempt))
    }
  }
  throw new Error(`${rel}: ${lastErr}`)
}

async function main() {
  console.log(`从 ${MIRROR} 下载 ${REPO} → ${path.relative(process.cwd(), OUT) || '.'}`)
  for (const rel of REQUIRED) await download(rel)
  for (const rel of OPTIONAL) await download(rel, { optional: true })
  const q8 = fs.statSync(path.join(OUT, 'onnx/model_quantized.onnx')).size
  console.log(`\n完成：q8 模型 ${(q8 / 1048576).toFixed(2)} MB`)
  console.log('如需清理重新下载，删除 models/all-MiniLM-L6-v2 后重跑本脚本。')
}

main().catch((e) => {
  console.error('\n下载失败：', e.message)
  console.error('可尝试设置镜像：HF_ENDPOINT=https://hf-mirror.com node scripts/fetch-model.mjs')
  process.exit(1)
})
