-- 记忆酒馆：seekdb 侧的表结构
-- seekdb 兼容 MySQL 协议；中文全文检索用 ngram 解析器（默认解析器按空格切词，中文会零命中）

CREATE DATABASE IF NOT EXISTS tavern DEFAULT CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS tavern.memory (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id VARCHAR(64) NOT NULL COMMENT '会话标识，对应 Dify 的 conversation_id',
  user_text TEXT NOT NULL COMMENT '玩家这一轮说了什么',
  npc_text TEXT COMMENT '老板娘这一轮的反应',
  tags VARCHAR(255) DEFAULT '' COMMENT '事件标签，例如 恶作剧/讨好/惊吓',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_session (session_id),
  FULLTEXT INDEX ft_memory (user_text, npc_text, tags) WITH PARSER ngram
);
