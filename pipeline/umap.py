import numpy as np
from umap import UMAP
from shared.db import get_session_factory
from shared.models import Chunk


def compute_3d_coordinates(chunks: list[Chunk]) -> dict[str, list[float]]:
    """Reduce 2556D embeddings to 3D using UMAP"""
    embeddings = np.array([chunk.embedding for chunk in chunks])

    umap = UMAP(n_components=3, random_state=42, n_neighbors=15, min_dist=0.1)
    coordinates_3d = umap.fit_transform(embeddings)

    result = {}
    for chunk, coords in zip(chunks, coordinates_3d):
        result[chunk.id] = [float(x) for x in coords]

    return result


def load_all_chunks() -> list[Chunk]:
    """Load all chunks from database"""
    SessionFactory = get_session_factory()
    session = SessionFactory()
    try:
        chunks = session.query(Chunk).all()
        return chunks
    finally:
        session.close()
