#!/usr/bin/env python3
"""Read OpenCode Go quota using Pi's credential store, without OpenCode."""

import argparse
import datetime as dt
import http.client
import json
import math
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


USAGE_URL = "https://opencode.ai/zen/go/v1/usage"
TIMEOUT_SECONDS = 15
MAX_RESPONSE_BYTES = 1024 * 1024
ENV_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
WINDOWS = (("rolling", "5h"), ("weekly", "weekly"), ("monthly", "monthly"))


class QuotaError(Exception):
    """An error whose message is safe to show without credentials or HTTP bodies."""


def agent_directory(environ=None):
    environ = os.environ if environ is None else environ
    value = environ.get("PI_CODING_AGENT_DIR") or str(Path.home() / ".pi" / "agent")
    if value.startswith("file://"):
        try:
            parsed = urllib.parse.urlsplit(value)
            if parsed.netloc and parsed.netloc.lower() != "localhost":
                raise ValueError("non-local file URL")
            if re.search(r"%2f", parsed.path, re.IGNORECASE):
                raise ValueError("encoded path separator")
            if re.search(r"%(?![0-9a-fA-F]{2})", parsed.path):
                raise ValueError("invalid URL escape")
            value = urllib.parse.unquote(parsed.path, errors="strict")
        except (ValueError, UnicodeError):
            raise QuotaError("PI_CODING_AGENT_DIR 不是有效的本地 file:// 路径。") from None
    if value == "~":
        value = str(Path.home())
    elif value.startswith("~/"):
        value = str(Path.home() / value[2:])
    return Path(value)


def resolve_key_template(value, local_env, environ):
    """Match Pi's ordinary key templates, but never execute shell commands."""
    if value.startswith("!"):
        raise QuotaError("Pi 的 Go key 使用了 ! 命令；额度工具不会执行命令，请配置字面量或环境变量模板。")
    result = []
    missing = False
    index = 0
    while index < len(value):
        if value[index] != "$" or index + 1 == len(value):
            result.append(value[index])
            index += 1
            continue
        following = value[index + 1]
        if following in ("$", "!"):
            result.append("$" if following == "$" else "!")
            index += 2
            continue
        if following == "{":
            end = value.find("}", index + 2)
            if end != -1:
                name = value[index + 2:end]
                if ENV_NAME.fullmatch(name):
                    replacement = local_env.get(name) or environ.get(name)
                    missing = missing or not replacement
                    result.append(replacement or "")
                else:
                    result.append(value[index:end + 1])
                index = end + 1
                continue
        else:
            match = ENV_NAME.match(value, index + 1)
            if match:
                name = match.group(0)
                replacement = local_env.get(name) or environ.get(name)
                missing = missing or not replacement
                result.append(replacement or "")
                index = match.end()
                continue
        result.append("$")
        index += 1
    return None if missing else "".join(result)


def load_api_key(environ=None):
    environ = os.environ if environ is None else environ
    auth_path = agent_directory(environ) / "auth.json"
    try:
        with auth_path.open(encoding="utf-8-sig") as handle:
            auth = json.load(handle)
    except FileNotFoundError:
        auth = {}
    except (OSError, UnicodeError, ValueError):
        raise QuotaError("无法读取 Pi 的 auth.json；请检查文件权限和 JSON 格式。") from None
    if not isinstance(auth, dict):
        raise QuotaError("Pi 的 auth.json 必须是对象。")
    credential = auth.get("opencode-go")
    resolved = None
    if credential is not None:
        if not isinstance(credential, dict) or credential.get("type") != "api_key":
            raise QuotaError("Pi 的 opencode-go 凭据必须是 api_key 类型。")
        key = credential.get("key")
        local_env = credential.get("env", {})
        if "key" in credential and not isinstance(key, str):
            raise QuotaError("Pi 的 opencode-go key 必须是字符串。")
        if not isinstance(local_env, dict) or any(
            not isinstance(name, str) or not isinstance(value, str)
            for name, value in local_env.items()
        ):
            raise QuotaError("Pi 的 opencode-go env 必须是字符串字典。")
        if key is not None:
            resolved = resolve_key_template(key, local_env, environ)
    key = resolved or environ.get("OPENCODE_API_KEY")
    if not isinstance(key, str) or not key.strip():
        raise QuotaError("未找到可用的 Pi Go key；请检查 Pi 的 opencode-go 凭据及模板环境变量。")
    if any(ord(char) < 32 or ord(char) == 127 for char in key):
        raise QuotaError("Pi 的 Go key 含有无效控制字符。")
    return key


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise QuotaError("额度接口返回重定向，已停止请求以保护凭据。")


def fetch_usage(key):
    request = urllib.request.Request(
        USAGE_URL,
        headers={
            "Authorization": "Bearer " + key,
            "Accept": "application/json",
            "User-Agent": "Pi-Quota/1.0",
        },
        method="GET",
    )
    opener = urllib.request.build_opener(NoRedirectHandler())
    try:
        with opener.open(request, timeout=TIMEOUT_SECONDS) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        code = error.code
        error.close()
        if code in (401, 403):
            raise QuotaError("Pi Go key 未获额度接口授权（HTTP %s）；请检查 Pi 中的凭据。" % code) from None
        raise QuotaError("额度接口请求失败（HTTP %s）。" % code) from None
    except (urllib.error.URLError, OSError, ValueError, http.client.HTTPException):
        raise QuotaError("无法连接额度接口，请稍后重试。") from None
    if len(body) > MAX_RESPONSE_BYTES:
        raise QuotaError("额度接口响应过大。")
    try:
        return json.loads(body)
    except (ValueError, UnicodeError):
        raise QuotaError("额度接口未返回有效 JSON。") from None


def parse_reset(value):
    if not isinstance(value, str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})",
        value,
    ):
        raise QuotaError("额度接口的重置时间无效或缺少时区。")
    if not value.endswith("Z") and (int(value[-5:-3]) > 23 or int(value[-2:]) > 59):
        raise QuotaError("额度接口的重置时间包含无效时区。")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        return int(parsed.timestamp())
    except (ValueError, OverflowError, OSError):
        raise QuotaError("额度接口的重置时间无效。") from None


def make_snapshot(payload):
    usage = payload.get("usage") if isinstance(payload, dict) else None
    if not isinstance(usage, dict):
        raise QuotaError("额度接口缺少有效的 usage 数据。")
    windows = []
    for source, label in WINDOWS:
        window = usage.get(source)
        if not isinstance(window, dict):
            raise QuotaError("额度接口缺少完整的额度周期数据。")
        if window.get("status") not in ("ok", "rate-limited"):
            raise QuotaError("额度接口返回了未知的额度状态。")
        percent = window.get("percent")
        if isinstance(percent, bool) or not isinstance(percent, (int, float)):
            raise QuotaError("额度接口的使用百分比无效。")
        try:
            finite = math.isfinite(percent)
        except OverflowError:
            finite = False
        if not finite or not 0 <= percent <= 100:
            raise QuotaError("额度接口的使用百分比超出有效范围。")
        windows.append({
            "label": label,
            "percentRemaining": 100 - percent,
            "resetAt": parse_reset(window.get("resetsAt")),
        })
    return {
        "generatedAt": int(time.time() * 1000),
        "providers": [{"id": "opencode-go", "name": "Go", "windows": windows}],
    }


def create_parser():
    parser = argparse.ArgumentParser(
        description="通过 Pi 的 Go 凭据读取套餐额度，无需 OpenCode 软件或 npm 包。",
    )
    commands = parser.add_subparsers(dest="command")
    show = commands.add_parser("show", help="显示 Go 剩余额度（默认命令）")
    show.add_argument("--json", action="store_true", help="输出 JSON")
    widget = commands.add_parser("widget", help="兼容顶部 Quota 扩展")
    widget.add_argument("--print", action="store_true", help="输出 JSON")
    widget.add_argument("--live", action="store_true", help="实时查询额度")
    return parser


def main(argv=None):
    args = create_parser().parse_args(argv)
    try:
        snapshot = make_snapshot(fetch_usage(load_api_key()))
    except QuotaError as error:
        print("Pi Quota: " + str(error), file=sys.stderr)
        return 1
    if args.command == "widget" or getattr(args, "json", False):
        print(json.dumps(snapshot, ensure_ascii=False, allow_nan=False))
    else:
        print("Go 剩余额度")
        for window in snapshot["providers"][0]["windows"]:
            reset = dt.datetime.fromtimestamp(window["resetAt"], dt.timezone.utc)
            print("%s: %g%% · 重置 %s" % (
                window["label"], window["percentRemaining"], reset.isoformat().replace("+00:00", "Z"),
            ))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
