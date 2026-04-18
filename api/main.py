from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy.orm import Session

from shared.database import Sample, get_session

from .search import search_samples

app = FastAPI(title="riemanns-roman-manifold")

UI_DIR = Path(__file__).resolve().parents[1] / "ui"


class SearchRequest(BaseModel):
    query: str
    k: int = 20


@app.get("/visualization/status")
def visualization_status(db: Session = Depends(get_session)):
    count = db.query(Sample).count()
    return {"ready": count > 0, "index_count": count, "computing": False}


@app.get("/visualization/layout")
def visualization_layout(db: Session = Depends(get_session)):
    rows = db.query(Sample).all()
    return {
        "points": [
            {
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
            {"path": r.path, "filename": r.filename, "cluster": r.cluster}
            for r in rows
        ],
    }


# UI static files — mounted last so explicit API routes above take precedence.
app.mount("/", StaticFiles(directory=str(UI_DIR), html=True), name="ui")
