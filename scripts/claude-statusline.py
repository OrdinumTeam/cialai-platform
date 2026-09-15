#!/usr/bin/env python3
"""Publica o uso do Claude Code para o Cialai e imprime a linha de estado."""

import contextlib
import datetime
import json
import os
import re
import sys
import time

FORMAT = 3
MAX_SESSIONS = 12
SESSION_TTL_MS = 24 * 60 * 60 * 1000
PERCENT_KEYS = (
    "used_percentage",
    "usedPercentage",
    "used_percent",
    "usedPercent",
    "percentage",
    "percent",
    "utilization",
)
RESET_KEYS = (
    "resets_at",
    "resetsAt",
    "reset_at",
    "resetAt",
    "resets_at_ms",
    "resetsAtMs",
)
MINUTE_KEYS = ("window_minutes", "windowMinutes", "window_size_minutes")


def app_support():
    configured = os.environ.get("CIALAI_APP_SUPPORT")
    if configured:
        return os.path.realpath(os.path.expanduser(configured))
    if os.name == "nt":
        root = os.environ.get("APPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Roaming")
        return os.path.join(root, "br.com.ordinum.cialai")
    if sys.platform == "darwin":
        return os.path.expanduser("~/Library/Application Support/br.com.ordinum.cialai")
    root = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
    return os.path.join(root, "br.com.ordinum.cialai")


def config_dir():
    raw = os.environ.get("CLAUDE_CONFIG_DIR") or "~/.claude"
    return os.path.realpath(os.path.expanduser(raw.strip() or "~/.claude"))


def profile_slug(path):
    name = os.path.basename(path.rstrip("/\\")).lstrip(".").lower()
    return re.sub(r"[^a-z0-9._-]", "", name) or "perfil"


def pick(node, keys):
    for key in keys:
        if isinstance(node, dict) and node.get(key) is not None:
            return node[key]
    return None


def as_number(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip().rstrip("%"))
        except ValueError:
            return None
    return None


def as_epoch_ms(value):
    number = as_number(value)
    if number is not None:
        return int(number * 1000) if number < 1e12 else int(number)
    if isinstance(value, str):
        try:
            moment = datetime.datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
            return int(moment.timestamp() * 1000)
        except ValueError:
            return None
    return None


def label_for(key, minutes):
    if minutes:
        if minutes <= 60:
            return "%d min" % int(minutes)
        if minutes < 1440:
            return "%d h" % int(round(minutes / 60))
        if minutes >= 10000:
            return "Semana"
        return "%d d" % int(round(minutes / 1440))
    name = str(key).lower()
    if "five" in name or "5h" in name or "session" in name or "sessao" in name:
        return "Sessão"
    if "seven" in name or "week" in name or "7d" in name:
        return "Semana"
    return str(key).replace("_", " ").strip().capitalize()


def windows_from(node, key="rate_limits", depth=0):
    if depth > 3 or not isinstance(node, (dict, list)):
        return []
    if isinstance(node, list):
        found = []
        for index, item in enumerate(node):
            child_key = item.get("id") if isinstance(item, dict) and item.get("id") else f"{key}.{index}"
            found.extend(windows_from(item, child_key, depth + 1))
        return found
    percent = as_number(pick(node, PERCENT_KEYS))
    if percent is not None:
        minutes = as_number(pick(node, MINUTE_KEYS))
        return [{
            "id": str(key),
            "label": label_for(key, minutes),
            "usedPercent": percent,
            "windowMinutes": int(minutes) if minutes else None,
            "resetsAtMs": as_epoch_ms(pick(node, RESET_KEYS)),
        }]
    found = []
    for child_key, child in node.items():
        found.extend(windows_from(child, child_key, depth + 1))
    return found


def window_sort_key(window):
    minutes = window.get("windowMinutes")
    if minutes is not None:
        return minutes
    name = "%s %s" % (window.get("id") or "", window.get("label") or "")
    name = name.lower()
    if "five" in name or "5h" in name or "session" in name or "sessão" in name:
        return 300
    if "seven" in name or "week" in name or "7d" in name or "semana" in name:
        return 10080
    return 100000


@contextlib.contextmanager
def exclusive_lock(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a+b") as handle:
        if os.name == "nt":
            import msvcrt
            if handle.tell() == 0:
                handle.write(b"\0")
                handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
            try:
                yield
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)


def read_previous(path):
    try:
        with open(path, encoding="utf-8") as handle:
            value = json.load(handle)
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def merge_sessions(previous, current, now_ms):
    kept = []
    for item in previous or []:
        if not isinstance(item, dict):
            continue
        if current.get("sessionId") and item.get("sessionId") == current["sessionId"]:
            continue
        if now_ms - int(item.get("updatedAtMs") or 0) <= SESSION_TTL_MS:
            kept.append(item)
    kept.append(current)
    kept.sort(key=lambda item: int(item.get("updatedAtMs") or 0), reverse=True)
    return kept[:MAX_SESSIONS]


def publish(payload, windows, directory, slug):
    out_dir = os.path.join(app_support(), "ai-usage", "claude")
    out_file = os.path.join(out_dir, slug + ".json")
    now_ms = int(time.time() * 1000)
    workspace = payload.get("workspace") or {}
    model = payload.get("model") or {}
    session = {
        "sessionId": payload.get("session_id"),
        "cwd": payload.get("cwd") or workspace.get("current_dir"),
        "model": model.get("display_name") or model.get("id"),
        "updatedAtMs": now_ms,
    }
    session.update(session_details(payload))
    try:
        with exclusive_lock(os.path.join(out_dir, slug + ".lock")):
            previous = read_previous(out_file)
            record = {
                "agent": "Claude Code",
                "format": FORMAT,
                "profile": slug,
                "profileName": (os.environ.get("CLAUDE_PROFILE") or "").strip() or None,
                "configDir": directory,
                "plan": pick(payload, ("plan_type", "plan"))
                or pick(payload.get("rate_limits") or {}, ("plan_type", "plan")),
                "model": session["model"],
                "cwd": session["cwd"],
                "sessionId": session["sessionId"],
                "sessions": merge_sessions(previous.get("sessions"), session, now_ms),
                "windows": windows,
                "raw": payload.get("rate_limits"),
                "updatedAtMs": now_ms,
            }
            temporary = f"{out_file}.{os.getpid()}.tmp"
            with open(temporary, "w", encoding="utf-8") as handle:
                json.dump(record, handle, ensure_ascii=False)
            os.replace(temporary, out_file)
    except OSError:
        pass


def session_details(payload):
    """Esforco, contexto usado e custo da sessao, quando o Claude Code os manda."""
    details = {}
    effort = (payload.get("effort") or {}).get("level")
    if isinstance(effort, str) and effort.strip():
        details["effort"] = effort.strip().lower()
    context = payload.get("context_window") or {}
    used = as_number(pick(context, ("used_percentage", "usedPercentage")))
    size = as_number(pick(context, ("context_window_size", "contextWindowSize")))
    if used is None and size:
        usage = context.get("current_usage") or {}
        tokens = sum(as_number(usage.get(key)) or 0 for key in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
        used = round(tokens / size * 100, 1) if tokens else None
    if used is not None:
        details["contextUsedPercent"] = max(0.0, min(100.0, float(used)))
    if size:
        details["contextWindowSize"] = int(size)
    cost = as_number((payload.get("cost") or {}).get("total_cost_usd"))
    if cost is not None and cost >= 0:
        details["costUsd"] = float(cost)
    return details


def status_text(payload, windows):
    parts = []
    profile = (os.environ.get("CLAUDE_PROFILE") or "").strip()
    if profile:
        parts.append(profile)
    workspace = payload.get("workspace") or {}
    folder = payload.get("cwd") or workspace.get("current_dir") or ""
    if folder:
        parts.append(os.path.basename(folder.rstrip("/\\")))
    model = (payload.get("model") or {}).get("display_name")
    if model:
        parts.append(model)
    details = session_details(payload)
    if details.get("effort"):
        parts.append(details["effort"])
    if details.get("contextUsedPercent") is not None:
        parts.append("ctx %d%%" % round(details["contextUsedPercent"]))
    for window in windows[:2]:
        parts.append("%s %d%%" % (window["label"].lower(), round(window["usedPercent"])))
    return " · ".join(parts)


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    if not isinstance(payload, dict):
        return 0
    windows = windows_from(payload.get("rate_limits"))
    windows.sort(key=window_sort_key)
    directory = config_dir()
    publish(payload, windows, directory, profile_slug(directory))
    line = status_text(payload, windows)
    if line:
        sys.stdout.write(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
