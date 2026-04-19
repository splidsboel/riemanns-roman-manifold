import hdbscan
import numpy as np
import umap
from sqlalchemy.orm import Session

from shared.database import Sample


def recompute_umap(session: Session) -> None:
    """Fit UMAP + HDBSCAN on all embedded samples and write coords + cluster.

    UMAP params match samplevec (spread=2.5, min_dist=0.05) so the layout has
    room between clusters. HDBSCAN then auto-labels clusters and marks
    outliers as -1 — the UI renders -1 as a dim "noise" colour instead of the
    red that a null cluster used to produce.
    """
    samples = session.query(Sample).filter(Sample.embedding.isnot(None)).all()
    if len(samples) < 2:
        print("[umap] Not enough embedded samples to fit UMAP (need at least 2).")
        return
    print(f"[umap] Fitting UMAP on {len(samples)} samples...")
    embeddings = np.array([s.embedding for s in samples])
    coords = umap.UMAP(
        n_components=3,
        n_neighbors=min(15, len(samples) - 1),
        spread=2.5,
        min_dist=0.05,
        random_state=42,
    ).fit_transform(embeddings)

    print("[umap] Clustering with HDBSCAN...")
    labels = hdbscan.HDBSCAN(min_cluster_size=5).fit_predict(coords)

    for sample, (x, y, z), label in zip(samples, coords, labels):
        sample.umap_x, sample.umap_y, sample.umap_z = float(x), float(y), float(z)
        sample.cluster = int(label)
    session.commit()
    print(f"[umap] Done. {int((labels >= 0).sum())} clustered / {int((labels < 0).sum())} noise.")
