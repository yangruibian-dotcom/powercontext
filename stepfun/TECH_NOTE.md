# 一页技术说明 · 端侧知识库（浏览器向量化 + seekdb 混合检索）

## 1. 模型与量化

| 项 | 内容 |
|---|---|
| 模型 | `Xenova/all-MiniLM-L6-v2`（sentence-transformers all-MiniLM-L6-v2 的 ONNX 转换版，Apache-2.0） |
| 来源 | HuggingFace 仓库 `Xenova/all-MiniLM-L6-v2`（本机通过 `hf-mirror.com` 镜像下载，见 `scripts/fetch-model.mjs`） |
| 维度 / 归一化 | 384 维，`pooling=mean, normalize=true`，与 seekdb `cosine` 距离配套 |
| 量化方案 | **INT8（ONNX Runtime 的 q8 动态量化，`model_quantized.onnx`）**，对照基线为 fp32 `model.onnx` |

**体积与压缩比（实测文件字节数）**

| 精度 | 文件 | 体积 | 压缩比 |
|---|---|---|---|
| fp32 | `onnx/model.onnx` | **86.20 MB** | 1.00×（基线） |
| INT8 | `onnx/model_quantized.onnx` | **21.91 MB** | **3.93×** |

**检索质量变化**（同一 24 篇语料 + 12 条查询，指标 Recall@5，混合/仅向量/仅全文三路都测）

| 精度 | Recall@5（混合） | Recall@5（仅向量） | Recall@5（仅全文） |
|---|---|---|---|
| fp32 | 1.000 | 0.750 | 1.000 |
| INT8 q8 | 1.000 | 0.833 | 1.000 |

结论：量化后体积降到 1/3.93，召回在本评测集上**没有下降**（仅向量一路甚至略升，属小样本波动）。
该评测集偏小，"质量不变"的结论只在方向上有意义，大规模语料需重测。

## 2. 端侧运行

| 项 | 内容 |
|---|---|
| 运行时 | Transformers.js 4.x（浏览器 ESM 版），底层 ONNX Runtime Web |
| 后端选择 | 先探测 `navigator.gpu.requestAdapter()`；可用则 `device:'webgpu'`，加载失败或不可用则自动换 `device:'wasm'`，页面顶部实时显示当前后端 |
| 模型加载方式 | 完全本地：`env.allowRemoteModels=false`、`env.localModelPath='/models/'`，模型由本地 HTTP 提供，**无任何云端推理调用** |
| 降级验证 | `FORCE_WASM=1 npm run browser-check`（注入 `navigator.gpu=undefined`）实跑通过，状态栏显示 `WASM + INT8(q8)`，核心流程可运行 |

## 3. seekdb 使用

- **接入方式**：`@oceanbase/seekdb-node` 在 Node 进程内启动嵌入式 seekdb（TCP 随机端口，数据目录 `./data/seekdb`），
  `mysql2` 连接；浏览器不直接连库。
- **表结构**：见 README 第五节，`embedding VECTOR(384)` + `FULLTEXT INDEX ... WITH PARSER ngram` + `VECTOR INDEX ... (DISTANCE=cosine, TYPE=hnsw, LIB=vsag)`。
- **混合检索**：一条 SQL 内完成两路召回与融合（RRF，k=60），客户端只接收最终排序：

```sql
WITH ft AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY MATCH(title,content) AGAINST(?) DESC) AS rnk
  FROM kb.docs WHERE MATCH(title,content) AGAINST(?)
), vc AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY cosine_distance(embedding, ?) ASC) AS rnk
  FROM kb.docs WHERE embedding IS NOT NULL
)
SELECT d.doc_id, d.title, COALESCE(1.0/(60+ft.rnk),0)+COALESCE(1.0/(60+vc.rnk),0) AS score
FROM kb.docs d LEFT JOIN ft ON ft.id=d.id LEFT JOIN vc ON vc.id=d.id
WHERE ft.id IS NOT NULL OR vc.id IS NOT NULL
ORDER BY score DESC LIMIT ?;
```

- **增量写入与刷新**：`INSERT ... ON DUPLICATE KEY UPDATE` 批量 upsert（每批 50 条），
  向量索引与全文索引随写入增量维护；写入后立即查询即可命中，无需额外 rebuild。
- **状态管理**：`doc_id` 唯一键保证重复导入不产生重复文档；前端维护当前知识库文档集，`/api/reset` 可清空并回到初始态。

## 4. 状态、优化与实测

**优化点**

1. 批量向量化：一次 `pipeline` 调用跑 8 条文本（`batchSize=8`），比逐条调用快约 8 倍；
2. 批量写入：50 条一批的 upsert，24 篇文档写入 < 160 ms；
3. 混合检索单 SQL：一次往返拿到融合排序，避免"两路结果回客户端再拼合"；
4. 复用同一模型实例做文档与查询编码，查询侧只重跑一次 encode。

**实测数据**（机器：Windows 11 笔记本 VM，4 vCPU / 16 GB，无独立 GPU；浏览器：无头 Edge 最新版）

浏览器端（`npm run browser-check`，3 轮中位数）：

| 配置 | 模型加载 | 24 篇向量化 | 查询向量化 | seekdb 检索 | 端到端查询 | Recall@5 |
|---|---|---|---|---|---|---|
| q8 + WASM | 997 ms | 549 ms（48.6 篇/秒） | 6 ms | 2 ms | 9 ms | 1.000 |
| q8 + WebGPU* | 1121 ms | 876 ms（27.4 篇/秒） | 95 ms | 3 ms | 100 ms | 1.000 |

\* 无头虚拟机的 WebGPU 走软件适配器（SwiftShader），不能代表真实独显；真实 GPU 上 WebGPU 通常显著快于 WASM，可用页面「跑基准」在自己的机器上复测。

Node 端（`npm run verify`，CPU 后端，用于对齐 fp32/q8 质量）：

| 配置 | 模型加载 | 24 篇向量化 | 查询向量化 | seekdb hybrid | Recall@5（混合/向量/全文） |
|---|---|---|---|---|---|
| fp32 | 196 ms | 70 ms（342.9 篇/秒） | 3 ms | 11 ms | 1.000 / 0.750 / 1.000 |
| q8 | 107 ms | 61 ms（393.4 篇/秒） | 2 ms | 2 ms | 1.000 / 0.833 / 1.000 |

**首次 vs 预热**：首次启动含 seekdb 初始化（约 3.7 s，仅第一次）与模型首次加载（约 1.0 s）；上表均为预热后数值。
seekdb 写入 24 篇实测 61–159 ms（含建连接），检索 2–11 ms。

**计时口径**：向量化只计 `pipeline()` 调用；seekdb 检索只计 SQL 往返；端到端 = 查询向量化 + seekdb 检索。
