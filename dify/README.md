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
| Dify | **1.x（DSL version 0.3.0，advanced-chat / Chatflow）**，社区版即可 |
| 模型 | DeepSeek（`langgenius/deepseek/deepseek`，模型 `deepseek-chat`）。DSL 里写的是占位配置，**API Key 不入库**，导入后在 Dify「设置 → 模型供应商」里填自己的 Key；也可以直接用别的模型，在 LLM 节点重选即可 |
| seekdb | `oceanbase/seekdb:latest`（本文验证版本 `seekdb-v1.4.0.0`），Docker 运行，默认端口 2881 |
| 后端 | Python 3.10+，`fastapi` + `uvicorn` + `pymysql`（见 [`backend/requirements.txt`](backend/requirements.txt)） |
| 网络 | Dify 与后端需互通；若 Dify 跑在容器里访问宿主机后端，把 DSL 里 `http://127.0.0.1:8010` 换成 `http://host.docker.internal:8010`（Linux 下用宿主机内网 IP） |

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

## 七、已知限制

- **本地验证范围**：本仓库的 seekdb + 后端 + 全文检索是**实际跑通**的（证据见验证样例）；Dify DSL 是按 Dify 1.x（DSL 0.3.0）结构编写的，**未在作者的 Dify 实例里导入验证**（参赛环境未装 Dify）。导入若提示模型不可用，属正常现象，按第 4 步重选模型即可。
- 中文单字（如"酒"）在 `ngram_token_size=2` 下不命中，建议查询词 ≥2 字；接口已做"无命中退回最近记忆"兜底。
- 记忆只增不删（除 reset），长期会话会变长，可自行加清理策略。
- 后端没做鉴权，仅适合本机/内网演示。

## 八、数据与素材来源

- 表结构与接口为本作品原创；
- 文本示例（偷吃烤鸡、假蜘蛛等）为原创虚构内容，不含真实用户数据；
- seekdb 用法参考 [seekdb 项目说明](https://github.com/oceanbase/seekdb)；Dify HTTP Request 节点参考 <https://docs.dify.ai/en/cloud/use-dify/nodes/http-request>
