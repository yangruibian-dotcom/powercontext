// 前端：收集文本、分批调接口、渲染结果；向量化全部在服务端本地完成
const $ = (id) => document.getElementById(id)
const BATCH = 5

let corpus = null
let busy = false

async function api(path, body) {
  const res = await fetch(path, body ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  } : {})
  const j = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))
  if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`)
  return j
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]))

const t = (ms) => `${Math.round(ms)} ms`
const log = (s) => {
  const el = $('importLog')
  el.textContent += s + '\n'
  el.scrollTop = el.scrollHeight
}

function setBusy(v) {
  busy = v
  $('btnImport').disabled = v || !$('dot').classList.contains('ok')
  $('btnSearch').disabled = v || !$('dot').classList.contains('ok')
  $('btnReset').disabled = v
  $('btnLoad').disabled = v
}

async function health() {
  try {
    const h = await api('/api/health')
    $('dbText').textContent = `seekdb：${h.docs} 条资料 · ${h.dim} 维`
    $('dot').classList.add('ok')
    setBusy(busy)
  } catch {
    $('dbText').textContent = 'seekdb：未连接'
    $('dot').classList.remove('ok')
    setBusy(busy)
  }
}

async function loadCorpus() {
  if (!corpus) corpus = await (await fetch('/api/corpus')).json()
  return corpus
}

function parsePaste() {
  return $('paste').value
    .trim()
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block, i) => {
      const lines = block.split('\n')
      const title = lines.length > 1 ? lines[0].slice(0, 80) : `粘贴资料 ${i + 1}`
      const content = lines.length > 1 ? lines.slice(1).join('\n') : lines[0]
      return {
        doc_id: `paste-${Date.now()}-${i}`,
        title,
        content,
        tags: '粘贴',
        source: '手动粘贴 · 第1段',
      }
    })
}

async function collectDocs() {
  return [...(await loadCorpus()), ...parsePaste()]
}

async function importDocs(docs) {
  const t0 = Date.now()
  let done = 0
  let embedMs = 0
  let writeMs = 0
  $('prog').hidden = false

  for (let i = 0; i < docs.length; i += BATCH) {
    const batch = docs.slice(i, i + BATCH)
    const r = await api('/api/import', { docs: batch })
    done += r.inserted
    embedMs += r.embed_ms
    writeMs += r.write_ms
    $('prog').value = Math.round((done / docs.length) * 100)
    log(
      `批次 ${Math.floor(i / BATCH) + 1}/${Math.ceil(docs.length / BATCH)}：` +
      `+${r.inserted} 条 · 向量化 ${t(r.embed_ms)} · 写库 ${t(r.write_ms)} · 库内共 ${r.total} 条`,
    )
  }

  $('prog').value = 100
  log(`完成：${done} 条，总耗时 ${t(Date.now() - t0)}（向量化 ${t(embedMs)} / 写库 ${t(writeMs)}）`)
}

$('btnLoad').onclick = async () => {
  try {
    const docs = await loadCorpus()
    $('corpusHint').textContent = `示例语料 ${docs.length} 条`
    log(`已载入示例语料 ${docs.length} 条（${docs.map((d) => d.doc_id).slice(0, 5).join(', ')} …）`)
  } catch (e) {
    log('载入失败：' + e.message)
  }
}

$('btnImport').onclick = async () => {
  if (busy) return
  setBusy(true)
  log('开始向量化并写入 seekdb…')
  try {
    const docs = await collectDocs()
    await importDocs(docs)
    await health()
  } catch (e) {
    log('导入失败：' + e.message)
  } finally {
    setBusy(false)
    setTimeout(() => { $('prog').hidden = true }, 1200)
  }
}

$('btnReset').onclick = async () => {
  if (busy) return
  setBusy(true)
  try {
    await api('/api/reset', {})
    log('已清空资料库')
    $('results').innerHTML = ''
    $('timing').textContent = ''
    await health()
  } catch (e) {
    log('清空失败：' + e.message)
  } finally {
    setBusy(false)
  }
}

const rankText = (row) => {
  const parts = []
  if (row.ft_rank) parts.push(`全文 #${row.ft_rank}`)
  if (row.vec_rank) parts.push(`向量 #${row.vec_rank}`)
  return parts.length ? parts.join(' · ') : '单路命中'
}

function renderRows(rows) {
  if (!rows.length) {
    $('results').innerHTML = '<li class="empty">没有命中：换个说法，或切到「仅向量」试试。</li>'
    return
  }
  $('results').innerHTML = rows.map((row, i) => {
    const tags = (row.tags || '')
      .split(',')
      .filter(Boolean)
      .map((x) => `<span class="tag">${esc(x.trim())}</span>`)
      .join('')
    return `
      <li>
        <div class="title">${i + 1}. ${esc(row.title) || '（无标题）'}${tags}</div>
        <div class="meta">
          <span class="src">出处：${esc(row.source) || '未标注'}</span>
          <span class="sep">·</span>
          <span>${rankText(row)}</span>
          <span class="sep">·</span>
          <span>score ${Number(row.score).toFixed(4)}</span>
        </div>
        <div class="content">${esc(row.snippet || row.content)}</div>
      </li>`
  }).join('')
}

$('btnSearch').onclick = async () => {
  if (busy) return
  const queryText = $('q').value.trim()
  if (!queryText) return $('q').focus()
  setBusy(true)
  try {
    const r = await api('/api/search', {
      queryText,
      tags: $('tag').value.trim(),
      mode: $('mode').value,
      k: 5,
    })
    $('timing').textContent =
      `向量化 ${t(r.embed_ms)} · seekdb 检索 ${t(r.db_ms)} · 模式 ${r.mode}` +
      (r.tags ? ` · 标签「${r.tags}」` : '') + ` · ${r.rows.length} 条`
    renderRows(r.rows)
  } catch (e) {
    $('timing').textContent = '检索失败：' + e.message
    $('results').innerHTML = ''
  } finally {
    setBusy(false)
  }
}

$('q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btnSearch').click()
})

health()
