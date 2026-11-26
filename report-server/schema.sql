-- 小红书评论获客插件 - 上报服务数据库结构
USE xiaoHongShu_plugin;

-- 客户端（按手机号标识）
CREATE TABLE IF NOT EXISTS devices (
  phone VARCHAR(20) PRIMARY KEY,
  first_seen DATETIME NOT NULL,
  last_seen DATETIME NOT NULL,
  login_count INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 任务会话：一次「开始任务 ~ 结束」为一条
CREATE TABLE IF NOT EXISTS task_runs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  phone VARCHAR(20) NOT NULL,
  keywords_json TEXT,
  products_json TEXT,
  keyword_total INT NOT NULL DEFAULT 0,
  product_total INT NOT NULL DEFAULT 0,
  comments_total INT NOT NULL DEFAULT 0,
  replies_total INT NOT NULL DEFAULT 0,
  dms_total INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'running',
  started_at DATETIME NOT NULL,
  ended_at DATETIME NULL,
  KEY idx_phone (phone),
  KEY idx_started (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 评论记录：每条主评论一行（含发布在哪个视频，便于日后回看是否有回复）
CREATE TABLE IF NOT EXISTS comment_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  phone VARCHAR(20) NOT NULL,
  run_id BIGINT NULL,
  note_id VARCHAR(64) NOT NULL DEFAULT '',
  note_url VARCHAR(500) NOT NULL DEFAULT '',
  note_title VARCHAR(255) NOT NULL DEFAULT '',
  note_author VARCHAR(64) NOT NULL DEFAULT '',
  keyword VARCHAR(64) NOT NULL DEFAULT '',
  product_name VARCHAR(128) NOT NULL DEFAULT '',
  comment_text VARCHAR(500) NOT NULL DEFAULT '',
  ok TINYINT NOT NULL DEFAULT 1,
  error_msg VARCHAR(255) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  KEY idx_phone (phone),
  KEY idx_created (created_at),
  KEY idx_note (note_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 回复记录：回复了哪个用户的哪条评论
CREATE TABLE IF NOT EXISTS reply_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  phone VARCHAR(20) NOT NULL,
  run_id BIGINT NULL,
  note_id VARCHAR(64) NOT NULL DEFAULT '',
  note_url VARCHAR(500) NOT NULL DEFAULT '',
  note_title VARCHAR(255) NOT NULL DEFAULT '',
  target_name VARCHAR(64) NOT NULL DEFAULT '',
  target_content VARCHAR(500) NOT NULL DEFAULT '',
  reply_text VARCHAR(500) NOT NULL DEFAULT '',
  ok TINYINT NOT NULL DEFAULT 1,
  error_msg VARCHAR(255) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  KEY idx_phone (phone),
  KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 私信记录：给哪个感兴趣的用户发了私信、内容是什么
CREATE TABLE IF NOT EXISTS dm_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  phone VARCHAR(20) NOT NULL,
  run_id BIGINT NULL,
  note_id VARCHAR(64) NOT NULL DEFAULT '',
  note_url VARCHAR(500) NOT NULL DEFAULT '',
  note_title VARCHAR(255) NOT NULL DEFAULT '',
  target_name VARCHAR(64) NOT NULL DEFAULT '',
  target_user_id VARCHAR(64) NOT NULL DEFAULT '',
  dm_text VARCHAR(500) NOT NULL DEFAULT '',
  ok TINYINT NOT NULL DEFAULT 1,
  error_msg VARCHAR(255) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  KEY idx_phone (phone),
  KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 产品信息：用户在产品页添加/编辑的产品，按手机号归属（全量同步，本地删除的服务端也删）
CREATE TABLE IF NOT EXISTS products (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  phone VARCHAR(20) NOT NULL,
  product_id VARCHAR(64) NOT NULL DEFAULT '',
  name VARCHAR(128) NOT NULL DEFAULT '',
  description TEXT,
  selected TINYINT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  UNIQUE KEY uk_phone_product (phone, product_id),
  KEY idx_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 登录事件
CREATE TABLE IF NOT EXISTS login_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  phone VARCHAR(20) NOT NULL,
  client VARCHAR(64) NOT NULL DEFAULT '',
  logged_in_at DATETIME NOT NULL,
  KEY idx_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 潜在客户：评论获客流程中被 AI 判为「感兴趣」的用户，按产品归属维护
-- 同一 (手机号, 产品, 用户) 重复出现时 upsert 合并，不覆盖人工维护的 status / note
CREATE TABLE IF NOT EXISTS leads (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  phone VARCHAR(20) NOT NULL,
  product_name VARCHAR(128) NOT NULL DEFAULT '',
  -- 去重键：优先 user_id，缺失时退化为 user_url（保证同一用户只产生一条记录）
  user_key VARCHAR(300) NOT NULL DEFAULT '',
  user_id VARCHAR(64) NOT NULL DEFAULT '',
  user_name VARCHAR(64) NOT NULL DEFAULT '',
  user_url VARCHAR(500) NOT NULL DEFAULT '',
  note_id VARCHAR(64) NOT NULL DEFAULT '',
  note_url VARCHAR(500) NOT NULL DEFAULT '',
  note_title VARCHAR(255) NOT NULL DEFAULT '',
  keyword VARCHAR(64) NOT NULL DEFAULT '',
  comment_content VARCHAR(500) NOT NULL DEFAULT '',
  interest_reason VARCHAR(500) NOT NULL DEFAULT '',
  source VARCHAR(20) NOT NULL DEFAULT 'comment',
  -- 已执行的触达动作（OR 合并，不会被后续上报清零）
  replied TINYINT NOT NULL DEFAULT 0,
  dmed TINYINT NOT NULL DEFAULT 0,
  -- 人工维护的跟进状态 / 备注（插件上报不覆盖）
  status VARCHAR(32) NOT NULL DEFAULT 'new',
  note TEXT,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  UNIQUE KEY uk_phone_product_user (phone, product_name, user_key),
  KEY idx_phone (phone),
  KEY idx_product (product_name),
  KEY idx_status (status),
  KEY idx_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 动作流水：统一记录每个手机号的出站动作（评论/回复/私信/关注/分享），
-- 用于「每日发送上限」计数。只统计成功（ok=1）的动作，避免失败消耗额度。
-- 今日已发数 = COUNT(*) WHERE phone=? AND ok=1 AND created_at >= CURDATE()
CREATE TABLE IF NOT EXISTS action_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  phone VARCHAR(20) NOT NULL,
  action_type VARCHAR(20) NOT NULL,
  note_id VARCHAR(64) NOT NULL DEFAULT '',
  target_user_id VARCHAR(64) NOT NULL DEFAULT '',
  ok TINYINT NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL,
  KEY idx_phone_date (phone, created_at),
  KEY idx_type (action_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
