# 端侧知识库 · 浏览器向量化 + seekdb 混合检索

> 赛题：端侧 AI 推理性能优化与 seekdb 混合检索（seekdb × 阶跃星辰）
>
> 文档在**你的浏览器里**被向量化（WebGPU 优先，自动降级 WASM），向量与全文索引写进 **seekdb**（嵌入式，进程内启动），
> 查询也在浏览器里编码，最终由 seekdb 用一条 SQL 完成 **向量 + 全文混合检索**。

## 一、快速开始

```bash
cd stepfun

# 1) 安装依赖（Node 20+ / 22+ 均可）
npm install

# 2) 下载模型（默认走 hf-mirror；可用 HF_ENDPOINT 换成 huggingface.co）
npm run fetch-model
#    -> web/models/all-MiniLM-L6-v2/  (fp32 86.20 MB + q8 21.91 MB)

# 3) 启动（自带静态服务 + API；seekdb 会在首次访问时以嵌入式方式拉起）
npm start
#    打开 http://localhost:5173
```

浏览器要求：**Chrome / Edge 最新版**。页面顶部会显示当前推理后端（`WebGPU + INT8(q8)` 或 `WASM + INT8(q8)`）。

## 二、页面上怎么玩

1. 点「载入示例语料」（24 篇），或直接在文本框粘贴自己的文本（空行分段）；
2. 点「向量化并写入 seekdb」：先在浏览器里算向量，再整批 upsert 进 seekdb；
3. 输入查询，选「混合检索 / 仅向量 / 仅全文」，看排序结果、各路排名与耗时；
4. 点「跑基准」：自动重复 N 轮，输出中位数表格，可一键复制进 `TECH_NOTE.md`。

## 三、目录结构

```
stepfun/
├── server/
│   ├── server.mjs      # 静态服务 + JSON API（node 内置 http，无框架）
│   └── db.mjs          # seekdb 嵌入式启动、建表、向量/全文/混合检索 SQL
├── web/
│   ├── index.html
│   ├── style.css
│   ├── app.js          # Transformers.js 端侧推理 + WebGPU/WASM 切换 + 基准
│   └── models/         # 模型文件（由 fetch-model 下载，不随仓库提交）
├── data/
│   ├── corpus.json     # 24 篇示例语料
│   └── queries.json    # 12 条评测查询 + 相关文档标注（用于 Recall@5）
├── scripts/
│   ├── fetch-model.mjs # 下载 fp32 / q8 模型，并打印体积与压缩比
│   ├── verify.mjs      # Node 侧跑 fp32 vs q8 的质量与延迟对比
│   └── browser-check.mjs # 无头 Edge 真跑浏览器端到端（可 FORCE_WASM=1 验证降级）
└── TECH_NOTE.md        # 一页技术说明（含实测数据）
```

## 四、架构

```
浏览器                                    Node 进程
┌──────────────────────────┐            ┌─────────────────────────────┐
│ Transformers.js          │  POST      │ server.mjs  /api/import     │
│  all-MiniLM-L6-v2 (q8)   │ ─────────► │            /api/search      │
│  WebGPU ─失败─► WASM     │            │        │                    │
│  文档/查询都在本地编码   │ ◄───────── │        ▼                    │
└──────────────────────────┘  结果      │ db.mjs ──► 嵌入式 seekdb    │
                                        │   docs 表：VECTOR(384)      │
                                        │   + FULLTEXT(ngram) + HNSW  │
                                        └─────────────────────────────┘
```

- **本地推理**：模型文件由本地 HTTP 提供，`env.allowRemoteModels = false`，全程无云端推理 API。
- **seekdb**：通过 `@oceanbase/seekdb-node` 在 Node 进程内启动一个本地 seekdb 实例（TCP 随机端口），
  再用 `mysql2` 连接；数据目录 `./data/seekdb`。
- **混合检索在库里完成**：见 `server/db.mjs` 的 `hybrid()`，一条 SQL 里用两次 `ROW_NUMBER()` 分别算全文排名和向量排名，
  再按 RRF `1/(60+rank)` 融合排序 —— 客户端只拿到最终排序结果，不做二次拼合。

## 五、seekdb 表结构与索引

```sql
CREATE TABLE kb.docs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  doc_id VARCHAR(64) NOT NULL,
  title VARCHAR(200) DEFAULT '',
  content TEXT NOT NULL,
  source VARCHAR(128) DEFAULT '',
  embedding VECTOR(384),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_doc (doc_id),
  FULLTEXT INDEX ft_content (title, content) WITH PARSER ngram,
  VECTOR INDEX vidx_emb (embedding) WITH (DISTANCE=cosine, TYPE=hnsw, LIB=vsag)
);
```

- `ngram` 解析器是中文全文检索的关键（默认 `space` 解析器对中文零命中）；
- 增量写入用 `INSERT ... ON DUPLICATE KEY UPDATE`，向量索引与全文索引随写入增量维护，写完即可检索（页面会回显写入后总数）。

## 六、接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 文档数、维度、数据目录 |
| GET | `/api/corpus`、`/api/queries` | 示例语料 / 评测查询 |
| POST | `/api/import` | `{docs:[{doc_id,title,content,embedding[384]}]}`，批量 upsert |
| POST | `/api/search` | `{queryText, embedding[384], mode, k}`，mode ∈ hybrid/vector/fulltext |
| POST | `/api/reset` | 清空知识库 |

## 七、复现测试数据

```bash
# Node 侧：fp32 vs q8 的质量、延迟对比（会自动写入 data/seekdb）
npm run verify

# 浏览器侧：无头 Edge 跑完整流程（默认尝试 WebGPU；FORCE_WASM=1 强制降级）
npm run browser-check
FORCE_WASM=1 npm run browser-check
```

实测结果见 [TECH_NOTE.md](TECH_NOTE.md)。

## 八、已知限制

- 模型文件（109 MB）不随仓库提交，需执行 `npm run fetch-model`（默认 hf-mirror，国内可用；`HF_ENDPOINT=https://huggingface.co` 可切源）。
- 评测集只有 24 篇文档 / 12 条查询，Recall@5 仅作方向性参考，不等于大规模检索质量。
- 本机无头 Edge 的 WebGPU 走的是软件适配器（SwiftShader），因此表格里 WebGPU 反而比 WASM 慢；真实独显设备上 WebGPU 通常更快，可用页面上的「跑基准」在你自己的机器上复测。
- 图片/多模态未实现（题目里属于扩展项）；文本知识库流程完整。
