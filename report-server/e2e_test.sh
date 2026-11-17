#!/bin/bash
# 模拟插件完整上报流程（与 background.js reportEvent 完全一致的调用方式）
set -e
K='xhs-report-2026'
B='http://124.221.115.174/xhs-report'
H="X-Api-Key: $K"

echo '== 1. login =='
curl -s -X POST -H "$H" -H 'Content-Type: application/json' \
  -d '{"phone":"22644212509","client":"chrome-extension"}' $B/api/report/login
echo

echo '== 2. task-start =='
RUN=$(curl -s -X POST -H "$H" -H 'Content-Type: application/json' \
  -d '{"phone":"22644212509","keywords":["聊天记录备份","换手机数据迁移"],"products":["ContextBuddy（上下文管家）"]}' \
  $B/api/report/task-start)
echo "$RUN"
RID=$(echo "$RUN" | sed 's/.*"run_id":\([0-9]*\).*/\1/')

echo '== 3. comment x2（一成一败）=='
curl -s -X POST -H "$H" -H 'Content-Type: application/json' -d "{\"phone\":\"22644212509\",\"run_id\":$RID,\"note_id\":\"68f3a1b2012345678901234\",\"note_url\":\"https://www.xiaohongshu.com/search_result/68f3a1b2012345678901234?xsec_token=ABxxx\",\"note_title\":\"换手机后微信聊天记录怎么找回\",\"note_author\":\"数码小助手\",\"keyword\":\"聊天记录备份\",\"product_name\":\"ContextBuddy（上下文管家）\",\"comment_text\":\"我之前也愁这个，后来本地归档搞定的\",\"ok\":true}" $B/api/report/comment
echo
curl -s -X POST -H "$H" -H 'Content-Type: application/json' -d "{\"phone\":\"22644212509\",\"run_id\":$RID,\"note_id\":\"68f3a1b2012345678909999\",\"note_url\":\"https://www.xiaohongshu.com/search_result/68f3a1b2012345678909999?xsec_token=AByyy\",\"note_title\":\"旧手机里的照片还有救吗\",\"note_author\":\"生活小妙招\",\"keyword\":\"换手机数据迁移\",\"product_name\":\"ContextBuddy（上下文管家）\",\"comment_text\":\"先别恢复出厂，我踩过坑\",\"ok\":false,\"error\":\"未找到发送按钮\"}" $B/api/report/comment
echo

echo '== 4. reply =='
curl -s -X POST -H "$H" -H 'Content-Type: application/json' -d "{\"phone\":\"22644212509\",\"run_id\":$RID,\"note_id\":\"68f3a1b2012345678901234\",\"note_url\":\"https://www.xiaohongshu.com/search_result/68f3a1b2012345678901234?xsec_token=ABxxx\",\"note_title\":\"换手机后微信聊天记录怎么找回\",\"target_name\":\"芒果小鹿\",\"target_content\":\"求问怎么备份微信聊天记录，怕换手机丢了\",\"reply_text\":\"我之前也怕，后来用本地归档存的，想了解的话私我\",\"ok\":true}" $B/api/report/reply
echo

echo '== 5. dm =='
curl -s -X POST -H "$H" -H 'Content-Type: application/json' -d "{\"phone\":\"22644212509\",\"run_id\":$RID,\"note_id\":\"68f3a1b2012345678901234\",\"note_url\":\"https://www.xiaohongshu.com/search_result/68f3a1b2012345678901234?xsec_token=ABxxx\",\"note_title\":\"换手机后微信聊天记录怎么找回\",\"target_name\":\"芒果小鹿\",\"target_user_id\":\"5f8a1c2e0000000001234567\",\"dm_text\":\"刚在视频下看到你说怕换手机丢记录，我之前也愁，后来本地归档搞定的，你想了解的话我细说\",\"ok\":true}" $B/api/report/dm
echo

echo '== 6. task-end =='
curl -s -X POST -H "$H" -H 'Content-Type: application/json' \
  -d "{\"phone\":\"22644212509\",\"run_id\":$RID,\"comments_total\":1,\"replies_total\":1,\"dms_total\":1}" $B/api/report/task-end
echo

echo '== 7. dashboard summary =='
curl -s "$B/api/dashboard?key=$K" | sed 's/,"comments".*//'
echo
echo '== 8. dashboard page =='
curl -s -o /dev/null -w 'GET /xhs-report/ -> %{http_code}\n' "$B/"
curl -s "$B/" | grep -c '运营看板' || true
