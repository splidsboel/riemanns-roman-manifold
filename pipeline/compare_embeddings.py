"""
Quick comparison of LAION CLAP vs Microsoft CLAP embedding quality.
Usage: uv run python -m pipeline.compare_embeddings <audio_file>
"""
import sys
import numpy as np
from pipeline.embed import embed_audio_laion, embed_text_laion, embed_audio_ms, embed_text_ms


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


def compare(audio_path: str, queries: list[str]) -> None:
    print(f"\nAudio: {audio_path}\n")
    a_laion = embed_audio_laion(audio_path)
    a_ms = embed_audio_ms(audio_path)

    print(f"{'Query':<30} {'LAION cosine':>14} {'MSCLAP cosine':>14}")
    print("-" * 60)
    for q in queries:
        t_laion = embed_text_laion(q)
        t_ms = embed_text_ms(q)
        print(f"{q:<30} {cosine(a_laion, t_laion):>14.4f} {cosine(a_ms, t_ms):>14.4f}")


if __name__ == "__main__":
    audio = sys.argv[1]
    test_queries = [
        "punchy kick drum",
        "warm bass",
        "bright synth pad",
        "acoustic guitar",
        "drum loop",
    ]
    compare(audio, test_queries)
