#!/usr/bin/env python3
"""
Checks whether an OpenAI API key actually works.

    python3 tools/check-openai-key.py sk-proj-xxxxx
    OPENAI_API_KEY=sk-... python3 tools/check-openai-key.py

Only the Python standard library is used, so there is nothing to install.

Two checks are made:
  1. list the models  - proves the key is accepted, costs nothing
  2. one tiny message - proves the account can actually pay for a request

A key can pass the first check and fail the second when the balance is empty,
which is the case that looks like a working key but leaves the bot silent.
"""

import json
import os
import ssl
import sys
import urllib.error
import urllib.request

MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
TIMEOUT = 30


def call(path, key, payload=None):
    """Returns (status, parsed_body_or_text)."""
    url = "https://api.openai.com" + path
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method="POST" if data else "GET",
        headers={
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=ssl.create_default_context()) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(body)
        except json.JSONDecodeError:
            return e.code, body
    except Exception as e:                                  # network, DNS, TLS
        return 0, str(e)


def error_text(body):
    if isinstance(body, dict):
        return body.get("error", {}).get("message") or json.dumps(body)[:300]
    return str(body)[:300]


def explain(status, body):
    """Maps a status to what the person has to do about it."""
    msg = error_text(body)
    if status == 401:
        return ("INVALID", msg,
                "The key is revoked or wrong.\n"
                "   Make a new one: https://platform.openai.com/api-keys\n"
                "   Note: a key pasted into GitHub or a public chat is auto-revoked.")
    if status == 403:
        return ("FORBIDDEN", msg,
                "The key is valid but not allowed to do this.\n"
                "   Check the project and the key's permissions.")
    if status == 429:
        low = msg.lower()
        if "quota" in low or "billing" in low or "credit" in low:
            return ("NO CREDIT", msg,
                    "The key works but the account has no balance.\n"
                    "   Top up: https://platform.openai.com/settings/organization/billing")
        return ("RATE LIMITED", msg, "Too many requests right now. Wait a minute and run this again.")
    if status == 404:
        return ("NO SUCH MODEL", msg,
                f"The key works but '{MODEL}' is not available to it.\n"
                "   Try another model, e.g. OPENAI_MODEL=gpt-4o-mini")
    if status == 0:
        return ("NO CONNECTION", msg,
                "api.openai.com could not be reached at all.\n"
                "   Check the internet connection, a VPN, or a firewall.")
    if status >= 500:
        return ("OPENAI DOWN", msg, "The problem is on OpenAI's side. Try again shortly.")
    return (f"HTTP {status}", msg, "Unexpected answer.")


def main():
    key = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("OPENAI_API_KEY", "")).strip()

    print()
    if not key:
        print("No key given.")
        print("   python3 tools/check-openai-key.py sk-proj-xxxxx")
        return 2

    print(f"Key   : {key[:7]}...{key[-4:]}  ({len(key)} characters)")
    print(f"Model : {MODEL}")
    if not key.startswith("sk-"):
        print("Warning: an OpenAI key normally starts with 'sk-'.")
    print()

    # ---- 1. is the key accepted at all ----
    print("1) Checking the key is accepted ...")
    status, body = call("/v1/models", key)
    if status != 200:
        label, msg, what_to_do = explain(status, body)
        print(f"   FAILED - {label}")
        print(f"   {msg}\n")
        print(f"-> {what_to_do}\n")
        return 1
    count = len(body.get("data", [])) if isinstance(body, dict) else 0
    print(f"   OK - key accepted, {count} models available\n")

    # ---- 2. can it actually run a request ----
    print(f"2) Sending one tiny message to {MODEL} ...")
    status, body = call("/v1/chat/completions", key, {
        "model": MODEL,
        "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
        "max_tokens": 5,
    })
    if status != 200:
        label, msg, what_to_do = explain(status, body)
        print(f"   FAILED - {label}")
        print(f"   {msg}\n")
        print(f"-> {what_to_do}\n")
        return 1

    reply = body["choices"][0]["message"]["content"].strip()
    used = body.get("usage", {}).get("total_tokens", "?")
    print(f"   OK - model answered: {reply!r}  ({used} tokens)\n")

    print("RESULT: the key works. Put this exact value in Render as OPENAI_API_KEY.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
