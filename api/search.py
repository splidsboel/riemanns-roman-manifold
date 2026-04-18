"""Text query → embedding → pgvector similarity → top-k samples.

Until a real text encoder (CLAP text branch) is wired up, `text_to_embedding`
produces a deterministic 512-D vector from the query string by hashing it to
a cluster index and returning that cluster's center. Same query → same
cluster, different query → (usually) different cluster. The hash + RNG seed
must match `shared/database/seed.py` so the synthetic data lines up.

Future hooks:
- Replace `text_to_embedding` with the real CLAP text encoder.
- Optional query expansion via Ollama/Gemma before embedding — pass the
  query through the LLM first to produce richer search tokens. Not yet
  decided; left as a comment so the insertion point is obvious.
"""

from __future__ import annotations

import hashlib

import numpy as np
from sqlalchemy.orm import Session

from shared.database import Sample
from shared.database.config import EMBEDDING_DIM

# Must match shared/database/seed.py
N_CLUSTERS = 6
SEED = 42


def _cluster_centers() -> np.ndarray:
    rng = np.random.default_rng(SEED)
    centers = rng.normal(size=(N_CLUSTERS, EMBEDDING_DIM))
    centers /= np.linalg.norm(centers, axis=1, keepdims=True)
    return centers


def text_to_embedding(query: str) -> np.ndarray:
    # TODO: swap for CLAP text encoder.
    # TODO: optional Ollama query expansion here before encoding.
    h = int(hashlib.sha256(query.encode("utf-8")).hexdigest(), 16)
    return _cluster_centers()[h % N_CLUSTERS]


def search_samples(session: Session, query: str, k: int = 20) -> list[Sample]:
    vec = text_to_embedding(query).tolist()
    return (
        session.query(Sample)
        .order_by(Sample.embedding.cosine_distance(vec))
        .limit(k)
        .all()
    )
