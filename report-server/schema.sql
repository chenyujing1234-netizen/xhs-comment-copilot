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
