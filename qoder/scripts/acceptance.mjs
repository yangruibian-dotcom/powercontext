// 验收脚本：对运行中的应用做三项检查
const BASE = 'http://127.0.0.1:5273'

const post = async (path, body) => {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return r.json()
}

const line = (rows) =>
  rows.map((r) => `${r.doc_id}《${r.title}》src=${r.source ? '有' : '无'} ft=${r.ft_rank ?? '-'}/vec=${r.vec_rank ?? '-'}`).join('\n     ')

const main = async () => {
  const h = await (await fetch(BASE + '/api/health')).json()
  console.log(`[0] health: ${h.docs} 条 / ${h.dim} 维 / ${h.dir}`)

  console.log('\n[1] 中文全文能否命中（期望第 1 条 = p03《中文全文检索的分词问题》）')
  const q1 = await post('/api/search', { queryText: '中文全文检索为什么搜不到', mode: 'hybrid', k: 3 })
  console.log(`    耗时 embed=${q1.embed_ms}ms db=${q1.db_ms}ms`)
  console.log('    ' + line(q1.rows))
  console.log(q1.rows[0]?.doc_id === 'p03' ? '    ✅ PASS' : '    ❌ FAIL')

  console.log('\n[2] 仅全文模式（期望第 1 条 = p03，且有全文排名）')
  const q2 = await post('/api/search', { queryText: '中文全文检索', mode: 'fulltext', k: 3 })
  console.log('    ' + line(q2.rows))
  console.log(q2.rows[0]?.doc_id === 'p03' ? '    ✅ PASS' : '    ❌ FAIL')

  console.log('\n[3] 标签过滤（同一查询，带 tags=检索 的结果应更少）')
  const noTag = await post('/api/search', { queryText: '检索', mode: 'fulltext', k: 10 })
  const withTag = await post('/api/search', { queryText: '检索', mode: 'fulltext', k: 10, tags: '检索' })
  console.log(`    不带标签: ${noTag.rows.length} 条 -> ${noTag.rows.map((r) => r.doc_id).join(',')}`)
  console.log(`    带标签  : ${withTag.rows.length} 条 -> ${withTag.rows.map((r) => r.doc_id).join(',')}`)
  const tagOK = withTag.rows.length > 0 && withTag.rows.length < noTag.rows.length
  console.log(tagOK ? '    ✅ PASS' : '    ❌ FAIL')

  console.log('\n[4] 出处字段（每条都应有 source）')
  const missing = q1.rows.filter((r) => !r.source).length
  console.log(`    缺 source 的条数: ${missing}`)
  console.log(missing === 0 ? '    ✅ PASS' : '    ❌ FAIL')

  console.log('\n[5] 仅向量模式（对照：预期召回弱于 hybrid）')
  const v = await post('/api/search', { queryText: '中文全文检索为什么搜不到', mode: 'vector', k: 3 })
  console.log('    ' + line(v.rows))
}

main().catch((e) => { console.error('测试失败:', e.message); process.exit(1) })
