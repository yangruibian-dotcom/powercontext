// 科研资料混检助手 · HTTP 服务（静态页面 + JSON API）
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as db from './db.mjs'
import { embed } from './embed.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WEB = path.join(ROOT, 'web')
const PORT = Number(process.env.PORT || 5273)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

const file = (res, p) => {
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('not found: ' + path.relative(ROOT, p))
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' })
  fs.createReadStream(p).pipe(res)
}

const body = (req) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 64 * 1024 * 1024) reject(new Error('body too large'))
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', reject)
  })

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const p = decodeURIComponent(url.pathname)
  try {
    if (p === '/api/health') return json(res, 200, { ok: true, ...(await db.stats()) })

    if (p === '/api/corpus') return file(res, path.join(ROOT, 'data', 'corpus.json'))
    if (p === '/api/queries') return file(res, path.join(ROOT, 'data', 'queries.json'))

    if (p === '/api/import' && req.method === 'POST') {
      const b = await body(req)
      const docs = b.docs || []
      if (!Array.isArray(docs) || !docs.length) return json(res, 400, { ok: false, error: 'docs required' })
      for (const d of docs) {
        if (!d.doc_id || typeof d.content !== 'string') return json(res, 400, { ok: false, error: 'doc_id/content required' })
        if (!Array.isArray(d.embedding) || d.embedding.length !== db.EMB_DIM)
          return json(res, 400, { ok: false, error: `embedding must be ${db.EMB_DIM} dims` })
      }
      return json(res, 200, { ok: true, ...(await db.importDocs(docs)) })
    }

    // 一步导入：服务端本地向量化 + 写库（前端只传文本）
    if (p === '/api/import-text' && req.method === 'POST') {
      const b = await body(req)
      const docs = b.docs || []
      if (!Array.isArray(docs) || !docs.length) return json(res, 400, { ok: false, error: 'docs required' })
      const t0 = Date.now()
      const vectors = await embed(docs.map((d) => `${d.title || ''}\n${d.content}`))
      const embMs = Date.now() - t0
      const r = await db.importDocs(docs.map((d, i) => ({ ...d, embedding: vectors[i] })))
      return json(res, 200, { ok: true, embed_ms: embMs, ...r })
    }

    if (p === '/api/search' && req.method === 'POST') {
      const b = await body(req)
      if (!b.queryText) return json(res, 400, { ok: false, error: 'queryText required' })
      const t0 = Date.now()
      const [qv] = await embed([b.queryText])
      const embMs = Date.now() - t0
      const r = await db.search({
        queryText: b.queryText,
        embedding: qv,
        mode: b.mode || 'hybrid',
        tags: b.tags || '',
        k: Math.min(Math.max(Number(b.k) || 5, 1), 50),
      })
      return json(res, 200, { ok: true, embed_ms: embMs, ...r })
    }

    if (p === '/api/reset' && req.method === 'POST') return json(res, 200, { ok: true, ...(await db.reset()) })

    if (p === '/') return file(res, path.join(WEB, 'index.html'))
    return file(res, path.join(WEB, p))
  } catch (e) {
    console.error('[error]', e)
    json(res, 500, { ok: false, error: String(e.message || e) })
  }
})

server.listen(PORT, () => console.log(`科研资料混检助手 → http://localhost:${PORT}`))
