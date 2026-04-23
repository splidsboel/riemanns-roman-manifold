"""Single-flight UMAP recomputation shared by the API and the pipeline.

At most one fit runs at a time. Both UI-triggered (`trigger_recompute`) and
pipeline-triggered (`run_blocking`) calls coalesce onto the same in-flight job.
"""

import threading
import uuid
from datetime import datetime, timezone

from sqlalchemy import func

from pipeline.umap_compute import recompute_umap
from shared.database import Sample, SessionLocal

_state_lock = threading.Lock()
_done_event = threading.Event()
_done_event.set()

# Fingerprint = (count_of_embedded, isoformat(max(created_at))). When it
# matches the one captured at the end of the last successful fit and no
# embedded sample is missing UMAP coords, a /recompute call is a no-op.
_state: dict = {
    "computing": False,
    "current_job_id": None,
    "last_job_id": None,
    "last_finished_at": None,
    "last_error": None,
    "last_fingerprint": None,
    "pending_fingerprint": None,
}


def _fingerprint(session) -> tuple[int, str | None]:
    count, latest = (
        session.query(func.count(Sample.id), func.max(Sample.created_at))
        .filter(Sample.embedding.isnot(None))
        .one()
    )
    return int(count or 0), (latest.isoformat() if latest else None)


def _has_stale_coords(session) -> bool:
    row = (
        session.query(Sample.id)
        .filter(Sample.embedding.isnot(None), Sample.umap_x.is_(None))
        .first()
    )
    return row is not None


def _do_fit(job_id: str) -> None:
    session = SessionLocal()
    err: str | None = None
    try:
        recompute_umap(session)
    except Exception as e:
        err = str(e)
        print(f"[umap-service] fit failed: {e}")
    finally:
        session.close()
        with _state_lock:
            _state["computing"] = False
            _state["current_job_id"] = None
            _state["last_job_id"] = job_id
            _state["last_finished_at"] = datetime.now(timezone.utc).isoformat()
            _state["last_error"] = err
            if err is None:
                _state["last_fingerprint"] = _state.get("pending_fingerprint")
            _state["pending_fingerprint"] = None
        _done_event.set()


def trigger_recompute(force: bool = False) -> dict:
    """Kick off a UMAP fit in a background thread. No-op if one is already running,
    or if the embedding set hasn't changed since the last successful fit.

    Returns ``{"job_id", "started", "cached"}``. ``cached`` is True when the
    DB fingerprint matches the last fit and no new work is needed.
    """
    session = SessionLocal()
    try:
        fp = _fingerprint(session)
        stale_coords = _has_stale_coords(session)
    finally:
        session.close()

    with _state_lock:
        if _state["computing"]:
            return {
                "job_id": _state["current_job_id"],
                "started": False,
                "cached": False,
            }

        can_skip = (
            not force
            and not stale_coords
            and fp[0] > 0
            and _state["last_error"] is None
        )
        # Warm cache (same DB state as last successful fit).
        if can_skip and _state["last_fingerprint"] == fp:
            return {
                "job_id": _state["last_job_id"],
                "started": False,
                "cached": True,
            }
        # Cold start after server restart: coords are populated in the DB but we
        # have no in-memory fingerprint. Trust the DB, seed the fingerprint, no fit.
        if can_skip and _state["last_fingerprint"] is None:
            _state["last_fingerprint"] = fp
            return {"job_id": None, "started": False, "cached": True}

        job_id = str(uuid.uuid4())
        _state["computing"] = True
        _state["current_job_id"] = job_id
        _state["pending_fingerprint"] = fp
        _done_event.clear()

    t = threading.Thread(target=_do_fit, args=(job_id,), daemon=True)
    t.start()
    return {"job_id": job_id, "started": True, "cached": False}


def run_blocking() -> None:
    """Run UMAP synchronously. Waits for any in-flight fit first, then runs its
    own fit so the caller is guaranteed a pass that includes its newly-committed
    embeddings.
    """
    while True:
        with _state_lock:
            if not _state["computing"]:
                job_id = str(uuid.uuid4())
                _state["computing"] = True
                _state["current_job_id"] = job_id
                _done_event.clear()
                break
        _done_event.wait()

    session = SessionLocal()
    try:
        fp = _fingerprint(session)
    finally:
        session.close()
    with _state_lock:
        _state["pending_fingerprint"] = fp

    _do_fit(job_id)


def get_status() -> dict:
    with _state_lock:
        return {
            "computing": _state["computing"],
            "current_job_id": _state["current_job_id"],
            "last_job_id": _state["last_job_id"],
            "last_finished_at": _state["last_finished_at"],
            "last_error": _state["last_error"],
        }
