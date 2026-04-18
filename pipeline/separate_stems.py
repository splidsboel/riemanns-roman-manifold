import subprocess
import sys
from pathlib import Path

DEMIX_DIR = Path("demix")
MODEL = "htdemucs"


def separate_stems(audio_path: Path | str) -> list[Path]:
    """Separate an audio file into instrument stems using demucs.

    Runs the htdemucs model to split the track into bass, drums, vocals,
    and other. Stems are written under demix/htdemucs/<stem>/ and cached —
    subsequent calls on the same file return immediately without re-running.

    Args:
        audio_path: Path to an audio file (WAV or MP3).

    Returns:
        Sorted list of paths to the separated stem WAV files.
    """
    audio_path = Path(audio_path)
    stem_dir = DEMIX_DIR / MODEL / audio_path.stem

    if not stem_dir.exists() or not any(stem_dir.iterdir()):
        subprocess.run(
            [sys.executable, "-m", "demucs.separate",
             "--out", str(DEMIX_DIR), "--name", MODEL,
             str(audio_path)],
            check=True,
        )

    return sorted(stem_dir.glob("*.wav"))
