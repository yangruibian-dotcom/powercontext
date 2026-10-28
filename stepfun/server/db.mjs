// seekdb 数据层：嵌入式 seekdb + 向量/全文/混合检索（全部在 seekdb 里完成）
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
  title VARCHAR(200) DEFAULT '',
  content TEXT NOT NULL,
  source VARCHAR(128) DEFAULT '',
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
  db = await seekdb.open(DB_DIR)
  const opts = db.connectionOptions()
  const { transport, ...tcp } = opts
  conn = await mysql.createConnection({ ...tcp, multipleStatements: true, decimalNumbers: true })
  await conn.query(SCHEMA)
  console.error(
    `seekdb opened in ${Date.now() - t0}ms, transport=${transport}, dir=${DB_DIR}`,
  )
}

export async function stats() {
  await init()
  const [rows] = await conn.query('SELECT COUNT(*) AS n FROM kb.docs')
  return { docs: Number(rows[0].n), dir: DB_DIR, dim: EMB_DIM }
}

export async function reset() {
  await init()
  await conn.query('DELETE FROM kb.docs')
  return { ok: true }
}

/** 批量写入（增量 upsert）。返回耗时明细。 */
export async function importDocs(docs) {
  await init()
  const t0 = Date.now()
  let inserted = 0
  const CHUNK = 50
  for (let i = 0; i < docs.length; i += CHUNK) {
    const part = docs.slice(i, i + CHUNK)
    const values = part.map((d) => [
      d.doc_id,
      (d.title || '').slice(0, 200),
      d.content,
      d.source || '',
      JSON.stringify(d.embedding),
    ])
    await conn.query(
      'INSERT INTO kb.docs (doc_id, title, content, source, embedding) VALUES ? ' +
        'ON DUPLICATE KEY UPDATE title=VALUES(title), content=VALUES(content), source=VALUES(source), embedding=VALUES(embedding)',
      [values],
    )
    inserted += part.length
  }
  const writeMs = Date.now() - t0
  // 一次轻量查询，确认新写入的文档已经可检索（索引是增量维护的）
  const [rows] = await conn.query('SELECT COUNT(*) AS n FROM kb.docs')
  return { inserted, total: Number(rows[0].n), write_ms: writeMs }
}

async function hybrid(queryText, embedding, k) {
  const [rows] = await conn.query(
    `WITH ft AS (
       SELECT id, ROW_NUMBER() OVER (ORDER BY MATCH(title, content) AGAINST(?) DESC) AS rnk
       FROM kb.docs WHERE MATCH(title, content) AGAINST(?)
     ), vc AS (
       SELECT id, ROW_NUMBER() OVER (ORDER BY cosine_distance(embedding, ?) ASC) AS rnk
       FROM kb.docs WHERE embedding IS NOT NULL
     )
     SELECT d.doc_id, d.title, d.content, d.source,
            COALESCE(1.0/(60+ft.rnk), 0) + COALESCE(1.0/(60+vc.rnk), 0) AS score,
            ft.rnk AS ft_rank, vc.rnk AS vec_rank
     FROM kb.docs d
     LEFT JOIN ft ON ft.id = d.id
     LEFT JOIN vc ON vc.id = d.id
     WHERE ft.id IS NOT NULL OR vc.id IS NOT NULL
     ORDER BY score DESC
     LIMIT ?`,
    [queryText, queryText, JSON.stringify(embedding), k],
  )
  return rows.map((r) => ({
    doc_id: r.doc_id, title: r.title, content: r.content, source: r.source,
    score: Number(r.score), ft_rank: r.ft_rank ?? null, vec_rank: r.vec_rank ?? null,
  }))
}

async function vectorOnly(embedding, k) {
  const [rows] = await conn.query(
    `SELECT doc_id, title, content, source,
            cosine_distance(embedding, ?) AS dist
     FROM kb.docs WHERE embedding IS NOT NULL
     ORDER BY dist APPROXIMATE LIMIT ?`,
    [JSON.stringify(embedding), k],
  )
  return rows.map((r) => ({
    doc_id: r.doc_id, title: r.title, content: r.content, source: r.source,
    score: 1 - Number(r.dist), dist: Number(r.dist),
  }))
}

async function fulltextOnly(queryText, k) {
  const [rows] = await conn.query(
    `SELECT doc_id, title, content, source,
            MATCH(title, content) AGAINST(?) AS s
     FROM kb.docs WHERE MATCH(title, content) AGAINST(?)
     ORDER BY s DESC LIMIT ?`,
    [queryText, queryText, k],
  )
  return rows.map((r) => ({
    doc_id: r.doc_id, title: r.title, content: r.content, source: r.source,
    score: Number(r.s),
  }))
}

/** mode: hybrid | vector | fulltext */
export async function search({ queryText, embedding, mode = 'hybrid', k = 5 }) {
  await init()
  const t0 = Date.now()
  let rows
  if (mode === 'vector') rows = await vectorOnly(embedding, k)
  else if (mode === 'fulltext') rows = await fulltextOnly(queryText, k)
  else rows = await hybrid(queryText, embedding, k)
  return { mode, k, db_ms: Date.now() - t0, rows }
}

export async function close() {
  if (conn) await conn.end().catch(() => {})
  if (db) db.close()
  conn = null
  db = null
}
