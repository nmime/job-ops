#!/usr/bin/env python3
"""job-ops MULTI-PLATFORM MONITOR — persistent daemon (systemd jobops-mp-monitor.service).

Generalizes the Contra monitor to the whole registry:
  GLOBAL (once):
    - containers steel-browser, job-ops  (up?; auto docker start)
    - steel health (hardened + verified)
  TIMERS:
    - jobops-contra-orch.timer  (Contra's own)
    - jobops-mp-orch.timer      (dispatcher for all other enabled platforms)
    (active/enabled? last-fire age; auto enable/restart)
  PER PLATFORM (every registered platform that has a state file):
    - state applied/failed + failures in last hour
    - queue length (backed up?)
    - recent worker-log ERROR/FATAL/RECAPTCHA-spam
    - stuck worker/driver processes (proc_pattern; >15min -> SIGTERM)

Reacts (idempotent) and alerts (dedup'd) to:
  /opt/job-ops/logs/mp-monitor.log
  /opt/job-ops/logs/mp-monitor.status.json
  /opt/job-ops/logs/mp-monitor.alerts
and pings /opt/job-ops/hooks/monitor-alert.sh (-> Telegram @nmime) on a NEW alert.
"""
import json, os, re, subprocess, time, datetime

MP = "/opt/job-ops/multiplatform"
REG = f"{MP}/registry.json"
LOG = "/opt/job-ops/logs/mp-monitor.log"
STATUS = "/opt/job-ops/logs/mp-monitor.status.json"
ALERTS = "/opt/job-ops/logs/mp-monitor.alerts"

TICK = 60
TIMER_STUCK_S = 45 * 60
STUCK_PROCS_S = 15 * 60
BACKUP_QUEUE = 6
ALERT_DEDUP_S = 6 * 3600
GLOBAL_CONTAINERS = ("steel-browser", "job-ops")

_state = {}

def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")

def sh(cmd, timeout=60):
    env = dict(os.environ)
    env["PATH"] = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    try:
        r = subprocess.run(["bash", "-c", cmd], capture_output=True, text=True, timeout=timeout, env=env)
        return r.returncode, (r.stdout or "") + (r.stderr or "")
    except Exception as e:
        return -1, str(e)

def jload(txt):
    txt = (txt or "").lstrip("\ufeff").strip()
    if not txt:
        return None
    try:
        return json.loads(txt)
    except Exception:
        try:
            obj, _ = json.JSONDecoder().raw_decode(txt)
            return obj
        except Exception:
            return None

def log(msg):
    line = f"[{now()}] {msg}"
    try:
        with open(LOG, "a") as f:
            f.write(line + "\n")
    except Exception:
        pass
    print(line, flush=True)

def alert(key, msg):
    last = _state.get(f"_alert_{key}", 0)
    if time.time() - last < ALERT_DEDUP_S:
        return
    _state[f"_alert_{key}"] = time.time()
    log(f"ALERT[{key}] {msg}")
    try:
        with open(ALERTS, "a") as f:
            f.write(f"[{now()}] {key}: {msg}\n")
    except Exception:
        pass
    hook = "/opt/job-ops/hooks/monitor-alert.sh"
    if os.path.exists(hook):
        try:
            subprocess.run(["bash", hook, key, msg], timeout=30)
        except Exception:
            pass

def load_reg():
    try:
        return json.load(open(REG))
    except Exception as e:
        log(f"registry unreadable: {e!r}")
        return {"platforms": {}}

def read_json(path):
    if path.startswith("/app/"):
        rc, txt = sh(f"docker exec job-ops cat {path} 2>/dev/null", timeout=30)
    else:
        rc, txt = sh(f"cat {path} 2>/dev/null", timeout=30)
    return jload(txt)

def timer_age_s(unit):
    rc, txt = sh(f"systemctl list-timers {unit} --no-pager 2>/dev/null")
    m = re.search(r"(\d+)(min|s|sec|hour|h) ago", txt)
    if m:
        val = int(m.group(1)); u = m.group(2)
        return val * (3600 if u in ("hour", "h") else 60 if u == "min" else 1)
    return None

def etime_secs(et):
    et = et.strip()
    parts = et.replace("-", "").split(":")
    mult = [86400, 3600, 60, 1][-len(parts):]
    return sum(int(p) * m for p, m in zip(parts, mult))

def check_timer(out, unit):
    if not unit:
        return
    rc, txt = sh(f"systemctl is-active {unit} 2>/dev/null"); active = txt.strip() == "active"
    rc, txt = sh(f"systemctl is-enabled {unit} 2>/dev/null"); enabled = txt.strip() == "enabled"
    key = unit.replace("jobops-", "").replace(".timer", "")
    out["checks"][f"timer_{key}_active"] = active
    out["checks"][f"timer_{key}_enabled"] = enabled
    if not (active and enabled):
        out["problems"].append(f"timer {unit} not active/enabled (a={active} e={enabled})")
    age = timer_age_s(unit)
    out["checks"][f"timer_{key}_last_fire_ago_s"] = age
    if age is not None and age > TIMER_STUCK_S:
        out["problems"].append(f"timer {unit} stuck: last fire {age}s ago")

def check_global(out):
    for cname in GLOBAL_CONTAINERS:
        rc, txt = sh(f"docker inspect -f '{{{{.State.Running}}}}' {cname} 2>/dev/null")
        up = txt.strip() == "true"
        out["checks"][f"container_{cname.replace('-','_')}"] = up
        if not up:
            out["problems"].append(f"container {cname} down")
    rc, txt = sh('curl -s -m 8 http://127.0.0.1:3000/v1/health 2>/dev/null', timeout=20)
    h = jload(txt)
    if h and isinstance(h, dict):
        br = h.get("browserRuntime", {})
        ok = h.get("status") == "ok" and br.get("mode") == "hardened" and br.get("verified") is True
        out["checks"]["steel_health"] = ok
        if not ok:
            out["problems"].append(f"steel health not ok (status={h.get('status')} mode={br.get('mode')} verified={br.get('verified')})")
    else:
        out["checks"]["steel_health"] = False
        out["problems"].append("steel health unreadable")

def check_platform(out, pid, p):
    st = p.get("state"); q = p.get("queue"); wlog = p.get("worker_log")
    # state
    if st:
        s = read_json(st)
        if isinstance(s, dict):
            applied = len(s.get("applied", {})); failed = len(s.get("failed", {}))
            out["checks"][f"{pid}_applied"] = applied
            out["checks"][f"{pid}_failed"] = failed
            recent = 0
            for v in s.get("failed", {}).values():
                try:
                    at = datetime.datetime.fromisoformat(v.get("at", "").replace("Z", "+00:00"))
                    if (datetime.datetime.now(datetime.timezone.utc) - at).total_seconds() < 3600:
                        recent += 1
                except Exception:
                    pass
            out["checks"][f"{pid}_failed_last_hour"] = recent
            if recent >= 3:
                out["problems"].append(f"{pid}: {recent} failures in last hour (egress/anti-bot issue)")
        # else: no state yet (platform not yet run) - not a problem
    # queue
    if q:
        qq = read_json(q)
        if isinstance(qq, dict):
            qlen = len(qq.get("queue", []))
            out["checks"][f"{pid}_queue_len"] = qlen
            if qlen > BACKUP_QUEUE:
                out["problems"].append(f"{pid}: queue backed up: {qlen}")
    # recent log errors
    if wlog:
        rc, txt = sh(f"tail -n 40 {wlog} 2>/dev/null", timeout=30)
        spam = len(re.findall(r"RECAPTCHA_SCORE_BELOW_THRESHOLD|spam/blocked|captcha.{0,15}fail", txt, re.I))
        fatal = len(re.findall(r"FATAL|renderer|about:blank", txt))
        if spam >= 3:
            out["problems"].append(f"{pid}: anti-bot/captcha spam x{spam} in recent log")
        if fatal:
            out["problems"].append(f"{pid}: renderer/fatal signals x{fatal} in recent log")
    # stuck processes
    pat = p.get("proc_pattern")
    if pat:
        rc, txt = sh(f"ps -eo etime:12,pid,cmd | grep -E '{pat}' | grep -v grep", timeout=30)
        stuck = []
        for ln in txt.splitlines():
            mpid = re.search(r"\s(\d{3,})\s", ln)
            if not mpid:
                continue
            pidn = mpid.group(1)
            et = ln.strip().split(None, 1)[0]
            secs = etime_secs(et)
            if secs > STUCK_PROCS_S:
                stuck.append((pidn, secs))
        out["checks"][f"{pid}_stuck_procs"] = stuck
        if stuck:
            out["problems"].append(f"{pid}: stuck worker/driver {stuck}")

def react(out):
    c = out["checks"]
    if c.get("container_steel_browser") is False:
        log("react: steel-browser down -> docker start")
        rc, txt = sh("docker start steel-browser 2>&1", timeout=120)
        alert("steel-browser-down", f"steel-browser was down; docker start -> rc={rc}: {txt.strip()[:200]}")
    if c.get("container_job_ops") is False:
        log("react: job-ops down -> docker start")
        rc, txt = sh("docker start job-ops 2>&1", timeout=120)
        alert("job-ops-down", f"job-ops was down; docker start -> rc={rc}: {txt.strip()[:200]}")
    # timers
    for unit in ("jobops-contra-orch.timer", "jobops-autonomous.timer"):
        key = unit.replace("jobops-", "").replace(".timer", "")
        if f"timer_{key}_active" not in c:
            continue
        if not (c.get(f"timer_{key}_active") and c.get(f"timer_{key}_enabled")):
            log(f"react: {unit} not active/enabled -> enable --now + restart")
            rc, txt = sh(f"systemctl enable --now {unit} 2>&1; systemctl restart {unit} 2>&1", timeout=60)
            alert(f"timer-{key}-down", f"{unit} not active/enabled; enable+restart -> rc={rc}: {txt.strip()[:200]}")
        elif c.get(f"timer_{key}_last_fire_ago_s") and c[f"timer_{key}_last_fire_ago_s"] > TIMER_STUCK_S:
            log(f"react: {unit} stuck -> restart timer")
            rc, txt = sh(f"systemctl restart {unit} 2>&1", timeout=60)
            alert(f"timer-{key}-stuck", f"{unit} stuck (no fire {c[f'timer_{key}_last_fire_ago_s']}s); restart -> rc={rc}")
    # stuck procs
    for k, v in c.items():
        if k.endswith("_stuck_procs") and v:
            pid = k[:-len("_stuck_procs")]
            for pidn, secs in v:
                log(f"react: {pid} stuck proc {pidn} ({secs}s) -> SIGTERM")
                sh(f"kill -TERM {pidn} 2>&1", timeout=30)
                alert(f"stuck-{pid}", f"killed stuck process {pidn} (running {secs}s)")

def check_freelance_db(out, reg):
    # Read the freelance_* DB (the multi-platform pipeline state) via the job-ops container.
    rc, txt = sh("docker exec -w /app/orchestrator job-ops node /app/orchestrator/scripts/multiplatform/db.cjs freelance-snapshot 2>/dev/null", timeout=60)
    d = jload(txt)
    if not d or not isinstance(d, dict):
        out["checks"]["freelance_db"] = False
        return
    out["checks"]["freelance_db"] = True
    out["checks"]["freelance_sources"] = d.get("sources")
    out["checks"]["freelance_enabled"] = d.get("enabled")
    out["platforms_db"] = d.get("per", {})
    for pid, info in d.get("per", {}).items():
        if not info.get("enabled"):
            continue
        last = info.get("last") or {}
        at = last.get("at")
        age = None
        if at:
            try:
                t = datetime.datetime.fromisoformat(str(at).replace("Z", "+00:00"))
                if t.tzinfo is None:
                    t = t.replace(tzinfo=datetime.timezone.utc)
                age = (datetime.datetime.now(datetime.timezone.utc) - t).total_seconds()
            except Exception:
                pass
        if age is None:
            out["problems"].append(f"{pid}: enabled but never ran (no platform_status audit in DB)")
        elif age > 2 * 3600:
            out["problems"].append(f"{pid}: no platform_status audit in {int(age // 60)}m (multi-platform pipeline may not be running)")
        if last.get("blocked"):
            out["checks"][f"{pid}_blocked"] = last.get("blocked")


def healthy(reg):
    out = {"time": now(), "problems": [], "checks": {}, "platforms": {}}
    check_global(out)
    # timers: contra's own + the autonomous cycle (which now runs the multi-platform pipeline)
    check_timer(out, "jobops-contra-orch.timer")
    if any(p.get("enabled") and k != "contra" for k, p in reg["platforms"].items()):
        check_timer(out, "jobops-autonomous.timer")
    check_freelance_db(out, reg)
    for pid, p in reg["platforms"].items():
        check_platform(out, pid, p)
        out["platforms"][pid] = {
            "level": p.get("level"), "enabled": p.get("enabled"),
            "applied": out["checks"].get(f"{pid}_applied"), "failed": out["checks"].get(f"{pid}_failed"),
            "queue": out["checks"].get(f"{pid}_queue_len"),
        }
    return out

def main():
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    log(f"mp-monitor started (pid {os.getpid()}, tick {TICK}s)")
    _state["_start"] = time.time()
    while True:
        try:
            reg = load_reg()
            out = healthy(reg)
            try:
                with open(STATUS, "w") as f:
                    json.dump(out, f, indent=1)
            except Exception:
                pass
            if out["problems"]:
                for pr in out["problems"]:
                    log("PROBLEM " + pr)
                react(out)
            else:
                _state["_tick"] = _state.get("_tick", 0) + 1
                if _state["_tick"] % 10 == 1:
                    log("OK " + json.dumps({k: v for k, v in out["checks"].items() if "stuck" not in k}))
        except Exception as e:
            log(f"monitor error: {e!r}")
        time.sleep(TICK)

if __name__ == "__main__":
    main()
