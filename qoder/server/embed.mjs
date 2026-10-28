// 服务端向量化：本地跑 all-MiniLM-L6-v2，不访问任何云端 API
import path from 'node:path'
import { pipeline, env } from '@huggingface/transformers'

const MODEL_DIR = process.env.MODEL_DIR || path.resolve('models')

env.allowRemoteModels = false
env.allowLocalModels = true
env.localModelPath = MODEL_DIR

let extractor = null
export const MODEL_ID = 'all-MiniLM-L6-v2'

export async function loadModel() {
  if (extractor) return extractor
  const t0 = Date.now()
  extractor = await pipeline('feature-extraction', MODEL_ID, { device: 'cpu', dtype: 'q8' })
  console.error(`model loaded in ${Date.now() - t0}ms (${MODEL_ID})`)
  return extractor
}

/** 批量向量化：返回 number[][]（已 L2 归一化，配合 cosine 距离） */
export async function embed(texts, batchSize = 8) {
  const model = await loadModel()
  const out = []
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize)
    const res = await model(batch, { pooling: 'mean', normalize: true })
    for (let j = 0; j < batch.length; j++) out.push(Array.from(res[j].data))
  }
  return out
}
