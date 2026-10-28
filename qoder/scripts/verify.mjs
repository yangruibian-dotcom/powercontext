// 验证：导入示例资料 → 跑评测查询 → 统计 Recall@5 与各阶段耗时
import fs from 'node:fs'
import * as db from '../server/db.mjs'
import { embed } from '../server/embed.mjs'

const corpus = JSON.parse(fs.readFileSync('data/corpus.json', 'utf8'))
const queries = JSON.parse(fs.readFileSync('data/queries.json', 'utf8'))
const median = (a) => { const b = [...a].sort((x, y) => x - y); const m = Math.floor(b.length / 2); return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2 }

const main = async () => {
  const t0 = Date.now()
  const vectors = await embed(corpus.map((d) => `${d.title}\n${d.content}`))
  const embMs = Date.now() - t0
  console.log(`向量化 ${corpus.length} 条：${embMs} ms（${(corpus.length / (embMs / 1000)).toFixed(1)} 条/秒）`)

  await db.reset()
  const imp = await db.importDocs(corpus.map((d, i) => ({ ...d, embedding: vectors[i] })))
  console.log(`写库：${imp.write_ms} ms（total=${imp.total}）`)

  const modes = ['hybrid', 'vector', 'fulltext']
  const stat = Object.fromEntries(modes.map((m) => [m, { hit: 0, db: [], emb: [] }]))
  let total = 0

  for (const q of queries) {
    const t = Date.now()
    const [qv] = await embed([q.query])
    const qEmb = Date.now() - t
    for (const mode of modes) {
      const r = await db.search({ queryText: q.query, embedding: qv, mode, tags: q.tags || '', k: 5 })
      stat[mode].db.push(r.db_ms)
      stat[mode].emb.push(qEmb)
      const ids = r.rows.map((x) => x.doc_id)
      stat[mode].hit += q.relevant.filter((id) => ids.includes(id)).length
    }
    total += q.relevant.length
  }

  console.log('\n模式       | Recall@5 | 查询向量化(中位) | seekdb 检索(中位)')
  console.log('-----------|----------|------------------|------------------')
  for (const m of modes) {
    console.log(`${m.padEnd(10)} | ${(stat[m].hit / total).toFixed(3).padStart(8)} | ${String(median(stat[m].emb)).padStart(14)} ms | ${String(median(stat[m].db)).padStart(14)} ms`)
  }
  await db.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
