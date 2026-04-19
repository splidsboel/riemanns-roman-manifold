"""Text query → CLAP text embedding → pgvector similarity → top-k samples.

Uses the same msclap model instance as `pipeline.embed`, so the text and
audio embeddings live in the same 1024-D space.
"""

from __future__ import annotations

import numpy as np
import torch
from sqlalchemy.orm import Session

from pipeline.embed import _get_model
from shared.database import Sample


def text_to_embedding(query: str) -> np.ndarray:
    emb = _get_model().get_text_embeddings([query])[0]
    if isinstance(emb, torch.Tensor):
        emb = emb.detach().cpu().numpy()
    return np.asarray(emb, dtype=np.float32)


def search_samples(session: Session, query: str, k: int = 20) -> list[Sample]:
    vec = text_to_embedding(query).tolist()
    return (
        session.query(Sample)
        .order_by(Sample.embedding.cosine_distance(vec))
        .limit(k)
        .all()
    )
