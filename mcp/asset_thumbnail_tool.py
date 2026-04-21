import io
import mimetypes
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Annotated, Any

import requests
from PIL import Image, ImageOps

from server import mcp

# Snipe-IT's upload limit is 25 MB. We aim well under that so the
# request is fast and the stored thumbnail isn't absurd. Overridable
# via env for tuning without a rebuild.
TARGET_BYTES = int(os.environ.get("THUMBNAIL_TARGET_BYTES", 5 * 1024 * 1024))
MAX_LONG_EDGE = int(os.environ.get("THUMBNAIL_MAX_LONG_EDGE", 2000))


def _log(msg: str) -> None:
    print(f"[asset_thumbnail] {msg}", file=sys.stdout, flush=True)


def _compress_to_target(src_path: str, target_bytes: int) -> tuple[bytes, str, dict]:
    """Compress an image to <= target_bytes. Returns (bytes, filename, stats).

    Strategy (tuned for Pi 5 — no libvips, just Pillow/libjpeg):
      1. Auto-orient via EXIF, flatten to RGB.
      2. Cap long edge at MAX_LONG_EDGE.
      3. Encode JPEG q=85 progressive. If under target, done.
      4. Step q down by 10 to 40.
      5. If still over, downscale 0.8x and retry at current q, until
         short edge < 600px (below that quality is more useful).
    """
    t0 = time.perf_counter()
    orig_size = os.path.getsize(src_path)
    _log(f"input: {src_path} ({orig_size/1024:.0f} KiB)")

    img = Image.open(src_path)
    img = ImageOps.exif_transpose(img)
    orig_mode = img.mode
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")

    w, h = img.size
    long_edge = max(w, h)
    if long_edge > MAX_LONG_EDGE:
        scale = MAX_LONG_EDGE / long_edge
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
        _log(f"resized {w}x{h} -> {img.size[0]}x{img.size[1]} (long edge {MAX_LONG_EDGE})")

    quality = 85
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality, optimize=True, progressive=True)
    size = buf.tell()
    passes = 1
    _log(f"pass 1 q={quality} -> {size/1024:.0f} KiB")

    while size > target_bytes and quality > 40:
        quality -= 10
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality, optimize=True, progressive=True)
        size = buf.tell()
        passes += 1
        _log(f"iter q={quality} -> {size/1024:.0f} KiB")

    while size > target_bytes and min(img.size) > 600:
        new_size = (max(1, int(img.size[0] * 0.8)), max(1, int(img.size[1] * 0.8)))
        img = img.resize(new_size, Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality, optimize=True, progressive=True)
        size = buf.tell()
        passes += 1
        _log(f"downscale {img.size[0]}x{img.size[1]} q={quality} -> {size/1024:.0f} KiB")

    elapsed_ms = (time.perf_counter() - t0) * 1000
    stats = {
        "original_bytes": orig_size,
        "compressed_bytes": size,
        "quality": quality,
        "final_size_px": list(img.size),
        "passes": passes,
        "elapsed_ms": round(elapsed_ms, 1),
        "original_mode": orig_mode,
        "under_target": size <= target_bytes,
    }
    _log(
        f"done: {orig_size/1024:.0f} KiB -> {size/1024:.0f} KiB "
        f"in {passes} pass(es), {elapsed_ms:.0f} ms, "
        f"{'OK' if size <= target_bytes else 'OVER TARGET'}"
    )
    filename = Path(src_path).stem + ".jpg"
    return buf.getvalue(), filename, stats


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

    Images larger than THUMBNAIL_TARGET_BYTES (default 5 MiB) are
    auto-compressed (JPEG, EXIF-rotated, long edge capped) before
    upload. Snipe-IT's hard limit is 25 MiB.
    """
    base = os.environ["SNIPEIT_URL"].rstrip("/")
    token = os.environ["SNIPEIT_TOKEN"]
    url = f"{base}/api/v1/hardware/{asset_id}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }

    orig_size = os.path.getsize(file_path)
    compression_stats: dict[str, Any] | None = None

    if orig_size <= TARGET_BYTES:
        _log(f"skip compression: {file_path} ({orig_size/1024:.0f} KiB) <= target")
        name = Path(file_path).name
        ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
        with open(file_path, "rb") as f:
            payload = f.read()
    else:
        payload, name, compression_stats = _compress_to_target(file_path, TARGET_BYTES)
        ctype = "image/jpeg"

    _log(f"uploading {name} ({len(payload)/1024:.0f} KiB) -> asset {asset_id}")
    resp = requests.post(
        url,
        headers=headers,
        files={"image": (name, payload, ctype)},
        data={"_method": "PATCH"},
        timeout=60,
    )
    try:
        body = resp.json()
    except ValueError:
        body = {"raw": resp.text}
    _log(f"snipe-it responded {resp.status_code}")

    if resp.status_code >= 400 or (isinstance(body, dict) and body.get("status") == "error"):
        return {
            "success": False,
            "status_code": resp.status_code,
            "error": body,
            "compression": compression_stats,
        }
    return {
        "success": True,
        "asset_id": asset_id,
        "result": body,
        "compression": compression_stats,
    }
