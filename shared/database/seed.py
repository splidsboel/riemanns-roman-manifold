"""Seed the samples table with synthetic CLAP-dim data for UI testing.

Generates 1020 samples split across 6 clusters. Each cluster has a
deterministic center in 512-D embedding space and a matching position in
3-D UMAP space; points are jittered around their cluster center with
small Gaussian noise. Same RNG seed as `api/search.py` uses for query
embeddings, so a text query hashed to cluster C returns samples from
cluster C.

Run:

    uv run python -m shared.database.seed
"""

from __future__ import annotations

import numpy as np
from sqlalchemy import text

from .config import EMBEDDING_DIM
from .engine import Base, SessionLocal, engine
from .models import Sample

N_CLUSTERS = 6
SAMPLES_PER_CLUSTER = 170
SEED = 42


def cluster_centers_512() -> np.ndarray:
    rng = np.random.default_rng(SEED)
    centers = rng.normal(size=(N_CLUSTERS, EMBEDDING_DIM))
    centers /= np.linalg.norm(centers, axis=1, keepdims=True)
    return centers


def cluster_centers_3d() -> np.ndarray:
    rng = np.random.default_rng(SEED + 1)
    return rng.uniform(-3.0, 3.0, size=(N_CLUSTERS, 3))


def ensure_extension() -> None:
    with engine.begin() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))


def run() -> None:
    ensure_extension()
    Base.metadata.drop_all(engine, tables=[Sample.__table__])
    Base.metadata.create_all(engine, tables=[Sample.__table__])

    centers_hd = cluster_centers_512()
    centers_3d = cluster_centers_3d()
    rng = np.random.default_rng(SEED + 2)

    session = SessionLocal()
    rows: list[Sample] = []
    for c in range(N_CLUSTERS):
        for i in range(SAMPLES_PER_CLUSTER):
            emb = centers_hd[c] + rng.normal(scale=0.08, size=EMBEDDING_DIM)
            emb /= np.linalg.norm(emb)
            pos = centers_3d[c] + rng.normal(scale=0.4, size=3)

            rows.append(
                Sample(
                    path=f"synthetic/c{c}/sample_{i:04d}.wav",
                    filename=f"c{c}_sample_{i:04d}.wav",
                    embedding=emb.tolist(),
                    umap_x=float(pos[0]),
                    umap_y=float(pos[1]),
                    umap_z=float(pos[2]),
                    cluster=c,
                )
            )

    session.add_all(rows)
    session.commit()
    session.close()
    print(f"seeded {len(rows)} samples across {N_CLUSTERS} clusters")


if __name__ == "__main__":
    run()
