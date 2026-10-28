// 前端：Transformers.js 端侧向量化（WebGPU 优先，WASM 自动降级）+ seekdb 混合检索
import { pipeline, env } from '/vendor/transformers.min.js'

// 模型文件放在本地 web/models（由 scripts/fetch-model.mjs 下载），推理完全在浏览器内完成
env.allowRemoteModels = false
env.allowLocalModels = true
env.localModelPath = '/models/'
env.backends.onnx.wasm.wasmPaths = '/vendor/'

const $ = (id) => document.getElementById(id)
const state = { extractor: null, dim: 384, backend: null, dtype: null, corpus: [], ready: false }
const t = (ms) => `${ms.toFixed(0)} ms`

function setStatus(text, ok = true) {
  $('backendText').textContent = text
  $('dot').classList.toggle('ok', ok)
}

function log(el, line) {
  el.textContent += line + '\n'
  el.scrollTop = el.scrollHeight
}

/** 优先 WebGPU，失败自动降级 WASM */
async function loadModel() {
  const gpu = !!(navigator.gpu && (await navigator.gpu.requestAdapter?.()))
  const attempts = gpu
    ? [{ device: 'webgpu', dtype: 'q8', label: 'WebGPU + INT8(q8)' }, { device: 'wasm', dtype: 'q8', label: 'WASM + INT8(q8)' }]
    : [{ device: 'wasm', dtype: 'q8', label: 'WASM + INT8(q8)' }]

  for (const a of attempts) {
    try {
      setStatus(`模型加载中：${a.label} …`, true)
      const t0 = performance.now()
      state.extractor = await pipeline('feature-extraction', 'all-MiniLM-L6-v2', {
        device: a.device,
        dtype: a.dtype,
      })
      state.backend = a.device
      state.dtype = a.dtype
      setStatus(`推理后端：${a.label}`, true)
      $('modelText').textContent = `模型：all-MiniLM-L6-v2 (${a.dtype}) · 加载 ${t(performance.now() - t0)}`
      return
    } catch (e) {
      console.warn(`[${a.label}] 加载失败`, e)
      setStatus(`推理后端：${a.label} 不可用，正在回退…`, false)
    }
  }
  setStatus('推理后端：加载失败（请检查 web/models 是否存在）', false)
  throw new Error('model load failed')
}

async function embed(texts, batchSize = 8) {
  const out = []
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize)
    const res = await state.extractor(batch, { pooling: 'mean', normalize: true })
    for (let j = 0; j < batch.length; j++) out.push(Array.from(res[j].data))
  }
  return out
}

function setProgress(done, total) {
  $('bar').style.width = `${total ? (done / total) * 100 : 0}%`
}

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
  const json = await res.json()
  if (!json.ok) throw new Error(json.error || 'api error')
  return json
}

async function refreshHealth() {
  try {
    const h = await api('/api/health')
    $('dbText').textContent = `seekdb：${h.docs} 篇 · ${h.dim} 维`
    $('btnImport').disabled = !state.ready
    $('btnSearch').disabled = !state.ready
    $('btnBench').disabled = !state.ready
  } catch (e) {
    $('dbText').textContent = 'seekdb：未连接'
  }
}

async function loadCorpus() {
  if (!state.corpus.length) state.corpus = await (await fetch('/api/corpus')).json()
  const extra = $('customText').value.trim()
  const custom = extra ? extra.split(/\n\s*\n/).map((s, i) => ({ doc_id: `custom-${Date.now()}-${i}`, title: `自定义 ${i + 1}`, content: s.trim(), source: 'paste' })) : []
  return [...state.corpus, ...custom]
}

async function doImport() {
  $('btnImport').disabled = true
  const t0 = performance.now()
  try {
    const docs = await loadCorpus()
    log($('importLog'), `共 ${docs.length} 篇，开始本地向量化（${state.backend}/${state.dtype}）…`)
    const embT0 = performance.now()
    const vectors = await embed(docs.map((d) => `${d.title}\n${d.content}`), 8)
    const embMs = performance.now() - embT0
    setProgress(docs.length, docs.length)
    const payload = docs.map((d, i) => ({ ...d, embedding: vectors[i] }))
    const writeT0 = performance.now()
    const r = await api('/api/import', { docs: payload })
    const writeMs = performance.now() - writeT0
    log($('importLog'), `向量化 ${t(embMs)}（${(docs.length / (embMs / 1000)).toFixed(1)} 篇/秒）`)
    log($('importLog'), `写入 seekdb ${t(writeMs)}（inserted=${r.inserted}, total=${r.total}）`)
    log($('importLog'), `端到端 ${t(performance.now() - t0)}`)
    await refreshHealth()
  } catch (e) {
    log($('importLog'), '导入失败：' + e.message)
  } finally {
    $('btnImport').disabled = false
  }
}

async function doSearch() {
  const q = $('queryInput').value.trim()
  if (!q) return
  $('btnSearch').disabled = true
  try {
    const embT0 = performance.now()
    const [vec] = await embed([q], 1)
    const embMs = performance.now() - embT0
    const r = await api('/api/search', { queryText: q, embedding: vec, mode: $('mode').value, k: 5 })
    $('timing').textContent =
      `查询向量化 ${t(embMs)} · seekdb 检索 ${t(r.db_ms)} · 端到端 ${t(embMs + r.db_ms)} · 模式 ${r.mode}`
    $('results').innerHTML = r.rows
      .map(
        (row, i) => `<li>
          <div class="title">${i + 1}. ${escapeHtml(row.title || row.doc_id)}</div>
          <div class="meta">score=${Number(row.score).toFixed(4)}${row.ft_rank ? ` · 全文#${row.ft_rank}` : ''}${row.vec_rank ? ` · 向量#${row.vec_rank}` : ''}${row.dist !== undefined ? ` · dist=${Number(row.dist).toFixed(4)}` : ''}</div>
          <div class="content">${escapeHtml(row.content.slice(0, 220))}</div>
        </li>`,
      )
      .join('')
  } catch (e) {
    $('timing').textContent = '检索失败：' + e.message
  } finally {
    $('btnSearch').disabled = false
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

const median = (a) => {
  const b = [...a].sort((x, y) => x - y)
  const m = Math.floor(b.length / 2)
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2
}

const NL = String.fromCharCode(10)

/** 基准：重复 N 次，输出中位数，生成可粘贴进 TECH_NOTE 的表格 */
async function doBench() {
  const repeats = Number($('benchRepeats').value) || 5
  const docs = await loadCorpus()
  const queries = await (await fetch('/api/queries')).json()
  $('btnBench').disabled = true
  log($('benchLog'), '开始基准：' + repeats + ' 次 x ' + queries.length + ' 条查询' + NL)

  const embTimes = []
  const dbTimes = []
  const qEmbTimes = []
  const e2eTimes = []
  let recallHits = 0
  let recallTotal = 0

  try {
    for (let r = 0; r < repeats; r++) {
      const embT0 = performance.now()
      const vectors = await embed(docs.map((d) => d.title + NL + d.content), 8)
      const embMs = performance.now() - embT0
      embTimes.push(embMs)
      await api('/api/import', { docs: docs.map((d, i) => ({ ...d, embedding: vectors[i] })) })

      for (const q of queries) {
        const t0 = performance.now()
        const [qv] = await embed([q.query], 1)
        const qEmbMs = performance.now() - t0
        qEmbTimes.push(qEmbMs)
        const res = await api('/api/search', { queryText: q.query, embedding: qv, mode: 'hybrid', k: 5 })
        dbTimes.push(res.db_ms)
        e2eTimes.push(qEmbMs + res.db_ms)
        const ids = res.rows.map((x) => x.doc_id)
        recallHits += q.relevant.filter((id) => ids.includes(id)).length
        recallTotal += q.relevant.length
      }
      log($('benchLog'), '第 ' + (r + 1) + '/' + repeats + ' 轮：向量化 ' + t(embMs) + '，seekdb 检索中位 ' + t(median(dbTimes)) + NL)
    }

    const recall = recallHits / recallTotal
    const header = '| 配置 | 向量化（' + docs.length + ' 篇，中位） | 查询向量化（中位） | seekdb 检索（中位） | 端到端查询（中位） | Recall@5 |'
    const sep = '|---|---|---|---|---|---|'
    const line = '| ' + state.backend + ' + ' + state.dtype + ' | ' + t(median(embTimes)) + ' | ' + t(median(qEmbTimes)) + ' | ' + t(median(dbTimes)) + ' | ' + t(median(e2eTimes)) + ' | ' + recall.toFixed(3) + ' |'
    const table = [header, sep, line].join(NL)
    log($('benchLog'), NL + '--- 结果（中位数）---' + NL + table)
    $('benchLog').dataset.table = table
    $('btnExport').disabled = false
  } catch (e) {
    log($('benchLog'), '基准失败：' + e.message)
  } finally {
    $('btnBench').disabled = false
  }
}

$('btnLoadCorpus').onclick = async () => {
  const docs = await loadCorpus()
  log($('importLog'), `已准备 ${docs.length} 篇待导入文本`)
}
$('btnImport').onclick = doImport
$('btnSearch').onclick = doSearch
$('btnReset').onclick = async () => {
  await api('/api/reset', {})
  log($('importLog'), '知识库已清空')
  await refreshHealth()
}
$('btnBench').onclick = doBench
$('btnExport').onclick = async () => {
  const table = $('benchLog').dataset.table || ''
  await navigator.clipboard.writeText(table).catch(() => {})
  alert('已复制到剪贴板，粘贴进 TECH_NOTE.md 的表格即可')
}

;(async () => {
  try {
    await loadModel()
    state.ready = true
    await refreshHealth()
  } catch (e) {
    setStatus('推理后端：初始化失败', false)
  }
})()
