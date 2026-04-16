"""Chainlit chat app that talks to Claude and proxies tool calls to snipeit-mcp."""

from __future__ import annotations

import base64
import os
from pathlib import Path

import chainlit as cl
import chainlit.data as cl_data
from anthropic import AsyncAnthropic
from chainlit.data.sql_alchemy import SQLAlchemyDataLayer
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

MCP_URL = os.environ["MCP_URL"]
MODEL = os.getenv("ANTHROPIC_MODEL", "claude-opus-4-6")
MAX_TOKENS = int(os.getenv("ANTHROPIC_MAX_TOKENS", "4096"))
DB_PATH = os.getenv("CHAT_DB_PATH", "/data/chat.db")
FILES_DIR = os.getenv("CHAT_FILES_DIR", "/data/files")

SYSTEM_PROMPT = """You help manage a Snipe-IT inventory system through the tools provided.

Workflow for adding a new item from a photo:
1. Identify the item in the photo (brand, model, type, serial number if visible).
2. Search existing Snipe-IT records (manufacturers, models, categories) before creating anything new — prefer reuse over duplication.
3. If information cannot be determined from the photo (asset tag, location, assigned user, purchase date), ASK the user before creating the record.
4. Choose the correct record type: asset (trackable hardware with serial/tag), consumable (cables, batteries), accessory (keyboards, mice), or component.
5. After creating, confirm with a short summary of what was added and its Snipe-IT URL or ID.

Workflow for queries:
- Use the reporting and list tools to answer "what do we have?" questions.
- Return concise, scannable answers on phone screens — short lists with IDs, names, and status.

Always confirm destructive actions (delete, check out to a different user) before executing them.
"""

anthropic = AsyncAnthropic()

Path(FILES_DIR).mkdir(parents=True, exist_ok=True)


@cl_data.data_layer
def _data_layer() -> SQLAlchemyDataLayer:
    return SQLAlchemyDataLayer(conninfo=f"sqlite+aiosqlite:///{DB_PATH}")


def _mcp_tools_to_anthropic(tools) -> list[dict]:
    return [
        {
            "name": t.name,
            "description": t.description or "",
            "input_schema": t.inputSchema,
        }
        for t in tools
    ]


def _build_user_content(msg: cl.Message) -> list[dict]:
    content: list[dict] = []
    for el in msg.elements or []:
        mime = getattr(el, "mime", "") or ""
        path = getattr(el, "path", None)
        if mime.startswith("image/") and path:
            with open(path, "rb") as f:
                data = base64.standard_b64encode(f.read()).decode()
            content.append(
                {
                    "type": "image",
                    "source": {"type": "base64", "media_type": mime, "data": data},
                }
            )
    if msg.content:
        content.append({"type": "text", "text": msg.content})
    return content


def _extract_text(result) -> str:
    parts = []
    for c in result.content or []:
        text = getattr(c, "text", None)
        if text:
            parts.append(text)
    return "\n".join(parts) if parts else "(tool returned no text)"


@cl.on_chat_start
async def on_chat_start() -> None:
    cl.user_session.set("history", [])


@cl.on_message
async def on_message(msg: cl.Message) -> None:
    history: list[dict] = cl.user_session.get("history") or []
    history.append({"role": "user", "content": _build_user_content(msg)})

    async with streamablehttp_client(MCP_URL) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = _mcp_tools_to_anthropic((await session.list_tools()).tools)

            while True:
                resp = await anthropic.messages.create(
                    model=MODEL,
                    max_tokens=MAX_TOKENS,
                    system=SYSTEM_PROMPT,
                    tools=tools,
                    messages=history,
                )
                history.append(
                    {"role": "assistant", "content": [b.model_dump() for b in resp.content]}
                )

                if resp.stop_reason != "tool_use":
                    break

                tool_results = []
                for block in resp.content:
                    if block.type != "tool_use":
                        continue
                    async with cl.Step(name=block.name, type="tool") as step:
                        step.input = block.input
                        try:
                            result = await session.call_tool(
                                block.name, block.input or {}
                            )
                            output = _extract_text(result)
                            is_error = bool(getattr(result, "isError", False))
                        except Exception as exc:
                            output = f"MCP call failed: {exc!r}"
                            is_error = True
                        step.output = output
                        if is_error:
                            step.is_error = True
                    tool_results.append(
                        {
                            "type": "tool_result",
                            "tool_use_id": block.id,
                            "content": output,
                            "is_error": is_error,
                        }
                    )
                history.append({"role": "user", "content": tool_results})

    final = "".join(b.text for b in resp.content if b.type == "text")
    cl.user_session.set("history", history)
    await cl.Message(content=final or "(no response)").send()
