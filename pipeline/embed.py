import numpy as np
import laion_clap
import torch
from msclap import CLAP as MSCLAP

LAION_MODEL = None
MS_MODEL = None


def _laion() -> laion_clap.CLAP_Module:
    global LAION_MODEL
    if LAION_MODEL is None:
        LAION_MODEL = laion_clap.CLAP_Module(enable_fusion=True)
        LAION_MODEL.load_ckpt()
    return LAION_MODEL


def _ms() -> MSCLAP:
    global MS_MODEL
    if MS_MODEL is None:
        MS_MODEL = MSCLAP(version="2023", use_cuda=torch.cuda.is_available())
    return MS_MODEL


def embed_audio_laion(path: str) -> np.ndarray:
    return _laion().get_audio_embedding_from_filelist([path], use_tensor=False)[0]


def embed_text_laion(text: str) -> np.ndarray:
    return _laion().get_text_embedding([text], use_tensor=False)[0]


def embed_audio_ms(path: str) -> np.ndarray:
    return np.array(_ms().get_audio_embeddings([path])[0])


def embed_text_ms(text: str) -> np.ndarray:
    return np.array(_ms().get_text_embeddings([text])[0])
