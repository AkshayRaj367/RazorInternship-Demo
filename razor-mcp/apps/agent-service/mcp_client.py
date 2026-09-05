"""HTTP JSON-RPC 2.0 client for the mcp-server.

The X-API-Key (MCP_SERVER_INTERNAL_API_KEY) lives ONLY here, server-side in the
Flask process. It is never serialized to a browser response, never embedded in
the Next.js client bundle, and never accepted as a parameter from Onyx's LLM
tool calls.
"""
import json
import uuid
from typing import Any

import requests

from config import config


class McpRemoteError(Exception):
    """JSON-RPC error relayed from the mcp-server (code, message, data)."""

    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(f"{message} (code {code})")
        self.code = code
        self.message = message
        self.data = data


class McpUnavailable(Exception):
    """Transport-level failure (mcp-server down / timeout)."""


def call_tool(name: str, arguments: dict[str, Any], timeout: float = 15.0) -> Any:
    rpc_id = str(uuid.uuid4())
    body = {
        "jsonrpc": "2.0",
        "id": rpc_id,
        "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    }
    try:
        resp = requests.post(
            f"{config.MCP_SERVER_URL.rstrip('/')}/mcp",
            json=body,
            headers={"X-API-Key": config.MCP_SERVER_INTERNAL_API_KEY, "Content-Type": "application/json"},
            timeout=timeout,
        )
    except requests.RequestException as err:
        raise McpUnavailable(f"MCP_UNAVAILABLE: {err}") from err

    if resp.status_code == 401:
        raise McpRemoteError(-32004, "UNAUTHORIZED", "mcp-server rejected the internal API key")
    if resp.status_code == 429:
        try:
            retry_after = int(resp.headers.get("Retry-After", "60"))
        except ValueError:
            retry_after = 60
        raise McpRemoteError(-32029, "RATE_LIMITED", {"retryAfterSeconds": retry_after})

    try:
        envelope = resp.json()
    except ValueError as err:
        raise McpUnavailable(f"MCP_BAD_RESPONSE: HTTP {resp.status_code}") from err

    if "error" in envelope:
        err = envelope["error"]
        raise McpRemoteError(err.get("code", -32000), err.get("message", "UNKNOWN"), err.get("data"))

    result = envelope.get("result")
    # mcp-server wraps tool output as {content: [...], result: <payload>}
    if isinstance(result, dict) and "result" in result and "content" in result:
        return result["result"]
    return result


# --- Typed helpers (used by llm_orchestrator and transaction_service) ---

def search_catalog(query: str | None = None, category: str | None = None, max_price_paise: int | None = None) -> dict:
    args: dict[str, Any] = {}
    if query:
        args["query"] = query
    if category:
        args["category"] = category
    if max_price_paise is not None:
        args["maxPricePaise"] = int(max_price_paise)
    return call_tool("search_catalog", args, timeout=30.0)


def get_item(sku: str) -> dict:
    return call_tool("get_item", {"sku": sku})


def create_order(items: list[dict[str, Any]], buyer_agent_id: str, idempotency_key: str) -> dict:
    return call_tool(
        "create_order",
        {"items": items, "buyerAgentId": buyer_agent_id, "idempotencyKey": idempotency_key},
    )


def get_order_status(order_number: str) -> dict:
    return call_tool("get_order_status", {"orderNumber": order_number})


# --- v2: real-time web tools (keyless multi-engine search on mcp-server) ---

def web_search(query: str, max_results: int | None = None, timeout: float = 20.0) -> dict:
    args: dict[str, Any] = {"query": query}
    if max_results is not None:
        args["maxResults"] = int(max_results)
    return call_tool("web_search", args, timeout=timeout)


def web_product_search(
    query: str,
    max_price_paise: int | None = None,
    max_results: int | None = None,
    timeout: float = 45.0,
) -> dict:
    args: dict[str, Any] = {"query": query}
    if max_price_paise is not None:
        args["maxPricePaise"] = int(max_price_paise)
    if max_results is not None:
        args["maxResults"] = int(max_results)
    return call_tool("web_product_search", args, timeout=timeout)
