"""
Pipeline orchestrator.

Discovers audio files in a directory, processes each one (stem separation
and chord analysis for files > 10 s, CLAP embedding for all), then
recomputes UMAP projections for the entire sample library.

CLI usage:
    uv run python -m pipeline.run /path/to/samples
"""

import sys
from pathlib import Path

import soundfile as sf
from sqlalchemy import text
from sqlalchemy.orm import Session

from pipeline.analyze_chords import analyze_chords
from pipeline.embed import embed_audio
from pipeline.umap_compute import recompute_umap
from shared.database import Base, ChordSection, Sample, SessionLocal, engine


def _ensure_schema() -> None:
    """Enable the pgvector extension and create all tables."""
    with engine.connect() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        conn.commit()
    Base.metadata.create_all(engine)

AUDIO_EXTENSIONS = {'.wav', '.mp3', '.flac', '.aiff', '.aif', '.ogg', '.m4a', '.opus'}


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


def _process_file(audio_path: Path, session: Session) -> None:
    if session.query(Sample).filter_by(path=str(audio_path)).first():
        print(f"[pipeline] Skipping (already processed): {audio_path.name}")
        return

    duration = _get_duration(audio_path)
    sample = Sample(path=str(audio_path), filename=audio_path.name, duration_sec=duration)
    session.add(sample)
    session.flush()

    if duration and duration > 10.0:
        print(f"[pipeline] Analyzing chords: {audio_path.name}")
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

    print(f"[pipeline] Embedding: {audio_path.name}")
    sample.embedding = embed_audio(audio_path).tolist()
    session.commit()


def run_pipeline(directory: str, job_id: str, jobs: dict) -> None:
    _ensure_schema()
    files = discover_audio_files(directory)
    jobs[job_id].update({'status': 'running', 'total': len(files)})
    print(f"[pipeline] Found {len(files)} audio files in {directory}")

    session = SessionLocal()
    try:
        for f in files:
            try:
                print(f"[pipeline] Processing: {f.name}")
                _process_file(f, session)
                jobs[job_id]['processed'] += 1
            except Exception as e:
                print(f"[pipeline] ERROR processing {f}: {e}")
                jobs[job_id]['errors'].append({'file': str(f), 'error': str(e)})
                session.rollback()

        recompute_umap(session)
    finally:
        session.close()

    jobs[job_id]['status'] = 'done'
    print(
        f"[pipeline] Done. {jobs[job_id]['processed']}/{jobs[job_id]['total']} processed, "
        f"{len(jobs[job_id]['errors'])} error(s)."
    )


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
