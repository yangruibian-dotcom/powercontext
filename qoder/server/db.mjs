// 科研资料混检助手 · seekdb 数据层
// 一条表里同时具备：向量(HNSW/cosine)、全文(ngram)、标签过滤三类检索能力
import fs from 'node:fs'
import path from 'node:path'
import mysql from 'mysql2/promise'
import { seekdb } from '@oceanbase/seekdb-node'

const DB_DIR = process.env.SEEKDB_DIR || path.resolve('data/seekdb')
export const EMB_DIM = 384

let db = null
let conn = null

const SCHEMA = `
CREATE DATABASE IF NOT EXISTS kb;
USE kb;
CREATE TABLE IF NOT EXISTS docs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  doc_id VARCHAR(64) NOT NULL,
  title VARCHAR(300) DEFAULT '',
  content TEXT NOT NULL,
  tags VARCHAR(255) DEFAULT '',
  source VARCHAR(300) DEFAULT '',
  embedding VECTOR(${EMB_DIM}),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_doc (doc_id),
  FULLTEXT INDEX ft_content (title, content) WITH PARSER ngram,
  VECTOR INDEX vidx_emb (embedding) WITH (DISTANCE=cosine, TYPE=hnsw, LIB=vsag)
);
`

export async function init() {
  if (conn) return
  fs.mkdirSync(DB_DIR, { recursive: true })
  const t0 = Date.now()
  db = await seekdb.open(DB_DIR, { parameters: { mysql_port_mode: 'random' } })
  const o = db.connectionOptions()
  const base = { user: o.user, decimalNumbers: true, multipleStatements: true }
  const location =
    o.transport === 'tcp'
      ? { host: o.host, port: o.port }
      : { socketPath: o.transport === 'unix_socket' ? o.unixSocket : o.namedPipe }
  conn = await mysql.createConnection({ ...base, ...location })
  await conn.query(SCHEMA)
  console.error(`seekdb ready in ${Date.now() - t0}ms (${o.transport}, ${DB_DIR})`)
}

export async function stats() {
  await init()
  const [rows] = await conn.query('SELECT COUNT(*) AS n FROM kb.docs')
  return { docs: Number(rows[0].n), dim: EMB_DIM, dir: DB_DIR }
}

export async function reset() {
  await init()
  await conn.query('DELETE FROM kb.docs')
  return { ok: true }
}

export async function importDocs(docs) {
  await init()
  const t0 = Date.now()
  const CHUNK = 40
  for (let i = 0; i < docs.length; i += CHUNK) {
    const part = docs.slice(i, i + CHUNK)
    const values = part.map((d) => [
      d.doc_id,
      (d.title || '').slice(0, 300),
      d.content,
      d.tags || '',
      d.source || '',
      JSON.stringify(d.embedding),
    ])
    await conn.query(
      'INSERT INTO kb.docs (doc_id,title,content,tags,source,embedding) VALUES ? ' +
        'ON DUPLICATE KEY UPDATE title=VALUES(title), content=VALUES(content), tags=VALUES(tags), ' +
        'source=VALUES(source), embedding=VALUES(embedding)',
      [values],
    )
  }
  const [rows] = await conn.query('SELECT COUNT(*) AS n FROM kb.docs')
  return { inserted: docs.length, total: Number(rows[0].n), write_ms: Date.now() - t0 }
}

const ngramSQL = 'MATCH(title, content) AGAINST(?)'

/** tags 支持逗号分隔多标签，要求全部命中 */
function tagFilter(tags) {
  const list = String(tags || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!list.length) return { sql: '', args: [] }
  return {
    sql: list.map(() => " AND tags LIKE CONCAT('%', ?, '%')").join(''),
    args: list,
  }
}

/** 混合检索：全文 + 向量两路召回，RRF 融合，全部在 seekdb 内由一条 SQL 完成 */
async function hybrid({ queryText, embedding, tags, k }) {
  const tag = tagFilter(tags)
  const sql = `
    WITH ft AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY ${ngramSQL} DESC) AS rnk
      FROM kb.docs WHERE ${ngramSQL}${tag.sql}
    ), vc AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY cosine_distance(embedding, ?) ASC) AS rnk
      FROM kb.docs WHERE embedding IS NOT NULL${tag.sql}
    )
    SELECT d.doc_id, d.title, d.content, d.tags, d.source,
           COALESCE(1.0/(60+ft.rnk), 0) + COALESCE(1.0/(60+vc.rnk), 0) AS score,
           ft.rnk AS ft_rank, vc.rnk AS vec_rank
    FROM kb.docs d
    LEFT JOIN ft ON ft.id = d.id
    LEFT JOIN vc ON vc.id = d.id
    WHERE ft.id IS NOT NULL OR vc.id IS NOT NULL
    ORDER BY score DESC
    LIMIT ?`
  const args = [queryText, queryText, ...tag.args, JSON.stringify(embedding), ...tag.args, k]
  const [rows] = await conn.query(sql, args)
  return rows.map(toRow)
}

async function vectorOnly({ embedding, tags, k }) {
  const tag = tagFilter(tags)
  const sql = `SELECT doc_id,title,content,tags,source, cosine_distance(embedding, ?) AS dist
     FROM kb.docs WHERE embedding IS NOT NULL${tag.sql}
     ORDER BY cosine_distance(embedding, ?) APPROXIMATE LIMIT ?`
  const [rows] = await conn.query(sql, [JSON.stringify(embedding), ...tag.args, JSON.stringify(embedding), k])
  return rows.map((r, i) => ({
    ...toRow(r),
    score: 1 - Number(r.dist),
    dist: Number(r.dist),
    ft_rank: null,
    vec_rank: i + 1,
  }))
}

async function fulltextOnly({ queryText, tags, k }) {
  const tag = tagFilter(tags)
  const sql = `SELECT doc_id,title,content,tags,source, ${ngramSQL} AS s
     FROM kb.docs WHERE ${ngramSQL}${tag.sql}
     ORDER BY s DESC LIMIT ?`
  const [rows] = await conn.query(sql, [queryText, queryText, ...tag.args, k])
  return rows.map((r, i) => ({
    ...toRow(r),
    score: Number(r.s),
    ft_rank: i + 1,
    vec_rank: null,
  }))
}

const toRow = (r) => ({
  doc_id: r.doc_id,
  title: r.title,
  content: r.content,
  tags: r.tags,
  source: r.source,
  score: Number(r.score ?? r.s ?? 0),
  ft_rank: r.ft_rank ?? null,
  vec_rank: r.vec_rank ?? null,
})

const SNIPPET_LEN = 160

/** 优先截取查询词（或中文二字窗口）首次出现的位置，向量命中则退回开头 */
function makeSnippet(content, queryText) {
  const text = String(content || '').replace(/\s+/g, ' ').trim()
  if (text.length <= SNIPPET_LEN) return text
  const q = String(queryText || '').trim()
  const probes = [q, ...q.split(/\s+/)].filter((s) => s.length >= 2)
  for (let i = 0; i + 2 <= q.length; i++) probes.push(q.slice(i, i + 2))
  let idx = -1
  for (const p of probes) {
    const i = text.indexOf(p)
    if (i !== -1 && (idx === -1 || i < idx)) idx = i
  }
  if (idx === -1) idx = 0
  const start = Math.max(0, idx - 30)
  const end = Math.min(text.length, start + SNIPPET_LEN)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

export async function search({ queryText, embedding, mode = 'hybrid', tags = '', k = 5 }) {
  await init()
  const t0 = Date.now()
  let rows
  if (mode === 'vector') rows = await vectorOnly({ embedding, tags, k })
  else if (mode === 'fulltext') rows = await fulltextOnly({ queryText, tags, k })
  else rows = await hybrid({ queryText, embedding, tags, k })
  return {
    mode,
    k,
    tags,
    db_ms: Date.now() - t0,
    rows: rows.map((r) => ({ ...r, snippet: makeSnippet(r.content, queryText) })),
  }
}

export async function close() {
  if (conn) await conn.end().catch(() => {})
  if (db) db.close()
  conn = null
  db = null
}
