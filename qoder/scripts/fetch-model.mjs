// 下载 all-MiniLM-L6-v2（q8 量化版即可）到 qoder/models，供服务端本地推理使用
import fs from 'node:fs'
import path from 'node:path'

const REPO = 'Xenova/all-MiniLM-L6-v2'
const MIRROR = process.env.HF_ENDPOINT || 'https://hf-mirror.com'
const OUT = path.resolve('models', 'all-MiniLM-L6-v2')

const FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx', 'onnx/model.onnx']

const main = async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const sizes = {}
  for (const rel of FILES) {
    const dst = path.join(OUT, rel)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    if (fs.existsSync(dst)) {
      sizes[rel] = fs.statSync(dst).size
      console.log(`skip  ${rel} (${(sizes[rel] / 1048576).toFixed(2)} MB)`)
      continue
    }
    process.stdout.write(`get   ${rel} ... `)
    let lastErr = ''
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch(`${MIRROR}/${REPO}/resolve/main/${rel}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const buf = Buffer.from(await res.arrayBuffer())
        fs.writeFileSync(dst, buf)
        sizes[rel] = buf.length
        console.log(`${(buf.length / 1048576).toFixed(2)} MB`)
        lastErr = ''
        break
      } catch (e) {
        lastErr = e.message
        await new Promise((r) => setTimeout(r, 3000 + attempt * 3000))
      }
    }
    if (lastErr) throw new Error(`${rel}: ${lastErr}`)
  }
  const fp32 = sizes['onnx/model.onnx'] || 0
  const q8 = sizes['onnx/model_quantized.onnx'] || 0
  console.log(`\nfp32 ${(fp32 / 1048576).toFixed(2)} MB / q8 ${(q8 / 1048576).toFixed(2)} MB / 压缩比 ${q8 ? (fp32 / q8).toFixed(2) : '-'}x`)
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
