// 科研资料混检助手 · HTTP 服务（静态页面 + JSON API）
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as db from './db.mjs'
import { embed, MODEL_ID } from './embed.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WEB = path.join(ROOT, 'web')
const PORT = Number(process.env.PORT || 5273)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

/** 只允许访问 web/ 目录内的文件，防止 ../ 路径穿越 */
const file = (res, rel) => {
  const p = path.resolve(WEB, '.' + path.posix.normalize('/' + rel))
  if (!p.startsWith(WEB + path.sep) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('not found')
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(p)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  })
  fs.createReadStream(p).pipe(res)
}

const body = (req) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 32 * 1024 * 1024) {
        reject(Object.assign(new Error('body too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        reject(Object.assign(new Error('invalid json'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })

const isVec = (v) =>
  Array.isArray(v) && v.length === db.EMB_DIM && v.every((x) => Number.isFinite(x))

async function handleImport(req, res) {
  const b = await body(req)
  const docs = b.docs
  if (!Array.isArray(docs) || !docs.length) {
    return json(res, 400, { ok: false, error: 'docs required' })
  }
  if (docs.length > 1000) return json(res, 400, { ok: false, error: 'at most 1000 docs per import' })

  for (const d of docs) {
    if (!d || typeof d.doc_id !== 'string' || !d.doc_id.trim() || d.doc_id.length > 64) {
      return json(res, 400, { ok: false, error: 'doc_id required (<=64 chars)' })
    }
    if (typeof d.content !== 'string' || !d.content.trim()) {
      return json(res, 400, { ok: false, error: `content required for ${d.doc_id}` })
    }
    if (d.embedding !== undefined && !isVec(d.embedding)) {
      return json(res, 400, { ok: false, error: `embedding must be ${db.EMB_DIM} finite numbers` })
    }
  }

  // 前端只传文本时，服务端本地向量化；也允许调用方直接传 embedding（384 维）
  const need = docs.filter((d) => d.embedding === undefined)
  const t0 = Date.now()
  const vectors = need.length ? await embed(need.map((d) => `${d.title || ''}\n${d.content}`)) : []
  const embedMs = Date.now() - t0
  let vi = 0
  const ready = docs.map((d) => (d.embedding === undefined ? { ...d, embedding: vectors[vi++] } : d))

  const r = await db.importDocs(ready)
  return json(res, 200, { ok: true, embed_ms: embedMs, ...r })
}

async function handleSearch(req, res) {
  const b = await body(req)
  const queryText = typeof b.queryText === 'string' ? b.queryText.trim() : ''
  if (!queryText) return json(res, 400, { ok: false, error: 'queryText required' })
  if (queryText.length > 500) return json(res, 400, { ok: false, error: 'queryText too long' })

  const mode = ['hybrid', 'vector', 'fulltext'].includes(b.mode) ? b.mode : 'hybrid'
  const tags = typeof b.tags === 'string' ? b.tags.slice(0, 200) : ''
  const k = Math.min(Math.max(Number(b.k) || 5, 1), 50)

  const t0 = Date.now()
  const qv = mode === 'fulltext' ? null : (await embed([queryText]))[0]
  const embedMs = Date.now() - t0
  const r = await db.search({ queryText, embedding: qv, mode, tags, k })
  return json(res, 200, { ok: true, embed_ms: embedMs, ...r })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const p = decodeURIComponent(url.pathname)
  try {
    if (p === '/api/health' && req.method === 'GET') {
      return json(res, 200, { ok: true, ...(await db.stats()), model: MODEL_ID })
    }

    if (p === '/api/corpus' && req.method === 'GET') {
      const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'corpus.json'), 'utf8'))
      return json(res, 200, corpus)
    }

    if (p === '/api/import' && req.method === 'POST') return handleImport(req, res)
    if (p === '/api/search' && req.method === 'POST') return handleSearch(req, res)

    if (p === '/api/reset' && req.method === 'POST') {
      return json(res, 200, { ok: true, ...(await db.reset()) })
    }

    if (p.startsWith('/api/')) return json(res, 404, { ok: false, error: 'not found' })
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: 'method not allowed' })

    return file(res, p === '/' ? '/index.html' : p)
  } catch (e) {
    console.error('[error]', e)
    if (!res.headersSent) json(res, e.status || 500, { ok: false, error: String(e.message || e) })
  }
})

server.listen(PORT, () => console.log(`科研资料混检助手 → http://localhost:${PORT}`))

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await db.close()
    server.close(() => process.exit(0))
  })
}
