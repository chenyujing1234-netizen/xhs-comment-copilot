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

            # 客户端
            cur.execute('SELECT phone, first_seen, last_seen, login_count FROM devices ORDER BY last_seen DESC')
            devices = [
                {
                    'phone': row['phone'],
                    'first_seen': fmt_dt(row['first_seen']),
                    'last_seen': fmt_dt(row['last_seen']),
                    'login_count': int(row['login_count'] or 0),
                }
                for row in cur.fetchall()
            ]

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
            'device_count': len(devices),
            'product_count': len(products),
            'running_runs': sum(1 for r in runs if r['status'] == 'running'),
        },
        'trend': trend,
        'by_product': by_product,
        'by_keyword': by_keyword,
        'devices': devices,
        'products': products,
        'runs': runs,
        'comments': comments,
        'replies': replies,
        'dms': dms,
    }


@app.get('/health')
def health():
    return {'ok': True}


@app.get('/')
def index():
    return FileResponse(os.path.join(BASE_DIR, 'dashboard.html'))
