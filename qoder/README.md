# 科研资料混检助手

把论文摘要、课程笔记、实验记录导入本地 **seekdb**，用「向量 + 全文 + 标签」三路混合检索，几秒内定位到相关段落并标出出处（如 `论文标题 · 第3段`）。

面向「翻几十篇 PDF 找不到原文」的场景：不依赖云端 API，模型和语料都在本机。

## 特性

- **本地向量化**：`@huggingface/transformers` 在服务端跑 `all-MiniLM-L6-v2`（384 维，q8 量化，约 22 MB），不调用任何云端 API。
- **嵌入式 seekdb**：`@oceanbase/seekdb-node` 启动本地库，`mysql2` 连接；无需单独安装数据库。
- **一条 SQL 完成混合检索**：全文、向量两路各自 `ROW_NUMBER()` 排名，再用 RRF（`1/(60+rank)`）融合，不把两路结果拉到客户端拼接。
- **中文全文**：`FULLTEXT ... WITH PARSER ngram`，避免默认解析器对中文零命中。
- **HNSW 向量索引**：`VECTOR INDEX ... WITH (DISTANCE=cosine, TYPE=hnsw, LIB=vsag)`。
- **可选标签过滤**：逗号分隔多标签，要求全部命中；过滤条件同时下推到两路召回。
- **前端零构建**：原生 HTML/CSS/JS，支持分批导入进度、模式切换、命中片段与两路排名展示。

## 环境要求

- **Node.js ≥ 22**。业务代码只用到 Node 20 的能力，但 `@oceanbase/seekdb-node@1.4` 本身要求 Node ≥ 22（已在 Node 24 验证）。
- Windows x64 / macOS Apple Silicon / Linux x64、arm64（与 seekdb-node 的支持范围一致）。
- 首次启动 seekdb 需要几秒初始化；模型推理和数据库都跑在本机，建议预留 1 GB 以上内存。

## 快速开始

```bash
# 1. 安装依赖（保留 optional dependencies，seekdb 的原生运行时靠它）
npm install

# 2. 从 hf-mirror.com 下载模型到 models/all-MiniLM-L6-v2（约 22 MB）
npm run fetch-model

# 3. 启动服务
npm start
```

打开 <http://localhost:5273>：

1. 点击「向量化并写入 seekdb」，前端会分 4 批导入 `data/corpus.json` 里的 20 条示例资料，并显示每批的向量化/写库耗时与进度条。
2. 在检索框输入问题，例如 `中文全文检索为什么搜不到`，选择模式后检索。
3. 结果会显示标题、标签、出处、命中片段、`全文 #n` / `向量 #n` 排名与融合分数。
4. 也可以在文本框粘贴自己的资料（每段用空行分隔，第一行作为标题）一起导入。

常用环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `5273` | HTTP 端口 |
| `SEEKDB_DIR` | `data/seekdb` | seekdb 数据目录 |
| `MODEL_DIR` | `models` | 本地模型根目录 |
| `HF_ENDPOINT` | `https://hf-mirror.com` | 下载模型时的镜像 |

## 复现评测

```bash
npm run verify
```

脚本会：加载模型并预热 → 清空资料库 → 向量化并导入 20 条语料 → 对 10 条评测查询分别跑 `hybrid` / `vector` / `fulltext` 三种模式，输出 Recall@5、Top-1、零命中数与中位延迟。

本机（Windows 11、Node 24、seekdb-node 1.4.0）实测：

| 模式 | Recall@5 | Top-1 | 零命中 | 查询向量化(中位) | seekdb 检索(中位) |
|---|---|---|---|---|---|
| hybrid | 100.0% | 80.0% | 0 | 3 ms | 10.5 ms |
| vector | 80.0% | 60.0% | 2 | 3 ms | 1 ms |
| fulltext | 100.0% | 100.0% | 0 | 3 ms | 2 ms |

首次运行时模型加载约 0.2 s、seekdb 初始化约 2.3 s；20 条语料向量化约 75 ms、写库约 62–75 ms。

> 10 条评测查询偏关键词式，中文全文检索因此表现很好；`all-MiniLM-L6-v2` 是英文为主的句向量模型，纯向量模式在中文上有 2 条查询前 5 名未命中，这正是需要混合检索的原因。

## 目录结构

```
.
├── server/
│   ├── server.mjs        # 原生 http：静态文件 + JSON API
│   ├── db.mjs            # seekdb 启动/建表/导入/重置/检索
│   └── embed.mjs         # 本地 all-MiniLM-L6-v2 向量化
├── web/
│   ├── index.html        # 导入 + 检索界面
│   ├── app.js            # 原生 JS，无构建
│   └── style.css
├── data/
│   ├── corpus.json       # 20 条示例资料（title/content/tags/source）
│   ├── queries.json      # 10 条评测查询，含 relevant doc_id
│   └── seekdb/           # 运行时生成（git 忽略）
├── models/               # fetch-model 下载（git 忽略）
├── scripts/
│   ├── fetch-model.mjs   # 从 hf-mirror.com 下载模型
│   └── verify.mjs        # 质量与延迟对比
├── package.json
└── README.md
```

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 返回库内条数、向量维度、模型名、数据目录 |
| GET | `/api/corpus` | 返回示例语料 JSON |
| POST | `/api/import` | 批量导入/更新（按 `doc_id` upsert） |
| POST | `/api/search` | `hybrid \| vector \| fulltext` 检索 |
| POST | `/api/reset` | 清空 `docs` 表（保留库目录） |

### 导入

```bash
curl -X POST http://localhost:5273/api/import \
  -H 'Content-Type: application/json' \
  -d '{
    "docs": [{
      "doc_id": "p99",
      "title": "RAG 融合策略",
      "content": "RRF 用 1/(k+rank) 累加各路排名……",
      "tags": "检索,RAG",
      "source": "Survey on RAG · §3.2"
    }]
  }'
```

- 不传 `embedding` 时，服务端用本地模型对 `title + content` 向量化。
- 传 `embedding` 时必须是 **384 个有限数值**，否则返回 400。
- 每条 `doc_id` 唯一；重复导入会更新该条记录。
- 单次最多 1000 条；前端按 5 条一批上传来显示进度。

### 检索

```bash
curl -X POST http://localhost:5273/api/search \
  -H 'Content-Type: application/json' \
  -d '{"queryText":"中文全文检索为什么搜不到","tags":"检索","mode":"hybrid","k":5}'
```

- `mode`：`hybrid`（默认）/ `vector` / `fulltext`。
- `tags`：可选，逗号分隔；多个标签需同时出现在 `tags` 字段中。
- `k`：1–50，默认 5。
- 返回每条结果的 `score`、`ft_rank`、`vec_rank`、`snippet`（命中片段）、`source`（出处）。

## 表结构与关键 SQL

```sql
CREATE DATABASE IF NOT EXISTS kb;
USE kb;

CREATE TABLE IF NOT EXISTS docs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  doc_id VARCHAR(64) NOT NULL,
  title VARCHAR(300) DEFAULT '',
  content TEXT NOT NULL,
  tags VARCHAR(255) DEFAULT '',       -- 逗号分隔，如 "检索,RAG"
  source VARCHAR(300) DEFAULT '',     -- 出处
  embedding VECTOR(384),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_doc (doc_id),
  FULLTEXT INDEX ft_content (title, content) WITH PARSER ngram,
  VECTOR INDEX vidx_emb (embedding) WITH (DISTANCE=cosine, TYPE=hnsw, LIB=vsag)
);
```

- `id` 只用于混合检索时两路 CTE 的 JOIN；业务唯一键是 `doc_id`。
- 全文索引只覆盖 `title + content`，标签不参与相关性打分；标签过滤单独下推。
- 向量写入前已做 L2 归一化，配合 cosine 距离使用。

混合检索（单条 SQL，RRF 常数 60）：

```sql
WITH ft AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY MATCH(title, content) AGAINST(?) DESC) AS rnk
  FROM kb.docs WHERE MATCH(title, content) AGAINST(?)
    /* AND tags LIKE CONCAT('%', ?, '%') */
), vc AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY cosine_distance(embedding, ?) ASC) AS rnk
  FROM kb.docs WHERE embedding IS NOT NULL
    /* AND tags LIKE CONCAT('%', ?, '%') */
)
SELECT d.doc_id, d.title, d.content, d.tags, d.source,
       COALESCE(1.0/(60+ft.rnk), 0) + COALESCE(1.0/(60+vc.rnk), 0) AS score,
       ft.rnk AS ft_rank, vc.rnk AS vec_rank
FROM kb.docs d
LEFT JOIN ft ON ft.id = d.id
LEFT JOIN vc ON vc.id = d.id
WHERE ft.id IS NOT NULL OR vc.id IS NOT NULL
ORDER BY score DESC
LIMIT ?;
```

两路各自全量排名后融合；语料规模变大时，可以在两个 CTE 内先用 `LIMIT` 截候选（向量路用 `ORDER BY cosine_distance(...) APPROXIMATE` 走 HNSW），再在外层 `ROW_NUMBER()`。

## 已知限制

- `all-MiniLM-L6-v2` 以英文语料为主，中文纯向量召回有限；示例评测中 hybrid 明显优于 vector，这也是默认模式设为 hybrid 的原因。追求中文效果可换 `bge-small-zh` 等模型，但需同时改向量维度与建表语句。
- 标签是逗号分隔字符串 + `LIKE` 匹配，适合小规模语料和人工标签；需要精确多值匹配可改为 JSON 数组 + `JSON_CONTAINS`。
- `POST /api/reset` 只清空表数据，不删除 `data/seekdb`；要彻底重建库，停服务后删除该目录即可。
- 本地 seekdb 仅监听本机回环地址，不要直接暴露到不可信网络。
