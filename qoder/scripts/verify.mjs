// 质量与延迟对比：导入示例语料 → 10 条评测查询 → Recall@5 / 中位延迟
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(ROOT)

const db = await import('../server/db.mjs')
const { embed, loadModel, MODEL_ID } = await import('../server/embed.mjs')

const corpus = JSON.parse(fs.readFileSync('data/corpus.json', 'utf8'))
const queries = JSON.parse(fs.readFileSync('data/queries.json', 'utf8'))
const modes = ['hybrid', 'vector', 'fulltext']
const K = 5

const median = (a) => {
  const b = [...a].sort((x, y) => x - y)
  const m = Math.floor(b.length / 2)
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2
}
const pct = (x) => `${(x * 100).toFixed(1)}%`

async function main() {
  console.log(`模型：${MODEL_ID}（本地 ${path.join('models', MODEL_ID)}）`)
  console.log(`语料：${corpus.length} 条 · 评测查询：${queries.length} 条 · Recall@${K}\n`)

  const tLoad = Date.now()
  await loadModel()
  await embed(['warmup 预热查询'])
  console.log(`模型加载 + 预热：${Date.now() - tLoad} ms`)

  await db.reset()

  const tEmb = Date.now()
  const vectors = await embed(corpus.map((d) => `${d.title}\n${d.content}`))
  const embMs = Date.now() - tEmb
  console.log(`向量化 ${corpus.length} 条：${embMs} ms（${(corpus.length / (embMs / 1000)).toFixed(1)} 条/秒）`)

  const imp = await db.importDocs(corpus.map((d, i) => ({ ...d, embedding: vectors[i] })))
  console.log(`写库：${imp.write_ms} ms（库内共 ${imp.total} 条）\n`)

  const stat = Object.fromEntries(modes.map((m) => [m, { hit: 0, db: [], emb: [], top1: 0, bad: 0 }]))
  let relevantTotal = 0

  for (const q of queries) {
    const t = Date.now()
    const [qv] = await embed([q.query])
    const embMsQ = Date.now() - t
    for (const mode of modes) {
      const r = await db.search({ queryText: q.query, embedding: qv, mode, tags: q.tags || '', k: K })
      const ids = r.rows.map((x) => x.doc_id)
      const hits = q.relevant.filter((id) => ids.includes(id)).length
      stat[mode].hit += hits
      stat[mode].top1 += ids.length && q.relevant.includes(ids[0]) ? 1 : 0
      if (!hits) stat[mode].bad++
      stat[mode].db.push(r.db_ms)
      stat[mode].emb.push(embMsQ)
    }
    relevantTotal += q.relevant.length
  }

  console.log('模式       | Recall@5 | Top-1  | 零命中 | 查询向量化(中位) | seekdb 检索(中位)')
  console.log('-----------|----------|--------|--------|------------------|------------------')
  for (const m of modes) {
    const s = stat[m]
    console.log(
      `${m.padEnd(10)} | ${pct(s.hit / relevantTotal).padStart(8)} | ` +
      `${pct(s.top1 / queries.length).padStart(6)} | ${String(s.bad).padStart(6)} | ` +
      `${String(median(s.emb)).padStart(14)} ms | ${String(median(s.db)).padStart(14)} ms`,
    )
  }

  const demo = queries[0]
  const [dv] = await embed([demo.query])
  for (const mode of modes) {
    const r = await db.search({ queryText: demo.query, embedding: dv, mode, k: 3 })
    console.log(`\n[${mode}] ${demo.query}`)
    for (const row of r.rows) {
      console.log(
        `  ${row.doc_id} ${row.title} | ${row.source} | ` +
        `全文=${row.ft_rank ?? '-'} 向量=${row.vec_rank ?? '-'} score=${row.score.toFixed(4)}`,
      )
    }
  }

  await db.close()
}

main().catch(async (e) => {
  console.error(e)
  await db.close().catch(() => {})
  process.exit(1)
})
