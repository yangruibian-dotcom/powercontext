# 记忆酒馆 · 会记仇的老板娘

> 赛题：Just for Fun —— 用 Dify 做一个好玩的智能应用（Dify × OceanBase seekdb）

## 一、这是个什么作品

酒馆里有个嘴不饶人的老板娘**阿芦**。你今晚点了什么、干了什么，她都会写进后厨那本账上 ——
这本"账"就是 **seekdb** 里的一张表。下次你再来，她会用中文全文检索把旧账翻出来，主动找你算：

- 你说"我又来啦"，她会提你上次偷吃招牌烤鸡、被追了三条街的事；
- 你夸她的桂花酒，她会想起上回多给了你半杯；
- 换个新会话，她会让你"自己报一遍上回干了什么"（不会编造没发生过的账）。

**好玩的点**：这不是普通的角色扮演，NPC 的记忆是**真存真取**的，你做的事会被记住、被翻旧账，形成一种"欠债感"。

## 二、技术分工

| 组件 | 在这个作品里干什么 |
|---|---|
| **Dify（必选）** | 承载整条 Chatflow：接收输入 → 调 HTTP 节点召回记忆 → LLM 生成老板娘台词 → 调 HTTP 节点写回记忆 → 输出。见 [`app.dsl.yml`](app.dsl.yml) |
| **seekdb** | 记忆的**存储 + 中文全文检索**：`tavern.memory` 表，`FULLTEXT INDEX ... WITH PARSER ngram`。每一轮对话前按玩家当前这句话检索最相关的旧账，检索结果直接拼进 LLM 的 system prompt，决定老板娘说什么 |
| FastAPI 后端（配套） | 只是把 seekdb 包成两个 HTTP 接口，供 Dify 的 HTTP Request 节点调用 |

一句话：**Dify 管流程，seekdb 管记忆**。检索不到时会自动退回"最近 N 条"（recent 模式），保证新会话也有上下文。

## 三、运行环境

| 项 | 版本 / 说明 |
|---|---|
| Dify | **1.18.0 实测通过**（自托管 docker compose；DSL 导入后在 `advanced-chat` / Chatflow 下运行）。DSL 声明的是 0.3.0，导入 1.18 会自动升级 |
| 模型 | **MiniMax**（`langgenius/minimax/minimax`，模型 `minimax-m3`）。需在 Dify「设置 → 模型供应商 → MiniMax」填入自己的 API Key，**Key 不入库**；也可以换成 DeepSeek 等其它供应商，在 LLM 节点重选模型即可 |
| seekdb | `oceanbase/seekdb:latest`（本文验证版本 `seekdb-v1.4.0.0`），Docker 运行，默认端口 2881 |
| 后端 | Python 3.10+，`fastapi` + `uvicorn` + `pymysql`（见 [`backend/requirements.txt`](backend/requirements.txt)） |
| 网络 | DSL 里两个 HTTP 节点默认指向 `http://memory-backend:8010`（与 Dify 同一条 docker 网络的后端容器）。若把后端跑在宿主机上，改成 `http://host.docker.internal:8010`（Linux 引擎需给 api 容器加 `extra_hosts: host.docker.internal:host-gateway`）。 |

## 四、从零跑起来

### 1. 启动 seekdb

```bash
# 仓库里的脚本，等价于 docker run
bash scripts/start_seekdb.sh
# 手动等价写法：
# docker run -d --name seekdb -p 2881:2881 -p 2886:2886 oceanbase/seekdb:latest
```

### 2. 建库建表

```bash
# 方式 A：用脚本（需要本机有 python + pymysql）
python scripts/init_schema.py

# 方式 B：手工执行 backend/schema.sql（用任意 MySQL 客户端连 127.0.0.1:2881，用户 root@sys，密码空）
```

关键点：全文索引必须带 `WITH PARSER ngram`，否则中文按空格切词会**零命中**。

### 3. 启动记忆服务

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8010
```

自检：

```bash
curl http://127.0.0.1:8010/health
# {"ok":true,"table":"memory","rows":0}
```

### 4. 导入 Dify DSL

1. Dify → 创建应用 → **导入 DSL 文件** → 选 [`app.dsl.yml`](app.dsl.yml)
2. 打开应用 → 编排页，两个 HTTP 请求节点的 URL 按你的实际地址改
3. LLM 节点里选你自己的模型（默认写的是 `deepseek-chat`，需要先在模型供应商里配置 DeepSeek 或任意 OpenAI 兼容服务）
4. 发布 → 用左侧"运行"或公开访问链接体验

### 5. 体验入口

- 在 Dify 应用页直接对话（推荐）
- 或发布后使用 Dify 提供的 Web App / API，无需另做前端

## 五、四个接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/health` | 连通性 + 当前记忆条数 |
| POST | `/memory/recall` | `{session_id, query, k}` → 全文检索旧账，无命中则退回最近 k 条 |
| POST | `/memory/write` | `{session_id, user_text, npc_text, tags}` → 写一条记忆 |
| POST | `/memory/reset` | `{session_id}` → 清空该会话记忆，用于反复演示 |

`session_id` 用 Dify 的 `sys.conversation_id`，所以不同会话的记忆天然隔离（同一条 SQL 里既有全文检索也有结构化过滤）。

## 六、验证样例

见 [`validation/验证样例.md`](validation/验证样例.md)：包含初始状态、输入顺序、预期表现，以及**本地实测输出**（seekdb 表结构、全文检索打分、接口返回）。

## 七、Dify 实测记录（2026-10-29，本机真跑）

环境：Dify **1.18.0** 自托管（docker compose，`/root/dify-run`）+ MiniMax 供应商插件 `langgenius/minimax:0.0.29` + 模型 `minimax-m3` + seekdb 容器 + 后端容器 `memory-backend`。

复现步骤（全部已执行成功）：

```bash
# 1. 起 Dify（官方 docker/docker-compose.yaml + .env）
docker compose up -d

# 2. 起 seekdb 并建表
docker run -d --name seekdb -p 2881:2881 oceanbase/seekdb:latest
python scripts/init_schema.py          # 建 tavern.memory（含 ngram 全文索引）

# 3. 后端以容器方式接入同一条网络（DSL 里用的就是这个名字）
docker build -t memory-backend:1 backend/
docker run -d --name memory-backend --network dify_default \
  -e SEEKDB_HOST=seekdb -p 8010:8010 memory-backend:1

# 4. 在 Dify 里导入 app.dsl.yml → 发布 → 建 API Key
#    然后调用会话接口（两轮，同一 conversation）
curl -X POST http://127.0.0.1/v1/chat-messages \
  -H "Authorization: Bearer app-xxx" -H "Content-Type: application/json" \
  -d '{"inputs":{},"query":"老板娘，我上回赊了三壶酒，还顺走你一把瓜子。","response_mode":"blocking","user":"reviewer-01","conversation_id":""}'
```

**实际运行结果**（导出方式：`GET /console/api/apps/{app_id}/workflow-runs` + `/node-executions`，原始 JSON 见 [`validation/dify-run-evidence.md`](validation/dify-run-evidence.md)）：

| run | 状态 | 节点链路 | 总耗时 |
|---|---|---|---|
| `07b0b908…` | succeeded | 开始 → **召回记忆（seekdb）** → 老板娘阿芦(LLM) → **写入记忆（seekdb）** → 直接回复 | 1.22 s / 466 tokens |
| `09d74342…` | succeeded | 同上 | 14.48 s / 767 tokens |

第二轮（同一 conversation）老板娘直接翻出「三壶酒、一把瓜子」，说明 seekdb 里的记忆被召回并进了 prompt。

导入过程中实际修掉的兼容问题（都已改在仓库的 `app.dsl.yml` 里）：

1. HTTP 节点 body 的 `type: json` 多字段写法在 1.18 会报 `json body type should have exactly one item` → 改成 `raw-text` 单条 JSON 字符串。
2. body 字段 `type: number` 在 1.18 已不支持（只允许 `text` / `file`）→ 改成 `text`。
3. 模型引用从 `langgenius/deepseek/deepseek` 换成实跑过的 `langgenius/minimax/minimax` + `minimax-m3`。

## 八、已知限制

- 中文单字（如"酒"）在 `ngram_token_size=2` 下不命中，建议查询词 ≥2 字；接口已做"无命中退回最近记忆"兜底。
- 记忆只增不删（除 reset），长期会话会变长，可自行加清理策略。
- 后端没做鉴权，仅适合本机/内网演示。

## 九、数据与素材来源

- 表结构与接口为本作品原创；
- 文本示例（偷吃烤鸡、假蜘蛛等）为原创虚构内容，不含真实用户数据；
- seekdb 用法参考 [seekdb 项目说明](https://github.com/oceanbase/seekdb)；Dify HTTP Request 节点参考 <https://docs.dify.ai/en/cloud/use-dify/nodes/http-request>
