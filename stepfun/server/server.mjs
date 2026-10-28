// 极简静态服务 + JSON API。依赖只有 node 内置模块。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as db from './db.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WEB = path.join(ROOT, 'web')
const PORT = Number(process.env.PORT || 5173)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.onnx': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

function sendFile(res, file, { cache = false } = {}) {
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found: ' + path.relative(ROOT, file))
    return
  }
  const ext = path.extname(file).toLowerCase()
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': cache ? 'public, max-age=86400' : 'no-store',
  })
  fs.createReadStream(file).pipe(res)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 64 * 1024 * 1024) reject(new Error('body too large'))
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch (e) {
        reject(new Error('invalid json body'))
      }
    })
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const p = decodeURIComponent(url.pathname)
  try {
    if (p === '/api/health') {
      const s = await db.stats()
      return sendJson(res, 200, { ok: true, ...s })
    }
    if (p === '/api/corpus') {
      const file = path.join(ROOT, 'data', 'corpus.json')
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      return res.end(fs.readFileSync(file))
    }
    if (p === '/api/queries') {
      const file = path.join(ROOT, 'data', 'queries.json')
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      return res.end(fs.readFileSync(file))
    }
    if (p === '/api/import' && req.method === 'POST') {
      const body = await readBody(req)
      const docs = body.docs || []
      if (!Array.isArray(docs) || docs.length === 0) return sendJson(res, 400, { ok: false, error: 'docs required' })
      for (const d of docs) {
        if (!d.doc_id || typeof d.content !== 'string') return sendJson(res, 400, { ok: false, error: 'doc_id/content required' })
        if (!Array.isArray(d.embedding) || d.embedding.length !== db.EMB_DIM) {
          return sendJson(res, 400, { ok: false, error: `embedding must be ${db.EMB_DIM}-dim array` })
        }
      }
      const r = await db.importDocs(docs)
      return sendJson(res, 200, { ok: true, ...r })
    }
    if (p === '/api/search' && req.method === 'POST') {
      const body = await readBody(req)
      if (!body.queryText) return sendJson(res, 400, { ok: false, error: 'queryText required' })
      if (!Array.isArray(body.embedding) || body.embedding.length !== db.EMB_DIM) {
        return sendJson(res, 400, { ok: false, error: `embedding must be ${db.EMB_DIM}-dim array` })
      }
      const r = await db.search({
        queryText: body.queryText,
        embedding: body.embedding,
        mode: body.mode || 'hybrid',
        k: Math.min(Math.max(Number(body.k) || 5, 1), 50),
      })
      return sendJson(res, 200, { ok: true, ...r })
    }
    if (p === '/api/reset' && req.method === 'POST') {
      return sendJson(res, 200, { ok: true, ...(await db.reset()) })
    }

    // 静态资源
    if (p === '/') return sendFile(res, path.join(WEB, 'index.html'))
    if (p.startsWith('/vendor/')) {
      const name = p.slice('/vendor/'.length)
      const candidates = [
        path.join(ROOT, 'node_modules', '@huggingface', 'transformers', 'dist', name),
        path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist', name),
      ]
      const hit = candidates.find((f) => fs.existsSync(f))
      return sendFile(res, hit || candidates[0], { cache: true })
    }
    if (p.startsWith('/models/')) {
      return sendFile(res, path.join(WEB, 'models', p.slice('/models/'.length)), { cache: true })
    }
    return sendFile(res, path.join(WEB, p))
  } catch (e) {
    console.error('[error]', e)
    sendJson(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
  }
})

server.listen(PORT, () => {
  console.log(`端侧知识库已启动: http://localhost:${PORT}`)
})
