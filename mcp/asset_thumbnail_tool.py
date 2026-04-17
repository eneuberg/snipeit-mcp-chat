import mimetypes
import os
from pathlib import Path
from typing import Annotated, Any

import requests

from server import mcp


@mcp.tool(
    annotations={
        "readOnlyHint": False,
        "destructiveHint": True,
        "idempotentHint": True,
    }
)
def asset_thumbnail(
    asset_id: Annotated[int, "Asset ID"],
    file_path: Annotated[
        str,
        "Path to an image readable inside the MCP container "
        "(e.g. /workspace/_uploads/foo.jpg from the paperclip upload).",
    ],
) -> dict[str, Any]:
    """Set the main thumbnail image on an asset. The image shows up in
    the asset's header and in list/table views. To instead attach a
    file to the asset's Files tab, use `asset_files` — this tool
    replaces the record's thumbnail, it does not create a Files entry.
    """
    base = os.environ["SNIPEIT_URL"].rstrip("/")
    token = os.environ["SNIPEIT_TOKEN"]
    url = f"{base}/api/v1/hardware/{asset_id}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }
    name = Path(file_path).name
    ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
    with open(file_path, "rb") as f:
        resp = requests.post(
            url,
            headers=headers,
            files={"image": (name, f, ctype)},
            data={"_method": "PATCH"},
            timeout=30,
        )
    try:
        body = resp.json()
    except ValueError:
        body = {"raw": resp.text}
    if resp.status_code >= 400 or (isinstance(body, dict) and body.get("status") == "error"):
        return {
            "success": False,
            "status_code": resp.status_code,
            "error": body,
        }
    return {"success": True, "asset_id": asset_id, "result": body}
