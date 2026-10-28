#!/usr/bin/env python3
"""脱敏采集证据：删除凭证、令牌、Cookie，并掩码手机号/身份证号/邮箱。

用法:
  python sanitize_evidence.py <input.json> <output.json>

输入可以是 agent-browser `network requests` 的原始 JSON，也可以是导出的 HAR。
输出为脱敏后的 JSON，可安全纳入项目。脚本不记录、不输出任何凭证原文。
"""
import json
import re
import sys
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlsplit, urlunsplit

SECRET_HEADER_KEYS = {
    "cookie", "set-cookie", "authorization", "x-csrf-token", "x-xsrf-token",
    "csrf-token", "x-auth-token", "proxy-authorization",
}
SECRET_BODY_KEYS = {
    "_token", "token", "csrf_token", "password", "password_confirmation",
    "current_password", "new_password", "new_password_confirmation",
    "remember", "api_key", "apikey", "secret", "authorization", "access_token",
    "refresh_token",
}
SENSITIVE_VALUE_KEYS = {
    "id_number", "id_card", "idcard", "card_no", "bank_account", "account_no",
    "contact_phone", "phone", "mobile", "tel", "wechat", "email",
    "idcard_number", "passport_no", "username", "user_name", "login_name",
}

PLACEHOLDER = "[REDACTED]"
PHONE_RE = re.compile(r"(?<!\d)(1[3-9]\d{9})(?!\d)")
# 审计日志等页面正文会带操作者 IP，属个人数据，同样需要掩码
IPV4_RE = re.compile(r"(?<!\d)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\d)")
IDCARD_RE = re.compile(r"(?<!\d)(\d{6})(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(\d{3}[\dXx])(?!\d)")
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
LONG_TOKEN_RE = re.compile(r"\b[A-Za-z0-9_\-]{32,}\b")
ACCOUNT_RE = re.compile(r"\b(?:admin_\d+|retest_fin_[A-Za-z0-9_\-]+)\b", re.I)
CSRF_META_RE = re.compile(r'(<meta name="csrf-token" content=")[^"]*(")')
TOKEN_FIELD_RE = re.compile(r"(_token=)[^&\s\"']+")
HTML_SECRET_TAG_RE = re.compile(r'<(?:input|meta)\b[^>]*\bname\s*=\s*[\"\'](?:_token|csrf-token|password|token)[\"\'][^>]*>', re.I)


def mask_text(value: str) -> str:
    if not isinstance(value, str):
        return value
    out = value
    out = CSRF_META_RE.sub(r"\1[REDACTED]\2", out)
    out = HTML_SECRET_TAG_RE.sub(lambda m: re.sub(r'(\b(?:value|content)\s*=\s*)([\"\'])(.*?)\2', lambda a: a.group(1) + a.group(2) + PLACEHOLDER + a.group(2), m.group(0), flags=re.I), out)
    out = TOKEN_FIELD_RE.sub(r"\1[REDACTED]", out)
    out = IDCARD_RE.sub(lambda m: m.group(1) + "********" + m.group(5)[-1:], out)
    out = PHONE_RE.sub(lambda m: m.group(1)[:3] + "****" + m.group(1)[-4:], out)
    out = IPV4_RE.sub(lambda m: f"{m.group(1)}.{m.group(2)}.***.***", out)
    out = EMAIL_RE.sub(lambda m: m.group(0).split("@")[0][:1] + "***@" + m.group(0).split("@", 1)[1], out)
    out = ACCOUNT_RE.sub("[MASKED_ACCOUNT]", out)
    out = LONG_TOKEN_RE.sub("[REDACTED_TOKEN]", out)
    return out


def sanitize_headers(headers):
    if isinstance(headers, list):
        return [dict(item, value=PLACEHOLDER if str(item.get("name", "")).lower() in SECRET_HEADER_KEYS else mask_text(str(item.get("value", "")))) if isinstance(item, dict) else mask_text(str(item)) for item in headers]
    if not isinstance(headers, dict):
        return headers
    clean = {}
    for key, value in headers.items():
        if key.lower() in SECRET_HEADER_KEYS:
            clean[key] = PLACEHOLDER
        else:
            clean[key] = mask_text(value) if isinstance(value, str) else value
    return clean


def sanitize_form_body(body):
    """对 x-www-form-urlencoded 的 body 做字段级脱敏。"""
    if not isinstance(body, str):
        return body
    if "=" not in body or body.lstrip().startswith(("{", "[")):
        return mask_text(body)
    parts = []
    for key, value in parse_qsl(body, keep_blank_values=True):
        lk = unquote(key).lower()
        if lk in SECRET_BODY_KEYS:
            parts.append(f"{key}={PLACEHOLDER}")
        elif any(s in lk for s in SENSITIVE_VALUE_KEYS):
            parts.append(f"{key}=[MASKED]")
        else:
            parts.append(f"{key}={mask_text(value)}")
    return "&".join(parts)


def sanitize_payload(value):
    if not isinstance(value, str):
        return sanitize_obj(value)
    try:
        return json.dumps(sanitize_obj(json.loads(value)), ensure_ascii=False)
    except (ValueError, TypeError):
        pass
    if 'Content-Disposition: form-data;' in value:
        # Multipart fields need name-based redaction even for short passwords.
        pattern = re.compile(r'(Content-Disposition: form-data;[^\r\n]*name="([^"\r\n]+)"[^\r\n]*(?:\r?\n[^\r\n]+)*\r?\n\r?\n)(.*?)(?=\r?\n--)', re.I | re.S)
        def redact_part(match):
            name = match.group(2).lower()
            content = match.group(3)
            if name in SECRET_BODY_KEYS:
                content = PLACEHOLDER
            elif any(key in name for key in SENSITIVE_VALUE_KEYS):
                content = '[MASKED]'
            else:
                content = mask_text(content)
            return match.group(1) + content
        return mask_text(pattern.sub(redact_part, value))
    if value.lstrip().startswith("<") or "<!DOCTYPE" in value[:100]:
        return mask_text(value)
    if "=" in value and "\n" not in value:
        return sanitize_form_body(value)
    return mask_text(value)


def sanitize_obj(node, parent_key=""):
    if isinstance(node, dict):
        if "name" in node and "value" in node:
            field_name = str(node["name"]).lower()
            if field_name in SECRET_HEADER_KEYS | SECRET_BODY_KEYS or any(s in field_name for s in SENSITIVE_VALUE_KEYS):
                return {key: PLACEHOLDER if key == "value" else sanitize_obj(value, str(key)) for key, value in node.items()}
        out = {}
        for key, value in node.items():
            lk = str(key).lower()
            if lk in SECRET_HEADER_KEYS:
                out[key] = PLACEHOLDER
            elif lk in SECRET_BODY_KEYS:
                out[key] = PLACEHOLDER
            elif lk in ("cookies", "cookie", "set-cookie"):
                out[key] = PLACEHOLDER
            elif lk in SENSITIVE_VALUE_KEYS:
                out[key] = "[MASKED]"
            elif lk == "requestid":
                out[key] = value
            elif lk == "url" and isinstance(value, str):
                url = urlsplit(value)
                out[key] = urlunsplit((url.scheme, url.netloc, url.path, sanitize_form_body(url.query), ""))
            elif lk in ("postdata", "post_data", "body", "responsebody", "text", "content"):
                out[key] = sanitize_payload(value)
            elif lk == "headers":
                out[key] = sanitize_headers(value)
            else:
                out[key] = sanitize_obj(value, lk)
        return out
    if isinstance(node, list):
        return [sanitize_obj(item, parent_key) for item in node]
    if isinstance(node, str):
        return mask_text(node)
    return node


def main():
    if len(sys.argv) != 3:
        print("usage: sanitize_evidence.py <input.json> <output.json>", file=sys.stderr)
        return 2
    raw = Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")
    data = json.loads(raw)
    clean = sanitize_obj(data)
    Path(sys.argv[2]).write_text(
        json.dumps(clean, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"sanitized -> {sys.argv[2]}")


if __name__ == "__main__":
    raise SystemExit(main())
