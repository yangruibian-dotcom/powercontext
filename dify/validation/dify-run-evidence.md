# Dify 节点运行记录（本机实测导出）

环境：Dify **1.18.0**（自托管 docker compose），模型供应商 `langgenius/minimax/minimax`，模型 `minimax-m3`；
记忆后端：`dify/backend`（FastAPI）→ seekdb（端口 2881，库 `tavern`）。

导出方式（Dify 控制台 API，不是手写）：

```bash
GET /console/api/apps/{app_id}/workflow-runs?triggered_from=app-run
GET /console/api/apps/{app_id}/workflow-runs/{run_id}/node-executions
```

## 成功运行

### run `07b0b908-b41b-470c-a03e-4f6116f3d2dc`

- 状态：**succeeded**，总耗时 1.22s，tokens 466
- 触发方式：None，版本 2026-10-29 12:32:24.662495

| 节点 | 类型 | 状态 | 耗时(s) |
|---|---|---|---|
| 开始 | start | succeeded | 0.0 |
| 召回记忆（seekdb） | http-request | succeeded | 0.016 |
| 老板娘阿芦 | llm | succeeded | 1.134 |
| 写入记忆（seekdb） | http-request | succeeded | 0.022 |
| 直接回复 | answer | succeeded | 0.0 |

### run `09d74342-a4d0-4280-80b4-2cf85d35f68a`

- 状态：**succeeded**，总耗时 14.48s，tokens 767
- 触发方式：None，版本 2026-10-29 12:32:24.662495

| 节点 | 类型 | 状态 | 耗时(s) |
|---|---|---|---|
| 开始 | start | succeeded | 0.0 |
| 召回记忆（seekdb） | http-request | succeeded | 0.044 |
| 老板娘阿芦 | llm | succeeded | 14.334 |
| 写入记忆（seekdb） | http-request | succeeded | 0.047 |
| 直接回复 | answer | succeeded | 0.0 |

## 失败运行（修复前，保留以示真实调试过程）

- run `da8be86e-9311-4455-89e3-5b69d6c433c9`：failed，节点 开始(succeeded) → 召回记忆（seekdb）(retry) → 召回记忆（seekdb）(retry) → 召回记忆（seekdb）(failed)

- run `6ae9e17c-d15b-4c36-9b99-908cee66650c`：failed，节点 开始(succeeded) → 召回记忆（seekdb）(retry) → 召回记忆（seekdb）(retry) → 召回记忆（seekdb）(failed)

## 与 seekdb 的对应数据

运行结束后 `tavern.memory` 里的实际行：

```
1  session=ffef3caf...  user_text=老板娘，我上回赊了三壶酒，还顺走你一把瓜子。
2  session=ffef3caf...  user_text=你还记得我上回在你这儿干了什么吗？想赖账？
```

说明「写入记忆（seekdb）」节点确实落库；第二轮对话里「召回记忆（seekdb）」节点据此让老板娘翻出了旧账。