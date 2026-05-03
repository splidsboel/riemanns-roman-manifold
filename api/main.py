from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
import json
from pathlib import Path

from shared.db import get_session_factory, test_connection
from shared.models import Chunk
from pipeline.umap import load_all_chunks, compute_3d_coordinates

app = FastAPI(title="RagRats Vector Visualization")

# Store 3D coordinates in memory (computed on startup)
coordinates_cache = {}


@app.on_event("startup")
async def startup():
    """Load chunks and compute 3D coordinates on startup"""
    global coordinates_cache

    if not test_connection():
        raise RuntimeError("Cannot connect to database")

    chunks = load_all_chunks()
    coordinates_cache = compute_3d_coordinates(chunks)
    print(f"Loaded {len(chunks)} chunks and computed 3D coordinates")


class ChunkResponse(BaseModel):
    id: str
    text: str
    vessel_name: str
    coordinates: list[float]


@app.get("/api/chunks", response_model=list[ChunkResponse])
async def get_all_chunks():
    """Get all chunks with 3D coordinates"""
    SessionFactory = get_session_factory()
    session = SessionFactory()
    try:
        chunks = session.query(Chunk).all()
        result = []
        for chunk in chunks:
            if chunk.id in coordinates_cache:
                result.append(
                    ChunkResponse(
                        id=chunk.id,
                        text=chunk.text,
                        vessel_name=chunk.vessel_name,
                        coordinates=coordinates_cache[chunk.id],
                    )
                )
        return result
    finally:
        session.close()


@app.get("/api/chunk/{chunk_id}")
async def get_chunk(chunk_id: str):
    """Get a specific chunk by ID"""
    SessionFactory = get_session_factory()
    session = SessionFactory()
    try:
        chunk = session.query(Chunk).filter(Chunk.id == chunk_id).first()
        if not chunk:
            raise HTTPException(status_code=404, detail="Chunk not found")

        return {
            "id": chunk.id,
            "text": chunk.text,
            "vessel_name": chunk.vessel_name,
            "coordinates": coordinates_cache.get(chunk.id),
        }
    finally:
        session.close()


# Serve static files
ui_path = Path(__file__).parent.parent / "ui"
if ui_path.exists():
    app.mount("/", StaticFiles(directory=ui_path, html=True), name="static")


@app.get("/")
async def root():
    """Serve index.html"""
    index_file = ui_path / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return {"message": "RagRats Vector Visualization API"}
