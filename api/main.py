import mimetypes
import threading
import uuid
from pathlib import Path

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy.orm import Session

from pipeline.run import run_pipeline
from shared.database import Sample, get_session

from .search import search_samples
from .umap_service import get_status as umap_status
from .umap_service import trigger_recompute

app = FastAPI(title="riemanns-roman-manifold")

UI_DIR = Path(__file__).resolve().parents[1] / "ui"

JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()


class SearchRequest(BaseModel):
    query: str
    k: int = 20


class PipelineRunRequest(BaseModel):
    directory: str
    skip_stems: bool = False
    reset_db: bool = False
    workers: int | None = None
    batch_size: int | None = None


@app.get("/visualization/status")
def visualization_status(db: Session = Depends(get_session)):
    count = db.query(Sample).count()
    u = umap_status()
    return {
        "ready": count > 0 and not u["computing"],
        "index_count": count,
        "computing": u["computing"],
        "current_job_id": u["current_job_id"],
        "last_finished_at": u["last_finished_at"],
        "last_error": u["last_error"],
    }


@app.post("/visualization/recompute")
def visualization_recompute():
    result = trigger_recompute()
    return {"job_id": result["job_id"], "started": result["started"]}


@app.get("/visualization/layout")
def visualization_layout(db: Session = Depends(get_session)):
    rows = db.query(Sample).all()
    return {
        "points": [
            {
                "id": r.id,
                "path": r.path,
                "filename": r.filename,
                "x": r.umap_x,
                "y": r.umap_y,
                "z": r.umap_z,
                "cluster": r.cluster,
            }
            for r in rows
        ],
    }


@app.post("/search")
def search(req: SearchRequest, db: Session = Depends(get_session)):
    if not req.query.strip():
        raise HTTPException(400, "empty query")
    rows = search_samples(db, req.query, k=req.k)
    return {
        "results": [
            {"id": r.id, "path": r.path, "filename": r.filename, "cluster": r.cluster}
            for r in rows
        ],
    }


AUDIO_MIME = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".aif": "audio/x-aiff",
    ".aiff": "audio/x-aiff",
}


@app.get("/audio/{sample_id}")
def get_audio(sample_id: int, db: Session = Depends(get_session)):
    sample = db.query(Sample).filter(Sample.id == sample_id).first()
    if sample is None:
        raise HTTPException(404, "sample not found")
    audio_path = Path(sample.path)
    if not audio_path.is_file():
        raise HTTPException(404, f"file missing on host: {sample.path}")
    media_type = AUDIO_MIME.get(audio_path.suffix.lower()) \
        or mimetypes.guess_type(str(audio_path))[0] \
        or "application/octet-stream"
    return FileResponse(audio_path, media_type=media_type, filename=sample.filename)


@app.post("/pipeline/run")
def start_pipeline(req: PipelineRunRequest, background_tasks: BackgroundTasks):
    if req.reset_db:
        from sqlalchemy import text
        from shared.database import Base, engine
        Base.metadata.drop_all(engine)
        with engine.connect() as conn:
            conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            conn.commit()
        Base.metadata.create_all(engine)

    job_id = str(uuid.uuid4())
    with JOBS_LOCK:
        JOBS[job_id] = {'status': 'queued', 'processed': 0, 'total': 0, 'errors': []}
    background_tasks.add_task(
        run_pipeline, req.directory, job_id, JOBS, JOBS_LOCK,
        workers=req.workers, skip_stems=req.skip_stems, batch_size=req.batch_size,
    )
    return {'job_id': job_id}


@app.get("/pipeline/status/{job_id}")
def pipeline_status(job_id: str):
    with JOBS_LOCK:
        if job_id not in JOBS:
            raise HTTPException(status_code=404, detail="Job not found")
        return dict(JOBS[job_id])


# UI static files — mounted last so explicit API routes above take precedence.
app.mount("/", StaticFiles(directory=str(UI_DIR), html=True), name="ui")
