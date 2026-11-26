"""小红书评论获客插件 - 运行数据上报服务。

职责：
1. 接收插件上报的运行事件（登录 / 任务开始 / 评论 / 回复 / 私信 / 任务结束 / 产品同步），写入 MySQL；
2. 提供运营看板页面，展示插件运行情况（评论数、回复数、视频、产品、关键词等）。

部署：uvicorn app:app --host 0.0.0.0 --port 8081（systemd 托管）。
"""

import json
import os
from datetime import datetime, timedelta

import pymysql
from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel

# ===== 配置（可用环境变量覆盖；密码等敏感配置只从环境变量读取，不写默认值）=====
DB_CONFIG = {
    'host': os.environ.get('XHS_DB_HOST', '114.55.254.123'),
    'port': int(os.environ.get('XHS_DB_PORT', '3306')),
    'user': os.environ.get('XHS_DB_USER', 'chenyujing'),
    'password': os.environ.get('XHS_DB_PASS', ''),
    'database': os.environ.get('XHS_DB_NAME', 'xiaoHongShu_plugin'),
    'charset': 'utf8mb4',
    'cursorclass': pymysql.cursors.DictCursor,
    'connect_timeout': 10,
}
API_KEY = os.environ.get('XHS_API_KEY', 'xhs-report-2026')

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = FastAPI(title='xhs-plugin-report')


def get_conn():
    return pymysql.connect(**DB_CONFIG)


def now_str():
    return datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def check_api_key(x_api_key: str = Header(default='')):
    if x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail='invalid api key')


def fmt_dt(value, pattern='%Y-%m-%d %H:%M:%S'):
    return value.strftime(pattern) if value else ''


# ===== 上报数据模型 =====
class LoginReport(BaseModel):
    phone: str
    client: str = ''


class TaskStartReport(BaseModel):
    phone: str
    keywords: list = []
    products: list = []


class CommentReport(BaseModel):
    phone: str
    run_id: int | None = None
    note_id: str = ''
    note_url: str = ''
    note_title: str = ''
    note_author: str = ''
    keyword: str = ''
    product_name: str = ''
    comment_text: str = ''
    ok: bool = True
    error: str = ''


class ReplyReport(BaseModel):
    phone: str
    run_id: int | None = None
    note_id: str = ''
    note_url: str = ''
    note_title: str = ''
    target_name: str = ''
    target_content: str = ''
    reply_text: str = ''
    ok: bool = True
    error: str = ''


class TaskEndReport(BaseModel):
    phone: str
    run_id: int
    comments_total: int = 0
    replies_total: int = 0
    dms_total: int = 0


class DMReport(BaseModel):
    """私信记录：给感兴趣的用户发的一对一私信"""
    phone: str
    run_id: int | None = None
    note_id: str = ''
    note_url: str = ''
    note_title: str = ''
    target_name: str = ''
    target_user_id: str = ''
    dm_text: str = ''
    ok: bool = True
    error: str = ''


class ProductSyncReport(BaseModel):
    """产品全量同步：products 为 [{id, name, description, selected}, ...]"""
    phone: str
    products: list = []


class LeadReport(BaseModel):
    """潜在客户上报：评论获客流程中 AI 判为感兴趣的用户。

    同一 (phone, product_name, user_key) 重复上报走 upsert 合并：
    - 触达动作 replied/dmed 按 OR 合并，不会被清零；
    - 人工维护的 status / note 不会被插件上报覆盖。
    仅上报动作（如回复/私信成功）时也调用本接口，只带 replied/dmed 标志。
    """
    phone: str
    product_name: str = ''
    user_id: str = ''
    user_name: str = ''
    user_url: str = ''
    note_id: str = ''
    note_url: str = ''
    note_title: str = ''
    keyword: str = ''
    comment_content: str = ''
    interest_reason: str = ''
    source: str = 'comment'
    replied: bool = False
    dmed: bool = False


class LeadUpdate(BaseModel):
    """看板人工维护：更新跟进状态 / 备注。"""
    id: int
    status: str = ''
    note: str = ''


def lead_row_to_dict(row):
    return {
        'id': row['id'],
        'phone': row['phone'],
        'product_name': row['product_name'] or '',
        'user_id': row['user_id'] or '',
        'user_name': row['user_name'] or '',
        'user_url': row['user_url'] or '',
        'note_id': row['note_id'] or '',
        'note_url': row['note_url'] or '',
        'note_title': row['note_title'] or '',
        'keyword': row['keyword'] or '',
        'comment_content': row['comment_content'] or '',
        'interest_reason': row['interest_reason'] or '',
        'source': row['source'] or '',
        'replied': bool(row['replied']),
        'dmed': bool(row['dmed']),
        'status': row['status'] or 'new',
        'note': row['note'] or '',
        'created_at': fmt_dt(row['created_at']),
        'updated_at': fmt_dt(row['updated_at']),
    }


def compute_user_key(user_id, user_url, user_name):
    """去重键：优先 user_id，退化为 user_url，再退化为 user_name。"""
    for v in (user_id, user_url, user_name):
        v = (v or '').strip()
        if v:
            return v[:300]
    return ''


class ActionReport(BaseModel):
    """出站动作流水：评论/回复/私信/关注/分享，用于每日发送上限计数。"""
    phone: str
    action_type: str          # comment / reply / dm / follow / share
    note_id: str = ''
    target_user_id: str = ''
    ok: bool = True


def today_action_counts(cur, phone=None):
    """今日（服务端日期）已成功动作数，按类型分组；phone 为空则统计全部手机号。"""
    if phone:
        cur.execute(
            "SELECT action_type, COUNT(*) AS c FROM action_logs "
            "WHERE phone = %s AND ok = 1 AND created_at >= CURDATE() GROUP BY action_type",
            (phone,),
        )
    else:
        cur.execute(
            "SELECT action_type, COUNT(*) AS c FROM action_logs "
            "WHERE ok = 1 AND created_at >= CURDATE() GROUP BY action_type",
        )
    return {row['action_type']: int(row['c']) for row in cur.fetchall()}


def today_action_by_phone(cur):
    """今日各手机号的成功动作总数。"""
    cur.execute(
        "SELECT phone, COUNT(*) AS c FROM action_logs "
        "WHERE ok = 1 AND created_at >= CURDATE() GROUP BY phone"
    )
    return {row['phone']: int(row['c']) for row in cur.fetchall()}


def upsert_device(conn, phone):
    with conn.cursor() as cur:
        cur.execute(
            'INSERT INTO devices (phone, first_seen, last_seen, login_count) '
            'VALUES (%s, %s, %s, 1) '
            'ON DUPLICATE KEY UPDATE last_seen = VALUES(last_seen), login_count = login_count + 1',
            (phone, now_str(), now_str()),
        )


# ===== 上报接口 =====
@app.post('/api/report/product-sync', dependencies=[Depends(check_api_key)])
def report_product_sync(data: ProductSyncReport):
    """产品信息全量同步：按手机号 upsert，本地已删除的产品在服务端同步删除。"""
    phone = data.phone.strip()
    if not phone:
        raise HTTPException(status_code=400, detail='phone required')
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            now = now_str()
            keep_ids = []
            for p in data.products:
                if not isinstance(p, dict):
                    continue
                pid = str(p.get('id') or '')[:64]
                name = str(p.get('name') or '')[:128]
                if not pid or not name:
                    continue
                keep_ids.append(pid)
                cur.execute(
                    'INSERT INTO products (phone, product_id, name, description, selected, created_at, updated_at) '
                    'VALUES (%s, %s, %s, %s, %s, %s, %s) '
                    'ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), '
                    'selected = VALUES(selected), updated_at = VALUES(updated_at)',
                    (
                        phone,
                        pid,
                        name,
                        str(p.get('description') or ''),
                        1 if p.get('selected') else 0,
                        now,
                        now,
                    ),
                )
            # 本地已删除的产品，服务端同步删除
            if keep_ids:
                fmt = ','.join(['%s'] * len(keep_ids))
                cur.execute(
                    'DELETE FROM products WHERE phone = %s AND product_id NOT IN (' + fmt + ')',
                    [phone] + keep_ids,
                )
            else:
                cur.execute('DELETE FROM products WHERE phone = %s', (phone,))
        conn.commit()
    finally:
        conn.close()
    return {'ok': True, 'synced': len(keep_ids)}

@app.get('/api/products', dependencies=[Depends(check_api_key)])
def get_products(phone: str = Query(...)):
    """按手机号拉取产品库：插件登录后调用，产品以服务端为准同步到本地。"""
    phone = phone.strip()
    if not phone:
        raise HTTPException(status_code=400, detail='phone required')
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                'SELECT product_id, name, description, selected, updated_at '
                'FROM products WHERE phone = %s ORDER BY updated_at DESC, id DESC',
                (phone,),
            )
            products = [
                {
                    'id': row['product_id'],
                    'name': row['name'] or '',
                    'description': row['description'] or '',
                    'selected': bool(row['selected']),
                }
                for row in cur.fetchall()
            ]
    finally:
        conn.close()
    return {'ok': True, 'phone': phone, 'products': products}


@app.post('/api/report/login', dependencies=[Depends(check_api_key)])
def report_login(data: LoginReport):
    phone = data.phone.strip()
    if not phone:
        raise HTTPException(status_code=400, detail='phone required')
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                'INSERT INTO login_logs (phone, client, logged_in_at) VALUES (%s, %s, %s)',
                (phone, data.client[:64], now_str()),
            )
        upsert_device(conn, phone)
        conn.commit()
    finally:
        conn.close()
    return {'ok': True}


@app.post('/api/report/task-start', dependencies=[Depends(check_api_key)])
def report_task_start(data: TaskStartReport):
    phone = data.phone.strip()
    if not phone:
        raise HTTPException(status_code=400, detail='phone required')
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                'INSERT INTO task_runs '
                '(phone, keywords_json, products_json, keyword_total, product_total, status, started_at) '
                'VALUES (%s, %s, %s, %s, %s, %s, %s)',
                (
                    phone,
                    json.dumps(data.keywords, ensure_ascii=False),
                    json.dumps(data.products, ensure_ascii=False),
                    len(data.keywords),
                    len(data.products),
                    'running',
                    now_str(),
                ),
            )
            run_id = cur.lastrowid
        upsert_device(conn, phone)
        conn.commit()
    finally:
        conn.close()
    return {'ok': True, 'run_id': run_id}


@app.post('/api/report/comment', dependencies=[Depends(check_api_key)])
def report_comment(data: CommentReport):
    if not data.phone.strip():
        raise HTTPException(status_code=400, detail='phone required')
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                'INSERT INTO comment_logs '
                '(phone, run_id, note_id, note_url, note_title, note_author, keyword, product_name, comment_text, ok, error_msg, created_at) '
                'VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)',
                (
                    data.phone.strip(),
                    data.run_id,
                    data.note_id[:64],
                    data.note_url[:500],
                    data.note_title[:255],
                    data.note_author[:64],
                    data.keyword[:64],
                    data.product_name[:128],
                    data.comment_text[:500],
                    1 if data.ok else 0,
                    data.error[:255],
                    now_str(),
                ),
            )
        conn.commit()
    finally:
        conn.close()
    return {'ok': True}


@app.post('/api/report/reply', dependencies=[Depends(check_api_key)])
def report_reply(data: ReplyReport):
    if not data.phone.strip():
        raise HTTPException(status_code=400, detail='phone required')
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                'INSERT INTO reply_logs '
                '(phone, run_id, note_id, note_url, note_title, target_name, target_content, reply_text, ok, error_msg, created_at) '
                'VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)',
                (
                    data.phone.strip(),
                    data.run_id,
                    data.note_id[:64],
                    data.note_url[:500],
                    data.note_title[:255],
                    data.target_name[:64],
                    data.target_content[:500],
                    data.reply_text[:500],
                    1 if data.ok else 0,
                    data.error[:255],
                    now_str(),
                ),
            )
        conn.commit()
    finally:
        conn.close()
    return {'ok': True}


@app.post('/api/report/task-end', dependencies=[Depends(check_api_key)])
def report_task_end(data: TaskEndReport):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                'UPDATE task_runs SET status = %s, comments_total = %s, replies_total = %s, dms_total = %s, ended_at = %s '
                'WHERE id = %s AND phone = %s',
                (
                    'finished',
                    data.comments_total,
                    data.replies_total,
                    data.dms_total,
                    now_str(),
                    data.run_id,
                    data.phone.strip(),
                ),
            )
        conn.commit()
    finally:
        conn.close()
    return {'ok': True}


@app.post('/api/report/dm', dependencies=[Depends(check_api_key)])
def report_dm(data: DMReport):
    if not data.phone.strip():
        raise HTTPException(status_code=400, detail='phone required')
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                'INSERT INTO dm_logs '
                '(phone, run_id, note_id, note_url, note_title, target_name, target_user_id, dm_text, ok, error_msg, created_at) '
                'VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)',
                (
                    data.phone.strip(),
                    data.run_id,
                    data.note_id[:64],
                    data.note_url[:500],
                    data.note_title[:255],
                    data.target_name[:64],
                    data.target_user_id[:64],
                    data.dm_text[:500],
                    1 if data.ok else 0,
                    data.error[:255],
                    now_str(),
                ),
            )
        conn.commit()
    finally:
        conn.close()
    return {'ok': True}


@app.post('/api/report/lead', dependencies=[Depends(check_api_key)])
def report_lead(data: LeadReport):
    """潜在客户上报（upsert 合并）。"""
    phone = data.phone.strip()
    if not phone:
        raise HTTPException(status_code=400, detail='phone required')
    product_name = (data.product_name or '')[:128]
    user_id = (data.user_id or '')[:64]
    user_url = (data.user_url or '')[:500]
    user_name = (data.user_name or '')[:64]
    user_key = compute_user_key(user_id, user_url, user_name)
    now = now_str()
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                'INSERT INTO leads '
                '(phone, product_name, user_key, user_id, user_name, user_url, '
                'note_id, note_url, note_title, keyword, comment_content, interest_reason, source, '
                'replied, dmed, status, created_at, updated_at) '
                'VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) '
                'ON DUPLICATE KEY UPDATE '
                'user_id = IF(VALUES(user_id) <> \'\', VALUES(user_id), user_id), '
                'user_name = IF(VALUES(user_name) <> \'\', VALUES(user_name), user_name), '
                'user_url = IF(VALUES(user_url) <> \'\', VALUES(user_url), user_url), '
                'note_id = IF(VALUES(note_id) <> \'\', VALUES(note_id), note_id), '
                'note_url = IF(VALUES(note_url) <> \'\', VALUES(note_url), note_url), '
                'note_title = IF(VALUES(note_title) <> \'\', VALUES(note_title), note_title), '
                'keyword = IF(VALUES(keyword) <> \'\', VALUES(keyword), keyword), '
                'comment_content = IF(VALUES(comment_content) <> \'\', VALUES(comment_content), comment_content), '
                'interest_reason = IF(VALUES(interest_reason) <> \'\', VALUES(interest_reason), interest_reason), '
                'source = IF(VALUES(source) <> \'\', VALUES(source), source), '
                'replied = GREATEST(replied, VALUES(replied)), '
                'dmed = GREATEST(dmed, VALUES(dmed)), '
                'updated_at = VALUES(updated_at)',
                (
                    phone, product_name, user_key, user_id, user_name, user_url,
                    (data.note_id or '')[:64], (data.note_url or '')[:500], (data.note_title or '')[:255],
                    (data.keyword or '')[:64], (data.comment_content or '')[:500],
                    (data.interest_reason or '')[:500], (data.source or 'comment')[:20],
                    1 if data.replied else 0, 1 if data.dmed else 0,
                    'new', now, now,
                ),
            )
        conn.commit()
    finally:
        conn.close()
    return {'ok': True}


@app.post('/api/report/action', dependencies=[Depends(check_api_key)])
def report_action(data: ActionReport):
    """上报一条出站动作（评论/回复/私信/关注/分享），用于每日上限计数。"""
    phone = data.phone.strip()
    if not phone:
        raise HTTPException(status_code=400, detail='phone required')
    action_type = (data.action_type or '').strip()[:20]
    if not action_type:
        raise HTTPException(status_code=400, detail='action_type required')
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                'INSERT INTO action_logs (phone, action_type, note_id, target_user_id, ok, created_at) '
                'VALUES (%s,%s,%s,%s,%s,%s)',
                (
                    phone, action_type,
                    (data.note_id or '')[:64], (data.target_user_id or '')[:64],
                    1 if data.ok else 0, now_str(),
                ),
            )
        conn.commit()
    finally:
        conn.close()
    return {'ok': True}


@app.get('/api/quota', dependencies=[Depends(check_api_key)])
def get_quota(phone: str = Query(default='')):
    """查询某手机号今日已成功发送的出站动作总数（按类型分组）。"""
    if not phone:
        raise HTTPException(status_code=400, detail='phone required')
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            counts = today_action_counts(cur, phone)
            today_total = sum(counts.values())
            cur.execute('SELECT CURDATE() AS d')
            date_row = cur.fetchone() or {}
    finally:
        conn.close()
    return {
        'ok': True,
        'phone': phone,
        'date': str(date_row.get('d')) if date_row.get('d') is not None else '',
        'today_total': today_total,
        'by_type': counts,
    }


def _check_key(key):
    if key != API_KEY:
        raise HTTPException(status_code=401, detail='invalid key')


@app.get('/api/leads')
def get_leads(key: str = Query(default=''), product: str = Query(default=''),
              status: str = Query(default=''), phone: str = Query(default=''),
              limit: int = Query(default=500, ge=1, le=1000)):
    """看板查询潜在客户：可按产品 / 状态 / 手机号过滤。"""
    _check_key(key)
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            where = []
            params = []
            if product:
                where.append('product_name = %s')
                params.append(product)
            if status:
                where.append('status = %s')
                params.append(status)
            if phone:
                where.append('phone = %s')
                params.append(phone)
            sql = ('SELECT id, phone, product_name, user_key, user_id, user_name, user_url, '
                   'note_id, note_url, note_title, keyword, comment_content, interest_reason, source, '
                   'replied, dmed, status, note, created_at, updated_at FROM leads')
            if where:
                sql += ' WHERE ' + ' AND '.join(where)
            sql += ' ORDER BY updated_at DESC, id DESC LIMIT %s'
            params.append(limit)
            cur.execute(sql, params)
            rows = cur.fetchall()
            leads = [lead_row_to_dict(r) for r in rows]
            # 同时返回当前过滤范围内的状态分布
            cur.execute(
                'SELECT status, COUNT(*) AS c FROM leads' +
                (' WHERE ' + ' AND '.join(where) if where else '') +
                ' GROUP BY status',
                params[:-1] if where else [],
            )
            status_counts = {row['status'] or 'new': int(row['c']) for row in cur.fetchall()}
    finally:
        conn.close()
    return {'ok': True, 'leads': leads, 'status_counts': status_counts}


@app.post('/api/lead/update')
def update_lead(data: LeadUpdate, key: str = Query(default='')):
    """看板人工维护：更新跟进状态 / 备注。"""
    _check_key(key)
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                'UPDATE leads SET status = %s, note = %s, updated_at = %s WHERE id = %s',
                ((data.status or 'new')[:32], data.note, now_str(), data.id),
            )
            affected = cur.rowcount
        conn.commit()
    finally:
        conn.close()
    return {'ok': True, 'affected': affected}


# ===== 看板数据接口 =====
def count_rows(cur, table, cond=''):
    cur.execute('SELECT COUNT(*) AS c, COALESCE(SUM(ok), 0) AS s FROM ' + table + ' ' + cond)
    row = cur.fetchone() or {'c': 0, 's': 0}
    return int(row['c'] or 0), int(row['s'] or 0)


@app.get('/api/dashboard')
def dashboard(key: str = Query(default='')):
    if key != API_KEY:
        raise HTTPException(status_code=401, detail='invalid key')
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            c_total, c_ok = count_rows(cur, 'comment_logs')
            r_total, r_ok = count_rows(cur, 'reply_logs')
            d_total, d_ok = count_rows(cur, 'dm_logs')
            c_today, _ = count_rows(cur, 'comment_logs', 'WHERE created_at >= CURDATE()')
            r_today, _ = count_rows(cur, 'reply_logs', 'WHERE created_at >= CURDATE()')
            d_today, _ = count_rows(cur, 'dm_logs', 'WHERE created_at >= CURDATE()')

            # 最近 7 天趋势
            cur.execute(
                'SELECT DATE(created_at) AS d, COUNT(*) AS c FROM comment_logs '
                'WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY) GROUP BY DATE(created_at)'
            )
            c_trend = {str(row['d']): int(row['c']) for row in cur.fetchall()}
            cur.execute(
                'SELECT DATE(created_at) AS d, COUNT(*) AS c FROM reply_logs '
                'WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY) GROUP BY DATE(created_at)'
            )
            r_trend = {str(row['d']): int(row['c']) for row in cur.fetchall()}
            cur.execute(
                'SELECT DATE(created_at) AS d, COUNT(*) AS c FROM dm_logs '
                'WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY) GROUP BY DATE(created_at)'
            )
            d_trend = {str(row['d']): int(row['c']) for row in cur.fetchall()}
            days = [(datetime.now().date() - timedelta(days=i)).strftime('%Y-%m-%d') for i in range(6, -1, -1)]
            trend = [
                {'date': d, 'comments': c_trend.get(d, 0), 'replies': r_trend.get(d, 0), 'dms': d_trend.get(d, 0)}
                for d in days
            ]

            # 按产品 / 关键词统计
            cur.execute(
                'SELECT product_name, COUNT(*) AS c FROM comment_logs '
                'GROUP BY product_name ORDER BY c DESC LIMIT 10'
            )
            by_product = [{'name': row['product_name'] or '(未知)', 'count': int(row['c'])} for row in cur.fetchall()]
            cur.execute(
                'SELECT keyword, COUNT(*) AS c FROM comment_logs '
                'GROUP BY keyword ORDER BY c DESC LIMIT 10'
            )
            by_keyword = [{'name': row['keyword'] or '(未知)', 'count': int(row['c'])} for row in cur.fetchall()]

            # 客户端（含今日已发出站动作数，用于每日上限看板）
            outbound_by_phone = today_action_by_phone(cur)
            cur.execute('SELECT phone, first_seen, last_seen, login_count FROM devices ORDER BY last_seen DESC')
            devices = [
                {
                    'phone': row['phone'],
                    'first_seen': fmt_dt(row['first_seen']),
                    'last_seen': fmt_dt(row['last_seen']),
                    'login_count': int(row['login_count'] or 0),
                    'today_outbound': outbound_by_phone.get(row['phone'], 0),
                }
                for row in cur.fetchall()
            ]
            outbound_today = sum(outbound_by_phone.values())

            # 产品库（各客户端在产品页维护的产品信息）
            cur.execute(
                'SELECT phone, product_id, name, description, selected, created_at, updated_at '
                'FROM products ORDER BY updated_at DESC, id DESC LIMIT 100'
            )
            products = [
                {
                    'phone': row['phone'],
                    'name': row['name'] or '',
                    'description': row['description'] or '',
                    'selected': bool(row['selected']),
                    'created_at': fmt_dt(row['created_at']),
                    'updated_at': fmt_dt(row['updated_at']),
                }
                for row in cur.fetchall()
            ]

            # 最近任务
            cur.execute(
                'SELECT id, phone, keyword_total, product_total, comments_total, replies_total, dms_total, status, started_at, ended_at '
                'FROM task_runs ORDER BY id DESC LIMIT 20'
            )
            runs = [
                {
                    'id': row['id'],
                    'phone': row['phone'],
                    'keyword_total': int(row['keyword_total'] or 0),
                    'product_total': int(row['product_total'] or 0),
                    'comments_total': int(row['comments_total'] or 0),
                    'replies_total': int(row['replies_total'] or 0),
                    'dms_total': int(row['dms_total'] or 0),
                    'status': row['status'],
                    'started_at': fmt_dt(row['started_at']),
                    'ended_at': fmt_dt(row['ended_at']),
                }
                for row in cur.fetchall()
            ]

            # 最近评论明细
            cur.execute(
                'SELECT created_at, phone, product_name, keyword, note_title, note_url, comment_text, ok, error_msg '
                'FROM comment_logs ORDER BY id DESC LIMIT 50'
            )
            comments = [
                {
                    'time': fmt_dt(row['created_at'], '%m-%d %H:%M:%S'),
                    'phone': row['phone'],
                    'product': row['product_name'] or '',
                    'keyword': row['keyword'] or '',
                    'title': row['note_title'] or '',
                    'url': row['note_url'] or '',
                    'text': row['comment_text'] or '',
                    'ok': bool(row['ok']),
                    'error': row['error_msg'] or '',
                }
                for row in cur.fetchall()
            ]

            # 最近回复明细
            cur.execute(
                'SELECT created_at, phone, target_name, target_content, reply_text, note_title, note_url, ok, error_msg '
                'FROM reply_logs ORDER BY id DESC LIMIT 50'
            )
            replies = [
                {
                    'time': fmt_dt(row['created_at'], '%m-%d %H:%M:%S'),
                    'phone': row['phone'],
                    'name': row['target_name'] or '',
                    'target': row['target_content'] or '',
                    'text': row['reply_text'] or '',
                    'title': row['note_title'] or '',
                    'url': row['note_url'] or '',
                    'ok': bool(row['ok']),
                    'error': row['error_msg'] or '',
                }
                for row in cur.fetchall()
            ]
            # 最近私信明细
            cur.execute(
                'SELECT created_at, phone, target_name, target_user_id, dm_text, note_title, note_url, ok, error_msg '
                'FROM dm_logs ORDER BY id DESC LIMIT 50'
            )
            dms = [
                {
                    'time': fmt_dt(row['created_at'], '%m-%d %H:%M:%S'),
                    'phone': row['phone'],
                    'name': row['target_name'] or '',
                    'user_id': row['target_user_id'] or '',
                    'text': row['dm_text'] or '',
                    'title': row['note_title'] or '',
                    'url': row['note_url'] or '',
                    'ok': bool(row['ok']),
                    'error': row['error_msg'] or '',
                }
                for row in cur.fetchall()
            ]

            # 潜在客户：汇总 + 按产品分布 + 最近 200 条
            cur.execute('SELECT COUNT(*) AS c FROM leads')
            lead_total = int((cur.fetchone() or {}).get('c') or 0)
            cur.execute('SELECT status, COUNT(*) AS c FROM leads GROUP BY status')
            lead_status_counts = {row['status'] or 'new': int(row['c']) for row in cur.fetchall()}
            cur.execute(
                'SELECT product_name, COUNT(*) AS c FROM leads GROUP BY product_name ORDER BY c DESC'
            )
            leads_by_product = [
                {'name': row['product_name'] or '(未知)', 'count': int(row['c'])}
                for row in cur.fetchall()
            ]
            cur.execute(
                'SELECT id, phone, product_name, user_key, user_id, user_name, user_url, '
                'note_id, note_url, note_title, keyword, comment_content, interest_reason, source, '
                'replied, dmed, status, note, created_at, updated_at '
                'FROM leads ORDER BY updated_at DESC, id DESC LIMIT 200'
            )
            leads = [lead_row_to_dict(r) for r in cur.fetchall()]
    finally:
        conn.close()

    return {
        'ok': True,
        'summary': {
            'comment_total': c_total,
            'comment_ok': c_ok,
            'reply_total': r_total,
            'reply_ok': r_ok,
            'dm_total': d_total,
            'dm_ok': d_ok,
            'comment_today': c_today,
            'reply_today': r_today,
            'dm_today': d_today,
            'outbound_today': outbound_today,
            'device_count': len(devices),
            'product_count': len(products),
            'running_runs': sum(1 for r in runs if r['status'] == 'running'),
            'lead_count': lead_total,
            'lead_new': lead_status_counts.get('new', 0),
        },
        'trend': trend,
        'by_product': by_product,
        'by_keyword': by_keyword,
        'devices': devices,
        'products': products,
        'runs': runs,
        'comments': comments,
        'replies': replies,
        'leads': leads,
        'leads_by_product': leads_by_product,
        'lead_status_counts': lead_status_counts,
        'dms': dms,
    }


@app.get('/health')
def health():
    return {'ok': True}


@app.get('/')
def index():
    return FileResponse(os.path.join(BASE_DIR, 'dashboard.html'))


@app.get('/privacy')
@app.get('/privacy.html')
def privacy():
    # 商店上架要求的公开隐私政策（无需鉴权）
    return FileResponse(os.path.join(BASE_DIR, 'privacy.html'))
