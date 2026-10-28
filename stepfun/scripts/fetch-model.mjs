// 从 hf-mirror 下载 all-MiniLM-L6-v2 的 fp32 / q8 模型文件到 web/models，
// 并打印每个文件的实际体积（用于技术说明里的体积/压缩比数据）。
import fs from 'node:fs'
import path from 'node:path'

const REPO = 'Xenova/all-MiniLM-L6-v2'
const MIRROR = process.env.HF_ENDPOINT || 'https://hf-mirror.com'
const OUT = path.resolve('web/models')

const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model.onnx',
  'onnx/model_quantized.onnx',
]

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const sizes = {}
  for (const rel of FILES) {
    const url = `${MIRROR}/${REPO}/resolve/main/${rel}`
    const dst = path.join(OUT, rel)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    if (fs.existsSync(dst)) {
      sizes[rel] = fs.statSync(dst).size
      console.log(`skip  ${rel}  ${(sizes[rel] / 1048576).toFixed(2)} MB`)
      continue
    }
    process.stdout.write(`get   ${rel} ... `)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    fs.writeFileSync(dst, buf)
    sizes[rel] = buf.length
    console.log(`${(buf.length / 1048576).toFixed(2)} MB`)
  }

  const fp32 = sizes['onnx/model.onnx'] || 0
  const q8 = sizes['onnx/model_quantized.onnx'] || 0
  const meta = {
    repo: REPO,
    mirror: MIRROR,
    files: sizes,
    fp32_bytes: fp32,
    q8_bytes: q8,
    compression_ratio: q8 ? +(fp32 / q8).toFixed(2) : null,
  }
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(meta, null, 2))
  console.log('\n--- 体积对比 ---')
  console.log(`fp32 model.onnx           ${(fp32 / 1048576).toFixed(2)} MB`)
  console.log(`q8   model_quantized.onnx ${(q8 / 1048576).toFixed(2)} MB`)
  console.log(`压缩比 = ${meta.compression_ratio}x`)
}

main().catch((e) => {
  console.error('FAILED:', e.message)
  process.exit(1)
})
