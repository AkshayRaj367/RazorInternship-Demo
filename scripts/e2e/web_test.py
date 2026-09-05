"""E2E: the Next.js web app proxy chain (browser-visible surface only)."""
import json
import sys
import uuid

import requests

WEB = "http://127.0.0.1:3200"
PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{detail}]" if detail and not cond else ""))


r = requests.get(WEB + "/", timeout=20)
check("GET / renders the console page", r.status_code == 200 and "Razor-MCP" in r.text)

sid = f"e2e-web-{uuid.uuid4().hex[:8]}"
r = requests.post(
    WEB + "/api/agent/chat",
    json={"prompt": "hello onyx, what can you do?", "sessionId": sid, "agentId": "onyx-agent"},
    timeout=60,
)
check(
    "POST /api/agent/chat -> proxied to agent-service (graceful LLM-unconfigured reply)",
    r.status_code == 200 and "LLM" in r.json().get("reply", ""),
    r.text[:150],
)

r = requests.get(WEB + f"/api/audit/e2e-socket-session-01", timeout=15)
events = r.json().get("events", [])
check(
    "GET /api/audit/<sessionId> -> proxied, backlog visible",
    r.status_code == 200 and any(e.get("step") == "INTENT" for e in events),
    r.text[:150],
)

r = requests.post(
    WEB + "/api/mcp",
    json={"jsonrpc": "2.0", "id": "w1", "method": "tools/call", "params": {"name": "search_catalog", "arguments": {"query": "watch"}}},
    timeout=20,
)
body = r.json()
items = body.get("result", {}).get("result", {}).get("items", [])
check(
    "POST /api/mcp -> JSON-RPC proxied to mcp-server with server-side key",
    r.status_code == 200 and any(i["sku"] == "ACC-WATCH-001" for i in items),
    json.dumps(body)[:200],
)

# The API key must never appear in the page bundle.
r = requests.get(WEB + "/", timeout=20)
check("internal MCP API key never rendered into HTML", "e2e-internal-mcp-key-0001" not in r.text)

print(f"\nRESULT: {len(PASS)} passed, {len(FAIL)} failed")
sys.exit(1 if FAIL else 0)
