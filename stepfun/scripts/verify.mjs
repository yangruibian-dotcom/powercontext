// 本地验证：用同一份模型（fp32 / q8）在 Node 侧算向量，写进 seekdb，
// 比较检索质量（Recall@5）与 seekdb 检索延迟。浏览器侧的数字请用页面上的「跑基准」按钮生成。
import fs from 'node:fs'
import path from 'node:path'
import { pipeline, env } from '@huggingface/transformers'
import * as db from '../server/db.mjs'

env.allowRemoteModels = false
env.allowLocalModels = true
env.localModelPath = path.resolve('web/models')

const corpus = JSON.parse(fs.readFileSync('data/corpus.json', 'utf8'))
const queries = JSON.parse(fs.readFileSync('data/queries.json', 'utf8'))
const manifest = JSON.parse(fs.readFileSync('web/models/manifest.json', 'utf8'))

const median = (a) => {
  const b = [...a].sort((x, y) => x - y)
  const m = Math.floor(b.length / 2)
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2
}

async function embedAll(extractor, texts, batch = 8) {
  const out = []
  for (let i = 0; i < texts.length; i += batch) {
    const res = await extractor(texts.slice(i, i + batch), { pooling: 'mean', normalize: true })
    for (let j = 0; j < Math.min(batch, texts.length - i); j++) out.push(Array.from(res[j].data))
  }
  return out
}

function recallAt(results, relevant) {
  const ids = results.map((r) => r.doc_id)
  return relevant.filter((id) => ids.includes(id)).length / relevant.length
}

async function bench(dtype) {
  console.log(`\n===== ${dtype} =====`)
  const t0 = Date.now()
  const extractor = await pipeline('feature-extraction', 'all-MiniLM-L6-v2', { device: 'cpu', dtype })
  const loadMs = Date.now() - t0

  const embT0 = Date.now()
  const docVecs = await embedAll(extractor, corpus.map((d) => `${d.title}\n${d.content}`))
  const docEmbMs = Date.now() - embT0

  await db.reset()
  const imp = await db.importDocs(corpus.map((d, i) => ({ ...d, embedding: docVecs[i] })))
  console.error(`write ${imp.inserted} docs in ${imp.write_ms}ms`)

  const rows = []
  const dbTimes = { hybrid: [], vector: [], fulltext: [] }
  let hits = { hybrid: 0, vector: 0, fulltext: 0 }
  let total = 0

  for (const q of queries) {
    const qT0 = Date.now()
    const [qv] = await embedAll(extractor, [q.query], 1)
    const qEmbMs = Date.now() - qT0
    for (const mode of ['hybrid', 'vector', 'fulltext']) {
      const r = await db.search({ queryText: q.query, embedding: qv, mode, k: 5 })
      dbTimes[mode].push(r.db_ms)
      hits[mode] += recallAt(r.rows, q.relevant)
    }
    total += q.relevant.length
    rows.push({ query: q.query, q_emb_ms: qEmbMs })
  }

  return {
    dtype,
    model_bytes: dtype === 'q8' ? manifest.q8_bytes : manifest.fp32_bytes,
    load_ms: loadMs,
    doc_emb_ms: docEmbMs,
    docs_per_sec: +(corpus.length / (docEmbMs / 1000)).toFixed(1),
    write_ms: imp.write_ms,
    query_emb_ms_median: +median(rows.map((r) => r.q_emb_ms)).toFixed(1),
    db_ms: Object.fromEntries(Object.entries(dbTimes).map(([k, v]) => [k, +median(v).toFixed(1)])),
    recall_at_5: Object.fromEntries(Object.entries(hits).map(([k, v]) => [k, +(v / total).toFixed(3)])),
  }
}

const results = []
for (const dtype of ['fp32', 'q8']) results.push(await bench(dtype))
await db.close()

console.log('\n\n## 结果\n')
console.log('| 模型 | 体积(MB) | 加载(ms) | 24 篇向量化(ms) | 篇/秒 | 查询向量化(ms) | seekdb hybrid(ms) | Recall@5(hybrid) | Recall@5(vector) | Recall@5(fulltext) |')
console.log('|---|---|---|---|---|---|---|---|---|---|')
for (const r of results) {
  console.log(`| ${r.dtype} | ${(r.model_bytes / 1048576).toFixed(2)} | ${r.load_ms} | ${r.doc_emb_ms} | ${r.docs_per_sec} | ${r.query_emb_ms_median} | ${r.db_ms.hybrid} | ${r.recall_at_5.hybrid} | ${r.recall_at_5.vector} | ${r.recall_at_5.fulltext} |`)
}
fs.writeFileSync('.verify.json', JSON.stringify({ manifest, results }, null, 2))
console.log('\n写入 .verify.json')
