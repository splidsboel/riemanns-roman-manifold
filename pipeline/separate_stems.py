import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

DEMIX_DIR = Path("demix")
MODEL = "htdemucs"


def separate_stems(audio_path: Path | str) -> list[Path]:
    """Separate an audio file into instrument stems using demucs.

    Runs the htdemucs model to split the track into bass, drums, vocals,
    and other. Stems are cached under demix/htdemucs/<stem>/ — subsequent
    calls on the same file return immediately without re-running.

    Writes are atomic: demucs outputs to a sibling staging dir first and is
    only swapped into place on success, so a crashed worker can't leave a
    half-populated cache entry behind.
    """
    audio_path = Path(audio_path)
    final_dir = DEMIX_DIR / MODEL / audio_path.stem

    if final_dir.exists() and any(final_dir.iterdir()):
        return sorted(final_dir.glob("*.wav"))

    final_dir.parent.mkdir(parents=True, exist_ok=True)
    staging_root = Path(tempfile.mkdtemp(prefix=f".{audio_path.stem}.", dir=final_dir.parent))
    try:
        subprocess.run(
            [sys.executable, "-m", "demucs.separate",
             "--out", str(staging_root), "--name", MODEL,
             str(audio_path)],
            check=True,
        )
        produced = staging_root / MODEL / audio_path.stem
        if final_dir.exists():
            # Another worker won the race — discard our work and use theirs.
            return sorted(final_dir.glob("*.wav"))
        os.replace(produced, final_dir)
    finally:
        if staging_root.exists():
            shutil.rmtree(staging_root, ignore_errors=True)

    return sorted(final_dir.glob("*.wav"))
