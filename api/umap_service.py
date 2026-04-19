"""Single-flight UMAP recomputation shared by the API and the pipeline.

At most one fit runs at a time. Both UI-triggered (`trigger_recompute`) and
pipeline-triggered (`run_blocking`) calls coalesce onto the same in-flight job.
"""

import threading
import uuid
from datetime import datetime, timezone

from pipeline.umap_compute import recompute_umap
from shared.database import SessionLocal

_state_lock = threading.Lock()
_done_event = threading.Event()
_done_event.set()

_state: dict = {
    "computing": False,
    "current_job_id": None,
    "last_job_id": None,
    "last_finished_at": None,
    "last_error": None,
}


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
        _done_event.set()


def trigger_recompute() -> dict:
    """Kick off a UMAP fit in a background thread. No-op if one is already running.

    Returns ``{"job_id", "started"}`` — ``started`` is False when an in-flight
    job was returned instead of launching a new one.
    """
    with _state_lock:
        if _state["computing"]:
            return {
                "job_id": _state["current_job_id"],
                "started": False,
            }
        job_id = str(uuid.uuid4())
        _state["computing"] = True
        _state["current_job_id"] = job_id
        _done_event.clear()

    t = threading.Thread(target=_do_fit, args=(job_id,), daemon=True)
    t.start()
    return {"job_id": job_id, "started": True}


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
