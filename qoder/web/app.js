// 前端：只负责收集文本、调接口、渲染结果；向量化在服务端本地完成
const $ = (id) => document.getElementById(id)
let corpus = []

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
  const j = await res.json()
  if (!j.ok) throw new Error(j.error || 'api error')
  return j
}

const log = (el, s) => { el.textContent += s + '\n'; el.scrollTop = el.scrollHeight }
const t = (ms) => `${Math.round(ms)} ms`

async function health() {
  try {
    const h = await api('/api/health')
    $('dbText').textContent = `seekdb：${h.docs} 条资料 · ${h.dim} 维`
    $('dot').classList.add('ok')
    $('btnImport').disabled = false
    $('btnSearch').disabled = false
  } catch (e) {
    $('dbText').textContent = 'seekdb：未连接'
  }
}

async function collectDocs() {
  if (!corpus.length) corpus = await (await fetch('/api/corpus')).json()
  const paste = $('paste').value.trim()
  const custom = paste
    ? paste.split(/\n\s*\n/).map((block, i) => {
        const lines = block.trim().split('\n')
        const title = lines.length > 1 ? lines[0].slice(0, 80) : `粘贴资料 ${i + 1}`
        const content = lines.length > 1 ? lines.slice(1).join('\n') : lines[0]
        return { doc_id: `paste-${Date.now()}-${i}`, title, content, tags: '粘贴', source: '手动粘贴' }
      })
    : []
  return [...corpus, ...custom]
}

$('btnCorpus').onclick = async () => {
  const docs = await collectDocs()
  log($('importLog'), `已准备 ${docs.length} 条资料（示例 ${corpus.length} 条 + 粘贴 ${docs.length - corpus.length} 条）`)
}

$('btnImport').onclick = async () => {
  $('btnImport').disabled = true
  try {
    const docs = await collectDocs()
    log($('importLog'), `开始向量化并写入 seekdb（${docs.length} 条）…`)
    const r = await api('/api/import-text', { docs })
    log($('importLog'), `向量化 ${t(r.embed_ms)} · 写库 ${t(r.write_ms)} · 共 ${r.total} 条`)
    await health()
  } catch (e) {
    log($('importLog'), '导入失败：' + e.message)
  } finally {
    $('btnImport').disabled = false
  }
}

$('btnReset').onclick = async () => {
  await api('/api/reset', {})
  log($('importLog'), '已清空')
  await health()
}

$('btnSearch').onclick = async () => {
  const queryText = $('q').value.trim()
  if (!queryText) return
  $('btnSearch').disabled = true
  try {
    const r = await api('/api/search', {
      queryText,
      tags: $('tag').value.trim(),
      mode: $('mode').value,
      k: 5,
    })
    $('timing').textContent = `向量化 ${t(r.embed_ms)} · seekdb 检索 ${t(r.db_ms)} · 模式 ${r.mode}` +
      (r.tags ? ` · 标签过滤「${r.tags}」` : '')
    $('results').innerHTML = r.rows.map((row, i) => `
      <li>
        <div class="title">${i + 1}. ${esc(row.title)}
          ${(row.tags || '').split(',').filter(Boolean).map((x) => `<span class="tag">${esc(x)}</span>`).join('')}
        </div>
        <div class="meta">${esc(row.source || '出处未标注')} · score=${Number(row.score).toFixed(4)}
          ${row.ft_rank ? ` · 全文#${row.ft_rank}` : ''}${row.vec_rank ? ` · 向量#${row.vec_rank}` : ''}</div>
        <div class="content">${esc(row.content.slice(0, 200))}</div>
      </li>`).join('')
  } catch (e) {
    $('timing').textContent = '检索失败：' + e.message
  } finally {
    $('btnSearch').disabled = false
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

$('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnSearch').click() })
health()
