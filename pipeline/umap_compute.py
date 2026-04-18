import numpy as np
import umap
from sqlalchemy.orm import Session

from shared.database import Sample


def recompute_umap(session: Session) -> None:
    """Fetch all embedded samples, fit UMAP, write umap_x/y/z back to DB."""
    samples = session.query(Sample).filter(Sample.embedding.isnot(None)).all()
    if len(samples) < 2:
        print("[umap] Not enough embedded samples to fit UMAP (need at least 2).")
        return
    print(f"[umap] Fitting UMAP on {len(samples)} samples...")
    embeddings = np.array([s.embedding for s in samples])
    coords = umap.UMAP(
        n_components=3, n_neighbors=15, min_dist=0.1, random_state=42
    ).fit_transform(embeddings)
    for sample, (x, y, z) in zip(samples, coords):
        sample.umap_x, sample.umap_y, sample.umap_z = float(x), float(y), float(z)
    session.commit()
    print("[umap] Done.")
