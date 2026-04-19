"""
Pipeline orchestrator.

(Uses ``from __future__ import annotations`` so threading.Lock can appear in
a type annotation — at runtime it's a factory function, not a class, so the
`X | None` form would otherwise fail on Python 3.11.)

Discovers audio files in a directory, processes each one (stem separation
and chord analysis for files > 10 s, CLAP embedding for all), then
recomputes UMAP projections for the entire sample library.

CLI usage:
    uv run python -m pipeline.run /path/to/samples
"""

from __future__ import annotations

import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import soundfile as sf
from sqlalchemy import text
from sqlalchemy.dialects.postgresql import insert as pg_insert

from pipeline.analyze_chords import analyze_chords
from pipeline.embed import embed_audio
from shared.database import Base, ChordSection, Sample, SessionLocal, engine


def _ensure_schema() -> None:
    """Enable the pgvector extension and create all tables."""
    with engine.connect() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        conn.commit()
    Base.metadata.create_all(engine)

AUDIO_EXTENSIONS = {'.wav', '.mp3', '.flac', '.aiff', '.aif', '.ogg', '.m4a', '.opus'}

DEFAULT_WORKERS = int(os.environ.get("PIPELINE_WORKERS", "4"))


def discover_audio_files(directory: str) -> list[Path]:
    return [
        p for p in Path(directory).rglob('*')
        if p.suffix.lower() in AUDIO_EXTENSIONS and not p.name.startswith('._')
    ]


def _get_duration(path: Path) -> float | None:
    try:
        return sf.info(str(path)).duration
    except Exception:
        return None


def _claim_sample(session, audio_path: Path, duration: float | None) -> tuple[Sample | None, bool]:
    """Ensure a sample row exists for this path. Returns ``(sample, is_new)``.

    Race-free via ``INSERT ... ON CONFLICT (path) DO NOTHING``:
      - winning inserter: ``(sample, True)``
      - losing inserter on an already-embedded row: ``(None, False)`` → skip
      - losing inserter on a row with ``embedding IS NULL``: ``(sample, False)`` → resume
    """
    stmt = (
        pg_insert(Sample)
        .values(path=str(audio_path), filename=audio_path.name, duration_sec=duration)
        .on_conflict_do_nothing(index_elements=["path"])
        .returning(Sample.id)
    )
    result = session.execute(stmt).first()
    session.commit()
    if result is not None:
        return session.get(Sample, result[0]), True

    existing = session.query(Sample).filter_by(path=str(audio_path)).first()
    if existing is None or existing.embedding is not None:
        return None, False
    return existing, False


def _process_file(audio_path: Path) -> str:
    """Process a single audio file. Opens its own DB session — safe to call from
    worker threads. Returns a short status string for logging.
    """
    session = SessionLocal()
    try:
        duration = _get_duration(audio_path)
        sample, is_new = _claim_sample(session, audio_path, duration)
        if sample is None:
            return "skipped"

        has_sections = (
            not is_new
            and session.query(ChordSection).filter_by(sample_id=sample.id).first() is not None
        )
        if duration and duration > 10.0 and not has_sections:
            sections = analyze_chords(audio_path)
            for i, sec in enumerate(sections):
                session.add(ChordSection(
                    sample_id=sample.id,
                    section_index=i,
                    start_sec=sec['start_sec'],
                    end_sec=sec['end_sec'],
                    key=sec['key'],
                    progression=sec['progression'],
                    chords=sec['chords'],
                ))

        sample.embedding = embed_audio(audio_path).tolist()
        session.commit()
        return "processed" if is_new else "resumed"
    finally:
        session.close()


def run_pipeline(
    directory: str,
    job_id: str,
    jobs: dict,
    jobs_lock: threading.Lock | None = None,
    workers: int | None = None,
) -> None:
    _ensure_schema()
    lock = jobs_lock or threading.Lock()
    workers = workers or DEFAULT_WORKERS

    files = discover_audio_files(directory)
    with lock:
        jobs[job_id].update({'status': 'running', 'total': len(files)})
    print(f"[pipeline] Found {len(files)} audio files in {directory} (workers={workers})")

    with ThreadPoolExecutor(max_workers=workers) as pool:
        future_to_file = {pool.submit(_process_file, f): f for f in files}
        for fut in as_completed(future_to_file):
            f = future_to_file[fut]
            try:
                status = fut.result()
            except Exception as e:
                print(f"[pipeline] ERROR {f.name}: {e}")
                with lock:
                    jobs[job_id]['errors'].append({'file': str(f), 'error': str(e)})
                continue
            with lock:
                jobs[job_id]['processed'] += 1
                n, total = jobs[job_id]['processed'], jobs[job_id]['total']
            print(f"[pipeline] [{n}/{total}] {status}: {f.name}")

    # Single-flight UMAP — coalesces with any UI-triggered fit and guarantees
    # our freshly-committed embeddings are included.
    from api.umap_service import run_blocking as run_umap_blocking
    run_umap_blocking()

    with lock:
        jobs[job_id]['status'] = 'done'
        processed = jobs[job_id]['processed']
        total = jobs[job_id]['total']
        errors = len(jobs[job_id]['errors'])
    print(f"[pipeline] Done. {processed}/{total} processed, {errors} error(s).")


if __name__ == '__main__':
    args = sys.argv[1:]
    reset_db = '--reset-db' in args
    dirs = [a for a in args if not a.startswith('--')]

    if not dirs:
        print("Usage: python -m pipeline.run [--reset-db] <directory>")
        sys.exit(1)

    if reset_db:
        print("[pipeline] Dropping and recreating schema...")
        Base.metadata.drop_all(engine)
        _ensure_schema()

    jobs: dict = {'cli': {'status': 'queued', 'processed': 0, 'total': 0, 'errors': []}}
    run_pipeline(dirs[0], 'cli', jobs)
    print(jobs['cli'])
