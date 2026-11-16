#!/bin/bash
set -e
cd /opt/xhs-report
# 敏感配置从 .env 读取（XHS_DB_PASS 等，该文件不进仓库）
set -a; . /opt/xhs-report/.env; set +a
# 执行 schema（products 为新增表，IF NOT EXISTS 不影响已有表）
mysql -h114.55.254.123 -P3306 -uchenyujing -p"$XHS_DB_PASS" --default-character-set=utf8mb4 xiaoHongShu_plugin < schema.sql
systemctl restart xhs-report
sleep 2
echo "service: $(systemctl is-active xhs-report)"
curl -s http://127.0.0.1:8081/health
echo
