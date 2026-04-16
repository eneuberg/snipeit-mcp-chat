"""Chainlit chat app over claude-agent-sdk with Snipe-IT MCP.

Auth modes:
  * API-key:     set ANTHROPIC_API_KEY.
  * Subscription: leave ANTHROPIC_API_KEY unset; mount host ~/.claude at
                  /home/appuser/.claude so the bundled Claude Code CLI can
                  supply its OAuth session.
"""

from __future__ import annotations

import base64
import os
from pathlib import Path

import chainlit as cl
from chainlit.data.sql_alchemy import SQLAlchemyDataLayer
from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ResultMessage,
    SystemMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
    query,
)

MCP_URL = os.environ["MCP_URL"]
MODEL = os.getenv("ANTHROPIC_MODEL") or None
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

MCP_SERVERS = {"snipeit": {"type": "http", "url": MCP_URL}}
ALLOWED_TOOLS = ["mcp__snipeit__*"]

Path(FILES_DIR).mkdir(parents=True, exist_ok=True)


@cl.data_layer
def _data_layer() -> SQLAlchemyDataLayer:
    return SQLAlchemyDataLayer(conninfo=f"sqlite+aiosqlite:///{DB_PATH}")


def _user_msg_from_chainlit(msg: cl.Message) -> dict:
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
    payload = content if content else (msg.content or "")
    return {"type": "user", "message": {"role": "user", "content": payload}}


async def _replay(history: list[dict]):
    for item in history:
        yield item


def _tool_result_text(content) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict):
                text = block.get("text")
                if text:
                    parts.append(text)
            else:
                parts.append(str(block))
        return "\n".join(parts)
    return str(content)


@cl.on_chat_start
async def on_chat_start() -> None:
    cl.user_session.set("history", [])


@cl.on_message
async def on_message(msg: cl.Message) -> None:
    history: list[dict] = cl.user_session.get("history") or []
    history.append(_user_msg_from_chainlit(msg))

    options = ClaudeAgentOptions(
        system_prompt=SYSTEM_PROMPT,
        mcp_servers=MCP_SERVERS,
        allowed_tools=ALLOWED_TOOLS,
        model=MODEL,
    )

    open_steps: dict[str, cl.Step] = {}
    reply = cl.Message(content="")
    await reply.send()
    assistant_had_text = False

    async for message in query(prompt=_replay(history), options=options):
        if isinstance(message, SystemMessage) and message.subtype == "init":
            failed = [
                s
                for s in (message.data.get("mcp_servers") or [])
                if s.get("status") and s.get("status") != "connected"
            ]
            if failed:
                await cl.Message(
                    content=f"MCP server(s) not connected: {failed}",
                    author="system",
                ).send()

        elif isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    await reply.stream_token(block.text)
                    assistant_had_text = True
                elif isinstance(block, ToolUseBlock):
                    step = cl.Step(name=block.name, type="tool")
                    step.input = block.input
                    await step.send()
                    open_steps[block.id] = step

        elif isinstance(message, UserMessage):
            blocks = message.content if isinstance(message.content, list) else []
            for block in blocks:
                if isinstance(block, ToolResultBlock):
                    step = open_steps.pop(block.tool_use_id, None)
                    if step is not None:
                        step.output = _tool_result_text(block.content)
                        if block.is_error:
                            step.is_error = True
                        await step.update()

        elif isinstance(message, ResultMessage):
            if message.subtype and message.subtype.startswith("error"):
                await cl.Message(
                    content=f"Agent error: {message.subtype} (stop_reason={message.stop_reason}).",
                    author="system",
                ).send()

    if not assistant_had_text:
        reply.content = "(no response)"
    await reply.update()
    cl.user_session.set("history", history)
