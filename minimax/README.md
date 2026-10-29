# 规有所依 · SDD 工程上下文模块（MiniMax × seekdb × PowerContext）

> 赛题：规有所依——面向软件持续演进的 SDD 上下文管理系统
>
> 给 AI 开发助手一个「按规矩干活」的上下文模块：任务来了，先从 seekdb 里检索出**当前有效的规格、要改的代码、验证用的测试**，
> 交给 MiniMax 改代码；任务进展写进 PowerContext，模块重启后还能读回来接着干。

## 一、它解决什么问题

AI 助手改代码时常见三种翻车：**漏掉规格、改错文件、用过期信息**。这个模块把「这次任务该遵守什么」变成一次可复现的检索：

```
任务描述
   ↓  seekdb 混合检索（向量 + 全文 + 类型过滤）
本次适用规格 REQ-x  /  要改的函数  /  验证该行为的测试
   ↓  拼成上下文
MiniMax 生成代码修改
   ↓  写入文件
pytest：目标测试从失败 → 通过，回归测试一直通过
   ↓
任务进展写入 PowerContext（重启后可读回）
```

## 二、目录结构

```
minimax/
├── biz/                    业务工程（可运行、有测试）
│   ├── expense/calc.py          费用报销统计（本次任务要改的对象）
│   ├── conftest.py
│   └── tests/
│       ├── test_regression.py   回归测试（改前改后都必须通过）
│       └── test_target.py       目标测试（改前失败，改后必须通过）
├── specs/expense-spec.md   规格（REQ-1 ~ REQ-5，可修改以验证「规格更新后生效」）
├── ctx/                    上下文模块
│   ├── embedder.py              本地向量化（onnxruntime + all-MiniLM-L6-v2）
│   ├── store.py                 seekdb 表结构与混合检索 SQL
│   ├── indexer.py               把规格/代码/测试切块并写入 seekdb
│   ├── resolver.py              任务 → 上下文（规格/代码/测试，带真实来源）
│   ├── minimax.py               调 MiniMax 生成代码修改
│   ├── state.py                 PowerContext 状态读写
│   └── cli.py                   模块调用入口（CLI）
├── scripts/
│   ├── fetch_model.py      下载 INT8 向量模型
│   ├── start_seekdb.sh     启动 seekdb（Docker）
│   ├── start_powercontext.sh 启动 PowerContext（本地服务）
│   └── run_demo.sh         一键跑完整验证样例
├── devlog/                 MiniMax 调用记录（自动生成）
├── requirements.txt
└── 验证样例.md / 技术说明.md
```

## 三、调用入口（CLI）

```bash
python -m ctx.cli index                 # 建索引：规格 + 代码 + 测试 → seekdb
python -m ctx.cli resolve --task "..."  # 输出本次任务的开发上下文（可 --json）
python -m ctx.cli patch --task "..." --apply --with-state   # 交给 MiniMax 并写回文件
python -m ctx.cli state save --step xxx --text "..."        # 保存任务进展
python -m ctx.cli state show                                # 读取任务进展（重启后可用）
python -m ctx.cli test                                      # 跑 pytest
```

输入：任务的自然语言描述（以及可选的 scope id）。
输出（`resolve`）：`{task, specs[], code[], tests[], state}`，每一项都带 `path` + `symbol` + 打分，来源真实存在。

## 四、跑起来

### 1. 依赖

```bash
python -V                 # 需要 3.11+
pip install -r requirements.txt
python scripts/fetch_model.py          # 下载 all-MiniLM-L6-v2 INT8（约 22 MB，默认走 hf-mirror）
```

### 2. seekdb（存工程资料）

```bash
bash scripts/start_seekdb.sh           # docker run -d --name seekdb -p 2881:2881 oceanbase/seekdb:latest
```

### 3. PowerContext（存任务状态）

```bash
pip install "powercontext[cli,server]==1.4.1"
bash scripts/start_powercontext.sh     # 默认监听 127.0.0.1:8000
```

### 4. 建索引并验证上下文

```bash
python -m ctx.cli index
python -m ctx.cli resolve \
  --task "给 summarize 增加 min_amount 金额阈值过滤，注意边界与默认行为"
```

应该看到：`specs/expense-spec.md` 的 **REQ-3** 排第一，代码命中 `biz/expense/calc.py :: summarize`，
测试命中 `biz/tests/test_target.py` 中的 `min_amount_*` 用例。

### 5. 让 MiniMax 改代码

```bash
export MINIMAX_API_KEY=你的key
python -m ctx.cli patch \
  --task "给 summarize 增加 min_amount 金额阈值过滤，注意边界与默认行为" \
  --apply --with-state
python -m ctx.cli test          # 目标测试 + 回归测试都应通过
```

调用记录会自动写到 `devlog/minimax-*.md`，上下文快照写到 `devlog/last_context.md`。

## 五、接口与配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `SEEKDB_HOST` / `SEEKDB_PORT` | `127.0.0.1` / `2881` | seekdb 连接 |
| `POWERCONTEXT_BASE_URL` | `http://127.0.0.1:8000` | PowerContext 服务地址 |
| `MINIMAX_API_KEY` | 空 | MiniMax 密钥（不提交） |
| `MINIMAX_BASE_URL` | `https://api.minimax.chat/v1` | OpenAI 兼容地址 |
| `MINIMAX_MODEL` | `MiniMax-Text-01` | 模型名 |
| `EMB_MODEL_DIR` | `models/all-MiniLM-L6-v2` | 本地向量模型目录 |

## 六、已知限制

- 向量化用本地 CPU 模型（all-MiniLM-L6-v2 INT8），中文语义能力一般；规格/代码里存在明确术语时靠全文召回兜底。
- 切片粒度是「Markdown 二级标题 / Python 顶层函数与类」，跨文件的调用链不会被自动补全。
- MiniMax 返回的代码以「完整文件」形式写回，不做三方 diff；写回前会把原文件备份到 `devlog/*.before`。
- 任务状态只保存文本进展（不含完整会话），符合题目「基础要求只要重启后能读取并使用」。
