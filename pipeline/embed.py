from pathlib import Path

import numpy as np
import torch
from msclap import CLAP

_MODEL: CLAP | None = None


def _get_model() -> CLAP:
    global _MODEL
    if _MODEL is None:
        _MODEL = CLAP(version='2023', use_cuda=torch.cuda.is_available())
    return _MODEL


def embed_audio(audio_path: Path) -> np.ndarray:
    """Return a 512-dim CLAP embedding for the given audio file."""
    return embed_audio_batch([audio_path])[0]


def embed_audio_batch(audio_paths: list[Path]) -> list[np.ndarray]:
    """Return CLAP embeddings for a list of files in a single GPU forward pass."""
    if not audio_paths:
        return []
    embs = _get_model().get_audio_embeddings([str(p) for p in audio_paths])
    out: list[np.ndarray] = []
    for e in embs:
        if isinstance(e, torch.Tensor):
            e = e.detach().cpu().numpy()
        out.append(np.asarray(e))
    return out
