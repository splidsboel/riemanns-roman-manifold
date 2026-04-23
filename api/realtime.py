"""Multiplayer presence relay.

Pure fan-out WebSocket hub: keeps an in-memory roster of connected users and
rebroadcasts pose/search messages to everyone else. No persistence, no auth.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter()

HEARTBEAT_TIMEOUT_S = 10.0
REAPER_INTERVAL_S = 2.0


@dataclass
class UserState:
    id: str
    ws: WebSocket
    handle: str = "anon"
    pose: dict[str, Any] = field(default_factory=dict)
    last_seen: float = field(default_factory=time.time)


class Roster:
    def __init__(self) -> None:
        self.users: dict[str, UserState] = {}
        self.lock = asyncio.Lock()

    async def add(self, user: UserState) -> None:
        async with self.lock:
            self.users[user.id] = user

    async def remove(self, user_id: str) -> UserState | None:
        async with self.lock:
            return self.users.pop(user_id, None)

    async def snapshot(self, except_id: str | None = None) -> list[dict[str, Any]]:
        async with self.lock:
            return [
                {"id": u.id, "handle": u.handle, "pose": u.pose}
                for u in self.users.values()
                if u.id != except_id
            ]

    async def targets(self, except_id: str | None = None) -> list[UserState]:
        async with self.lock:
            return [u for u in self.users.values() if u.id != except_id]


roster = Roster()


async def _send(ws: WebSocket, msg: dict[str, Any]) -> bool:
    try:
        await ws.send_json(msg)
        return True
    except Exception:
        return False


async def broadcast(msg: dict[str, Any], except_id: str | None = None) -> None:
    for u in await roster.targets(except_id):
        await _send(u.ws, msg)


async def heartbeat_reaper() -> None:
    while True:
        await asyncio.sleep(REAPER_INTERVAL_S)
        now = time.time()
        stale: list[str] = []
        async with roster.lock:
            for uid, u in list(roster.users.items()):
                if now - u.last_seen > HEARTBEAT_TIMEOUT_S:
                    stale.append(uid)
                    roster.users.pop(uid, None)
        for uid in stale:
            await broadcast({"type": "leave", "id": uid})


@router.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    user_id = uuid.uuid4().hex[:8]
    user = UserState(id=user_id, ws=ws)
    await roster.add(user)

    try:
        others = await roster.snapshot(except_id=user_id)
        await ws.send_json({"type": "hello", "id": user_id, "users": others})

        while True:
            msg = await ws.receive_json()
            mtype = msg.get("type")
            user.last_seen = time.time()

            if mtype == "join":
                user.handle = str(msg.get("handle", "anon"))[:32]
                user.pose = msg.get("pose") or {}
                await broadcast(
                    {"type": "join", "id": user_id, "handle": user.handle, "pose": user.pose},
                    except_id=user_id,
                )
            elif mtype == "pose":
                pose = {"p": msg.get("p"), "r": msg.get("r")}
                user.pose = pose
                await broadcast(
                    {"type": "pose", "id": user_id, **pose},
                    except_id=user_id,
                )
            elif mtype == "search":
                await broadcast(
                    {
                        "type": "search",
                        "id": user_id,
                        "target": msg.get("target"),
                        "offset": msg.get("offset", 0.0),
                        "startT": msg.get("startT"),
                    },
                    except_id=user_id,
                )
            elif mtype == "ping":
                pass
            else:
                # Unknown type — ignore silently for forward-compat.
                pass
    except WebSocketDisconnect:
        pass
    except Exception:
        # Any other error: drop the connection cleanly.
        pass
    finally:
        await roster.remove(user_id)
        await broadcast({"type": "leave", "id": user_id})
