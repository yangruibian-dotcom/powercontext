# 科研资料混检助手（Research KB）

> 赛题：Build with Qoder —— 用 Qoder 做一个让学习、科研和工作更高效的项目
>
> 把论文摘要、课程笔记、实验记录导入本地 **seekdb**，用「**向量 + 全文 + 标签过滤**」混合检索，
> 输入一句自然语言问题就能定位到相关段落，并直接给出处（哪篇、哪一段）。

## 一、解决什么问题

查资料时的真实痛点：**明明记得写过，但翻不到。**

- PDF 摘要在下载文件夹里，笔记在某个 Markdown 里，实验记录在另一个表格里
- 关键词搜索搜不到同义表述（"融合策略" vs "怎么把两路结果合起来"）
- 纯语义检索又会漏掉必须精确匹配的术语（"HNSW""nDCG"）

这个工具的做法：**两类检索同时用**，再用标签把范围收窄，结果按融合分数排序，并标出它在两路召回中各排第几，方便判断为什么它被排上来。

## 二、核心功能

| 功能 | 说明 |
|---|---|
| 一键导入 | 载入 20 条示例资料，或直接粘贴自己的文本（空行分段，首行当标题） |
| 本地向量化 | 服务端本地跑 all-MiniLM-L6-v2（384 维，INT8），不调用任何云端 API |
| 混合检索 | 一条 SQL 内完成全文召回 + 向量召回 + RRF 融合，客户端不做二次拼合 |
| 标签过滤 | 先用结构化条件缩小候选集，再排序（`tags LIKE`） |
| 出处定位 | 每条结果显示 `source`（论文标题 · 章节 / 笔记日期），直接跳回原文位置 |
| 可解释 | 结果里显示 `全文#n`、`向量#n` 两路各自排名 |

## 三、技术架构

```
浏览器                          Node 进程
┌───────────────┐   POST      ┌──────────────────────────────┐
│ web/ 页面      │ ──────────► │ server.mjs  /api/import-text │
│ 只用原生 JS    │             │             /api/search      │
│              │ ◄────────── │        │                     │
└───────────────┘   结果       │        ▼                     │
                              │ embed.mjs（本地 all-MiniLM）  │
                              │        │                     │
                              │        ▼                     │
                              │ db.mjs ──► 嵌入式 seekdb      │
                              │   docs: VECTOR(384) +        │
                              │   FULLTEXT(ngram) + tags     │
                              └──────────────────────────────┘
```

- **seekdb 怎么接的**：`@oceanbase/seekdb-node` 在 Node 进程内启动嵌入式实例（TCP 随机端口，数据目录 `./data/seekdb`），
  再用 `mysql2` 走 MySQL 协议连接。
- **混合检索为什么在库里做**：两路召回都用 SQL 的窗口函数算排名，再按 RRF `1/(60+rank)` 相加排序；
  一次往返拿到最终顺序，不在应用层拼结果。

## 四、表结构与索引

```sql
CREATE TABLE kb.docs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  doc_id VARCHAR(64) NOT NULL,
  title VARCHAR(300) DEFAULT '',
  content TEXT NOT NULL,
  tags VARCHAR(255) DEFAULT '',
  source VARCHAR(300) DEFAULT '',
  embedding VECTOR(384),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_doc (doc_id),
  FULLTEXT INDEX ft_content (title, content, tags) WITH PARSER ngram,
  VECTOR INDEX vidx_emb (embedding) WITH (DISTANCE=cosine, TYPE=hnsw, LIB=vsag)
);
```

> `WITH PARSER ngram` 是中文能搜到的关键：默认解析器按空格切词，中文会零命中。
> （可直接执行版本见 `server/db.mjs`。）

## 五、跑起来

```bash
cd qoder

# 1) 依赖（Node 20+）
npm install

# 2) 下载模型（默认 hf-mirror，可用 HF_ENDPOINT 切 huggingface.co）
npm run fetch-model

# 3) 启动
npm start
#    打开 http://localhost:5273
```

首次启动会创建 seekdb 数据目录（约 3 秒）。之后：

1. 点「载入示例资料（20 条）」→「向量化并写入 seekdb」
2. 输入 `中文全文检索为什么搜不到`，模式选「混合」→ 第一条应是《中文全文检索的分词问题》
3. 标签框填 `检索` 再搜一次 → 候选被收窄到带检索标签的资料

## 六、接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 资料条数、维度、数据目录 |
| GET | `/api/corpus`、`/api/queries` | 示例资料 / 评测查询 |
| POST | `/api/import-text` | `{docs:[{doc_id,title,content,tags,source}]}` 服务端向量化后写库 |
| POST | `/api/import` | 同上，但由调用方传 `embedding[384]` |
| POST | `/api/search` | `{queryText,tags?,mode:hybrid\|vector\|fulltext,k}` |
| POST | `/api/reset` | 清空资料 |

## 七、实测数据

环境：Windows 11 / Node v24 / 4 vCPU，模型 `all-MiniLM-L6-v2` INT8（21.91 MB），20 条资料 + 10 条评测查询。

| 模式 | Recall@5 | 查询向量化（中位） | seekdb 检索（中位） |
|---|---|---|---|
| hybrid | **1.000** | 3 ms | 11 ms |
| vector | 0.800 | 3 ms | 1 ms |
| fulltext | 1.000 | 3 ms | 2 ms |

其它：模型加载 159 ms；20 条资料向量化 223 ms（89.7 条/秒）；写库 73 ms；seekdb 首次初始化 3115 ms。

结论：在这份小语料上，**混合检索把纯向量的 0.800 拉到 1.000**，说明"向量召不回但全文能召回"的样本确实存在，融合是有效的。

## 八、已知限制

- **同一个 `data/seekdb` 目录只允许一个进程打开**（嵌入式模式的限制）。测试时如果同时跑 `npm run verify` 和 `npm start`，
  会出现"写入后搜不到"的假象 —— 这是两个实例抢同一目录，不是检索逻辑问题。
- 评测集只有 20 条资料 / 10 条查询，Recall@5 仅作方向性参考。
- 向量化在服务端 CPU 上跑，资料量大时导入会占满一个核；生产化可改批处理 + worker_threads。
- 暂不支持 PDF 直接解析（需要额外做文本抽取），当前导入纯文本。

## 九、数据来源

- 示例资料（20 条）为本项目原创编写的学习/科研笔记式文本，不含真实用户数据。
- Embedding 模型：`Xenova/all-MiniLM-L6-v2`（Apache-2.0），经 hf-mirror 下载。
- seekdb 用法参考：<https://github.com/oceanbase/seekdb>
