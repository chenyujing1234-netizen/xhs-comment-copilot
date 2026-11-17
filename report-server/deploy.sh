#!/bin/bash
set -e
cd /opt/xhs-report
# 敏感配置从 .env 读取（XHS_DB_PASS 等，该文件不进仓库）
set -a; . /opt/xhs-report/.env; set +a
# 执行 schema（新表直接建；已存在的表 IF NOT EXISTS 不会补列，下面用 ALTER 幂等补齐）
mysql -h114.55.254.123 -P3306 -uchenyujing -p"$XHS_DB_PASS" --default-character-set=utf8mb4 xiaoHongShu_plugin < schema.sql
mysql -h114.55.254.123 -P3306 -uchenyujing -p"$XHS_DB_PASS" --default-character-set=utf8mb4 xiaoHongShu_plugin \
  -e "ALTER TABLE task_runs ADD COLUMN dms_total INT NOT NULL DEFAULT 0 AFTER replies_total" 2>/dev/null || true
systemctl restart xhs-report
sleep 2
echo "service: $(systemctl is-active xhs-report)"
curl -s http://127.0.0.1:8081/health
echo
