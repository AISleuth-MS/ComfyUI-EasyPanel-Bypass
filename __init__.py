import json
import os
import threading
import time

from aiohttp import web
from server import PromptServer
import folder_paths

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "./javascript"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]


def _db_path():
    # Lives in ComfyUI/user/bypass_panel so updating/reinstalling the node won't wipe it.
    try:
        base = os.path.join(folder_paths.get_user_directory(), "bypass_panel")
    except Exception:
        base = os.path.join(os.path.dirname(__file__), "data")
    os.makedirs(base, exist_ok=True)
    return os.path.join(base, "bypass_db.json")


DB_PATH = _db_path()
_lock = threading.Lock()
_EMPTY = {"version": 1, "workflows": {}}


def _load():
    try:
        with open(DB_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("workflows"), dict):
            return data
    except FileNotFoundError:
        pass
    except Exception as e:
        # Corrupt file: keep a copy instead of silently destroying it.
        print(f"[bypass_panel] DB unreadable ({e}); backing it up.")
        try:
            os.replace(DB_PATH, f"{DB_PATH}.corrupt-{int(time.time())}")
        except OSError:
            pass
    return {"version": 1, "workflows": {}}


def _save(db):
    # Atomic write: temp file + fsync + rename, so a crash can't leave a half-written DB.
    tmp = DB_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(db, f, indent=1)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, DB_PATH)


def _valid_record(rec):
    return (
        isinstance(rec, dict)
        and isinstance(rec.get("nodes"), dict)
        and isinstance(rec.get("overrides"), dict)
    )


routes = PromptServer.instance.routes


@routes.get("/bypass_panel/state")
async def get_state(request):
    wf = request.query.get("wf", "")
    with _lock:
        rec = _load()["workflows"].get(wf)
    return web.json_response(rec or {})


@routes.post("/bypass_panel/state")
async def set_state(request):
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "bad json"}, status=400)

    wf = body.get("wf")
    rec = body.get("record")
    if not isinstance(wf, str) or not wf:
        return web.json_response({"error": "bad wf"}, status=400)

    with _lock:
        db = _load()
        if _valid_record(rec) and rec["overrides"]:
            rec["updated"] = time.time()
            db["workflows"][wf] = rec
        else:
            db["workflows"].pop(wf, None)  # nothing forced -> no record needed
        _save(db)
    return web.json_response({"ok": True})