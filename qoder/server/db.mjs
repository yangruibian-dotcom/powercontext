// 科研资料混检助手 · seekdb 数据层
// 表里同时有：向量(VECTOR+HNSW)、全文(ngram)、结构化标签(tags) 三类检索能力
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
  FULLTEXT INDEX ft_content (title, content, tags) WITH PARSER ngram,
  VECTOR INDEX vidx_emb (embedding) WITH (DISTANCE=cosine, TYPE=hnsw, LIB=vsag)
);
`

export async function init() {
  if (conn) return
  fs.mkdirSync(DB_DIR, { recursive: true })
  const t0 = Date.now()
  db = await seekdb.open(DB_DIR)
  const opts = db.connectionOptions()
  const { transport, ...tcp } = opts
  conn = await mysql.createConnection({ ...tcp, multipleStatements: true, decimalNumbers: true })
  await conn.query(SCHEMA)
  console.error(`seekdb ready in ${Date.now() - t0}ms (${transport}, ${DB_DIR})`)
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
      d.title || '',
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

const ngramSQL = 'MATCH(title, content, tags) AGAINST(?)'

/** 混合检索：全文 + 向量两路召回，RRF 融合，全部在 seekdb 内完成 */
async function hybrid({ queryText, embedding, tags, k }) {
  const tagClause = tags ? ' AND tags LIKE CONCAT(\'%\', ?, \'%\')' : ''
  const tagArgs = tags ? [tags] : []
  const sql = `
    WITH ft AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY ${ngramSQL} DESC) AS rnk
      FROM kb.docs WHERE ${ngramSQL}${tagClause}
    ), vc AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY cosine_distance(embedding, ?) ASC) AS rnk
      FROM kb.docs WHERE embedding IS NOT NULL${tagClause}
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
  const args = [queryText, queryText, ...tagArgs, JSON.stringify(embedding), ...tagArgs, k]
  const [rows] = await conn.query(sql, args)
  return rows.map((r) => ({
    doc_id: r.doc_id,
    title: r.title,
    content: r.content,
    tags: r.tags,
    source: r.source,
    score: Number(r.score),
    ft_rank: r.ft_rank ?? null,
    vec_rank: r.vec_rank ?? null,
  }))
}

async function vectorOnly({ embedding, tags, k }) {
  const tagClause = tags ? ' AND tags LIKE CONCAT(\'%\', ?, \'%\')' : ''
  const sql = `SELECT doc_id,title,content,tags,source, cosine_distance(embedding, ?) AS dist
     FROM kb.docs WHERE embedding IS NOT NULL${tagClause}
     ORDER BY dist APPROXIMATE LIMIT ?`
  const [rows] = await conn.query(sql, [JSON.stringify(embedding), ...(tags ? [tags] : []), k])
  return rows.map((r) => ({ ...r, score: 1 - Number(r.dist), dist: Number(r.dist) }))
}

async function fulltextOnly({ queryText, tags, k }) {
  const tagClause = tags ? ' AND tags LIKE CONCAT(\'%\', ?, \'%\')' : ''
  const sql = `SELECT doc_id,title,content,tags,source, ${ngramSQL} AS s
     FROM kb.docs WHERE ${ngramSQL}${tagClause}
     ORDER BY s DESC LIMIT ?`
  const [rows] = await conn.query(sql, [queryText, queryText, ...(tags ? [tags] : []), k])
  return rows.map((r) => ({ ...r, score: Number(r.s) }))
}

export async function search({ queryText, embedding, mode = 'hybrid', tags = '', k = 5 }) {
  await init()
  const t0 = Date.now()
  let rows
  if (mode === 'vector') rows = await vectorOnly({ embedding, tags, k })
  else if (mode === 'fulltext') rows = await fulltextOnly({ queryText, tags, k })
  else rows = await hybrid({ queryText, embedding, tags, k })
  return { mode, k, tags, db_ms: Date.now() - t0, rows }
}

export async function close() {
  if (conn) await conn.end().catch(() => {})
  if (db) db.close()
  conn = null
  db = null
}
