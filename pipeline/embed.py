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
    emb = _get_model().get_audio_embeddings([str(audio_path)])[0]
    if isinstance(emb, torch.Tensor):
        emb = emb.detach().cpu().numpy()
    return np.asarray(emb)
