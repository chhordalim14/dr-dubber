"""Gemini Web Router service for DR Dubber.

Talks to gemini.google.com with each Gmail's saved sign-in cookies (no API key, no browser),
through the gemini_webapi library. One request at a time per account; requests without a
chosen account go to the next free one (round robin). Google refreshes the cookies now and
then: the fresh ones are written back so the next start still works.

  python gemini_web_server.py --dir <storage/gemini_web> --port 8790

<dir>/accounts.json      [{id, email, enabled}]        (written by DR Dubber)
<dir>/cookies/<id>.json  {cookie name: value}          (written at sign-in, refreshed here)

HTTP (127.0.0.1 only):
  GET  /status                 accounts with state, served count, credits
  POST /reload                 re-read accounts.json (after an account is added/removed)
  POST /generate               {prompt, files?: [paths], account?: id, timeoutSec?}
  POST /quota                  {account?: id} refresh the credits shown
"""
import argparse
import asyncio
import json
import os
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ap = argparse.ArgumentParser()
ap.add_argument("--dir", required=True)
ap.add_argument("--port", type=int, default=8790)
args = ap.parse_args()

BASE = args.dir
COOKIE_DIR = os.path.join(BASE, "cookies")
os.makedirs(COOKIE_DIR, exist_ok=True)
# The library caches rotated cookies here (keyed by account), instead of the user's home.
os.environ.setdefault("GEMINI_COOKIE_PATH", os.path.join(BASE, "cookie_cache"))

from loguru import logger  # noqa: E402
from gemini_webapi import GeminiClient  # noqa: E402
from gemini_webapi import exceptions as gx  # noqa: E402

logger.remove()
logger.add(sys.stderr, level="WARNING", format="[gemini_webapi] {level} {message}")

loop = asyncio.new_event_loop()
accounts = {}  # id -> Account
order = []  # ids in round-robin order
rr = {"next": 0}


def log(msg):
    print(f"[GeminiWeb] {msg}", flush=True)


def read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def mask_proxy(url):
    """The proxy as the page may show it: the password left out."""
    if not url:
        return None
    import re
    return re.sub(r"//([^:@/]*):[^@/]*@", r"//\1:****@", url)


async def outside_ip(proxy, timeout=20):
    """The public address requests leave from (through the proxy, if any)."""
    from curl_cffi.requests import AsyncSession
    async with AsyncSession(proxy=proxy, impersonate="chrome") as s:
        r = await s.get("https://api.ipify.org?format=json", timeout=timeout)
        return r.json().get("ip")


_direct_ip_cache = {"ip": None, "at": 0}


async def direct_outside_ip():
    now = time.time()
    if _direct_ip_cache["ip"] and now - _direct_ip_cache["at"] < 300:
        return _direct_ip_cache["ip"]
    try:
        ip = await outside_ip(None, timeout=6)
        if ip:
            _direct_ip_cache["ip"] = ip
            _direct_ip_cache["at"] = now
        return ip
    except Exception:
        return _direct_ip_cache["ip"]


async def test_proxies(body):
    """Checks candidate proxies in parallel: each must give one steady outside IP that no other
    Gmail (and not this PC) has, open gemini.google.com, and do it twice within maxMs.

    No Gmail's cookies are ever sent here: testing 200 free proxies with a session would show
    Google that Gmail from 200 addresses in a minute. The chosen proxy meets the session only
    when the account is started through it (one address at a time)."""
    from curl_cffi.requests import AsyncSession
    candidates = [p for p in (body.get("proxies") or []) if isinstance(p, str) and p.strip()]
    need = max(1, int(body.get("need") or 3))
    timeout_sec = max(2.0, float(body.get("timeoutSec") or 5.0))
    max_ms = max(1000, int(body.get("maxMs") or 6000))
    rounds = max(1, min(3, int(body.get("rounds") or 2)))
    acc_id = body.get("account") or None
    avoid_ips = set(str(x).strip() for x in (body.get("avoidIps") or []) if x)
    direct_ip = await direct_outside_ip()
    if direct_ip:
        avoid_ips.add(direct_ip)
    for aid, acc in accounts.items():
        if acc.ip and (not acc_id or aid != acc_id or acc.proxy):
            avoid_ips.add(acc.ip)

    seen_ips = set(avoid_ips)
    working = []
    batch_size = 60

    async def one_round(s):
        t0 = time.time()
        r = await s.get("https://api.ipify.org?format=json", timeout=timeout_sec)
        if r.status_code != 200:
            return None, None
        ip = (r.json() or {}).get("ip")
        g = await s.get("https://gemini.google.com/app", timeout=timeout_sec + 2, allow_redirects=True)
        if g.status_code != 200 or "gemini" not in g.text.lower():
            return None, None
        return ip, int((time.time() - t0) * 1000)

    async def check_one(p):
        try:
            async with AsyncSession(proxy=p, impersonate="chrome") as s:
                ip = None
                times = []
                for k in range(rounds):
                    if k:
                        await asyncio.sleep(1.5)
                    got, ms = await one_round(s)
                    # A proxy whose address changes between two asks (a rotating gateway) would
                    # show the Gmail from a new place on every request.
                    if not got or got in seen_ips or (ip and got != ip) or ms > max_ms:
                        return None
                    ip = got
                    times.append(ms)
                return {"proxy": p, "ip": ip, "ms": int(sum(times) / len(times))}
        except Exception:
            return None

    for i in range(0, len(candidates), batch_size):
        if len(working) >= need:
            break
        chunk = candidates[i:i + batch_size]
        res = await asyncio.gather(*(check_one(p) for p in chunk))
        for item in sorted((x for x in res if x), key=lambda x: x["ms"]):
            if item["ip"] in seen_ips:
                continue
            seen_ips.add(item["ip"])
            working.append(item)
            if len(working) >= need:
                break

    return {"ok": True, "proxies": working, "directIp": direct_ip}


class Account:
    def __init__(self, meta):
        self.id = meta["id"]
        self.email = meta.get("email", "")
        self.enabled = meta.get("enabled", True)
        self.client = None
        self.lock = asyncio.Lock()
        self.state = "starting"  # starting | ready | signed_out | limited | error | off
        self.error = None
        self.busy = 0
        self.waiting = 0
        self.served = 0
        self.failed = 0
        self.last_ms = None
        self.last_used = None
        self.limited_until = 0
        self.quota = None
        self.saved_cookies = None
        self.proxy = meta.get("proxy") or None  # http://user:pass@host:port or socks5://...
        self.ip = None        # the address Google sees (through the proxy, if any)
        self.models = []      # [{name, display, available}] this account offers
        self.refreshed_at = meta.get("refreshedAt")  # set by DR Dubber when it copies fresh cookies

    def cookie_file(self):
        return os.path.join(COOKIE_DIR, f"{self.id}.json")

    def info(self):
        return {
            "id": self.id, "email": self.email, "enabled": self.enabled, "state": self.state,
            "error": self.error, "busy": self.busy, "waiting": self.waiting, "served": self.served,
            "failed": self.failed, "lastMs": self.last_ms, "lastUsed": self.last_used,
            "limitedUntil": self.limited_until or None, "quota": self.quota,
            "proxy": mask_proxy(self.proxy), "ip": self.ip, "models": self.models,
        }

    def save_cookies(self):
        if not self.client:
            return
        try:
            jar = self.client.cookies
            data = {}
            for c in getattr(jar, "jar", []):  # curl_cffi Cookies -> CookieJar
                data[c.name] = c.value
            if not data:
                data = dict(jar)
            if data and data != self.saved_cookies:
                old = read_json(self.cookie_file(), {})
                old.update(data)
                write_json(self.cookie_file(), old)
                self.saved_cookies = data
        except Exception as e:
            log(f"{self.email}: could not save cookies: {e}")

    def read_quota(self):
        q = getattr(self.client, "_quotas", None) or {}
        best = None
        for v in q.values():
            if not isinstance(v, dict) or v.get("total") in (None, 0):
                continue
            if best is None or (v.get("remaining") or 0) < (best.get("remaining") or 0):
                best = v
        if best:
            self.quota = {"remaining": best.get("remaining"), "total": best.get("total"),
                          "resetAt": best.get("reset_time"), "label": best.get("label")}

    async def start(self):
        if not self.enabled:
            self.state = "off"
            return
        cookies = read_json(self.cookie_file(), {})
        if not cookies.get("__Secure-1PSID"):
            if self.proxy:
                try:
                    self.ip = await outside_ip(self.proxy, timeout=8)
                except Exception:
                    self.ip = None
            self.state, self.error = "signed_out", "Not signed in yet"
            return
        self.state, self.error = "starting", None
        try:
            if self.proxy:
                try:
                    self.ip = await outside_ip(self.proxy, timeout=10)
                except Exception as e:
                    self.ip = None
                    self.state, self.error = "error", f"The proxy does not work: {type(e).__name__}: {str(e)[:160]}"
                    log(f"{self.email}: proxy failed ({self.error})")
                    return
            else:
                try:
                    self.ip = await direct_outside_ip()
                except Exception:
                    self.ip = None
            # Only the two sign-in cookies: with every Google cookie loaded, Gemini answered
            # "Gemini Apps Activity is off" and ignored the attached audio (tested 2026-11-07).
            c = GeminiClient(cookies["__Secure-1PSID"], cookies.get("__Secure-1PSIDTS"), proxy=self.proxy)
            await asyncio.wait_for(c.init(timeout=600, auto_close=False, auto_refresh=True, refresh_interval=540), 45)
            # A session Google ended still "starts": Gemini answers text signed out (model
            # "gemini-flash-lite", no credits) but refuses uploads. Seen 2026-11-08: four Gmails
            # ran a whole series like that, every episode silently going to an API key.
            status = getattr(c, "account_status", None)
            if status is not None and getattr(status, "name", "AVAILABLE") != "AVAILABLE":
                self.client = c
                await self.stop(save=False)
                self.state, self.error = "signed_out", f"Google ended this sign-in ({status.name})"
                log(f"{self.email}: signed out by Google ({status.name})")
                return
            self.client = c
            try:
                self.models = [{"name": m.model_name, "display": getattr(m, "display_name", m.model_name),
                                "description": getattr(m, "description", ""), "available": bool(getattr(m, "is_available", True))}
                               for m in (c.list_models() or []) if getattr(m, "model_name", None)]
            except Exception:
                self.models = []
            self.read_quota()
            self.save_cookies()
            self.state = "ready"
            log(f"{self.email}: ready" + (f" ({self.quota['remaining']}/{self.quota['total']} credits)" if self.quota else ""))
        except gx.AuthError as e:
            self.state, self.error = "signed_out", f"Google signed this account out: {e}"
            log(f"{self.email}: signed out ({e})")
        except Exception as e:
            self.state, self.error = "error", str(e) or type(e).__name__
            log(f"{self.email}: could not start: {self.error}")

    async def stop(self, save=True):
        if self.client:
            if save:
                self.save_cookies()
            try:
                await self.client.close()
            except Exception:
                pass
        self.client = None


async def reload_accounts():
    metas = read_json(os.path.join(BASE, "accounts.json"), [])
    seen = set()
    starts = []
    for m in metas:
        if not isinstance(m, dict) or not m.get("id"):
            continue
        seen.add(m["id"])
        a = accounts.get(m["id"])
        restart = False
        if not a:
            a = Account(m)
            accounts[a.id] = a
            restart = True
        else:
            a.email = m.get("email", a.email)
            if m.get("enabled", True) != a.enabled or (m.get("proxy") or None) != a.proxy or m.get("restart"):
                a.enabled = m.get("enabled", True)
                a.proxy = m.get("proxy") or None
                restart = True
            elif m.get("refreshedAt") and m.get("refreshedAt") != a.refreshed_at:
                # DR Dubber copied fresh cookies from the Gmail's Chrome profile.
                restart = True
            elif a.state in ("signed_out", "error") and os.path.exists(a.cookie_file()):
                # New cookies after a fresh sign-in, or a start that failed: try again.
                restart = os.path.getmtime(a.cookie_file()) > (a.last_start or 0)
        a.refreshed_at = m.get("refreshedAt")
        if restart:
            async def go(acc=a):
                # Not saving on the way out: the old session's cookies would overwrite the fresh
                # ones just written (they are saved every minute while it runs anyway).
                await acc.stop(save=False)
                acc.last_start = time.time()
                await acc.start()
            starts.append(go())
    for aid in list(accounts):
        if aid not in seen:
            await accounts[aid].stop()
            del accounts[aid]
    order[:] = [m["id"] for m in metas if isinstance(m, dict) and m.get("id") in accounts]
    if starts:
        await asyncio.gather(*starts)


Account.last_start = 0


def pick_account(wanted):
    if wanted:
        a = accounts.get(wanted)
        if not a:
            return None, "NO_ACCOUNT", "That Gmail is not in the router."
        if a.state != "ready":
            return None, "NOT_READY", f"{a.email} is {a.state}" + (f": {a.error}" if a.error else "")
        return a, None, None
    now = time.time()
    ready = [accounts[i] for i in order if i in accounts and accounts[i].state == "ready" and accounts[i].limited_until < now]
    if not ready:
        return None, "NO_READY_ACCOUNT", "No Gmail in the router is ready (signed out, out of credits or switched off)."
    n = len(order)
    # The next free account in turn; when all are busy, the one with the shortest queue.
    for k in range(n):
        i = order[(rr["next"] + k) % n]
        a = accounts.get(i)
        if a in ready and a.busy == 0 and a.waiting == 0:
            rr["next"] = (order.index(i) + 1) % n
            return a, None, None
    a = min(ready, key=lambda x: x.busy + x.waiting)
    return a, None, None


async def generate(body):
    a, code, msg = pick_account(body.get("account"))
    if not a:
        return {"ok": False, "code": code, "error": msg}
    prompt = body.get("prompt") or ""
    files = [f for f in (body.get("files") or []) if f and os.path.exists(f)]
    missing = [f for f in (body.get("files") or []) if f not in files]
    if missing:
        return {"ok": False, "code": "ERROR", "error": f"File not found: {missing[0]}"}
    timeout = float(body.get("timeoutSec") or 600)
    # The chosen model when this Gmail has it, else the Gmail's own default (free ones: Auto).
    wanted_model = body.get("model") or None
    have = {m["name"] for m in a.models if m.get("available")}
    model = wanted_model if wanted_model and wanted_model in have else None
    extended = bool(body.get("extendedThinking"))
    # noWait: the caller has an API key to use instead, so a Gmail already working says so now.
    if body.get("noWait") and (a.busy or a.waiting):
        return {"ok": False, "code": "BUSY", "error": f"{a.email} is busy", "account": a.id, "email": a.email}
    a.waiting += 1
    queued = True
    try:
        async with a.lock:
            a.waiting -= 1
            queued = False
            a.busy += 1
            t0 = time.time()
            try:
                kw = {"temporary": True}
                if model:
                    kw["model"] = model
                if extended:
                    kw["extended_thinking"] = True
                r = await asyncio.wait_for(a.client.generate_content(prompt, files=files or None, **kw), timeout)
                text = r.text or ""
                a.served += 1
                a.last_ms = int((time.time() - t0) * 1000)
                a.last_used = time.time()
                a.error = None
                used = model or "default"  # no model chosen: whatever Google gives this Gmail
                return {"ok": True, "text": text, "account": a.id, "email": a.email, "ms": a.last_ms, "files": len(files),
                        "model": used + (" (extended thinking)" if extended else "")}
            except gx.UsageLimitExceededError as e:
                a.limited_until = time.time() + 30 * 60
                a.state, a.error = "limited", f"Out of credits: {e}"
                a.failed += 1
                return {"ok": False, "code": "QUOTA", "error": a.error, "account": a.id, "email": a.email}
            except gx.AuthError as e:
                a.state, a.error = "signed_out", f"Signed out: {e}"
                a.failed += 1
                return {"ok": False, "code": "SIGNED_OUT", "error": a.error, "account": a.id, "email": a.email}
            except gx.TemporarilyBlockedError as e:
                a.limited_until = time.time() + 15 * 60
                a.state, a.error = "limited", f"Google blocked this account for a while: {e}"
                a.failed += 1
                return {"ok": False, "code": "BLOCKED", "error": a.error, "account": a.id, "email": a.email}
            except (asyncio.TimeoutError, gx.TimeoutError):
                a.failed += 1
                a.error = "No answer in time"
                return {"ok": False, "code": "TIMEOUT", "error": a.error, "account": a.id, "email": a.email}
            except Exception as e:
                a.failed += 1
                a.error = str(e) or type(e).__name__
                if "UNAUTHENTICATED" in a.error:
                    # The session ended while running: DR Dubber refreshes it from the Chrome profile.
                    a.state = "signed_out"
                    log(f"{a.email}: signed out by Google while working")
                    return {"ok": False, "code": "SIGNED_OUT", "error": a.error, "account": a.id, "email": a.email}
                return {"ok": False, "code": "ERROR", "error": a.error, "account": a.id, "email": a.email}
            finally:
                a.busy -= 1
                a.save_cookies()
    finally:
        if queued:
            a.waiting -= 1


async def refresh_quota(wanted):
    targets = [accounts[wanted]] if wanted in accounts else list(accounts.values())
    for a in targets:
        if a.client and a.state in ("ready", "limited"):
            try:
                await a.client._fetch_quota()
                a.read_quota()
                if a.state == "limited" and a.quota and (a.quota.get("remaining") or 0) > 0:
                    a.state, a.error, a.limited_until = "ready", None, 0
            except Exception as e:
                a.error = f"Credits check failed: {e}"


async def housekeeping():
    while True:
        await asyncio.sleep(60)
        now = time.time()
        for a in list(accounts.values()):
            if a.state == "limited" and a.limited_until and a.limited_until < now:
                a.state, a.error, a.limited_until = "ready", None, 0
            a.save_cookies()


def run_coro(coro, timeout=None):
    return asyncio.run_coroutine_threadsafe(coro, loop).result(timeout)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        return json.loads(self.rfile.read(n).decode("utf-8"))

    def do_GET(self):
        if self.path.startswith("/status"):
            return self.reply(200, {"ok": True, "accounts": [accounts[i].info() for i in order if i in accounts]})
        self.reply(404, {"ok": False})

    def do_POST(self):
        try:
            b = self.body()
            if self.path == "/generate":
                return self.reply(200, run_coro(generate(b)))
            if self.path == "/reload":
                run_coro(reload_accounts())
                return self.reply(200, {"ok": True, "accounts": [accounts[i].info() for i in order if i in accounts]})
            if self.path == "/quota":
                run_coro(refresh_quota(b.get("account")))
                return self.reply(200, {"ok": True, "accounts": [accounts[i].info() for i in order if i in accounts]})
            if self.path == "/test-proxies":
                return self.reply(200, run_coro(test_proxies(b), timeout=170))
            self.reply(404, {"ok": False})
        except Exception as e:
            traceback.print_exc()
            self.reply(500, {"ok": False, "code": "ERROR", "error": str(e)})


def main():
    threading.Thread(target=loop.run_forever, daemon=True).start()
    run_coro(reload_accounts())
    asyncio.run_coroutine_threadsafe(housekeeping(), loop)
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    log(f"listening on 127.0.0.1:{args.port} with {len(accounts)} account(s)")
    try:
        srv.serve_forever()
    finally:
        for a in list(accounts.values()):
            try:
                run_coro(a.stop(), 10)
            except Exception:
                pass


if __name__ == "__main__":
    main()
