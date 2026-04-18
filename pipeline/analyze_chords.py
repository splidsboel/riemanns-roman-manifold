"""
Chord analysis pipeline step.

Takes an audio file, separates stems, mixes the harmonic stems (bass + other),
extracts notes via basic-pitch, then uses music21 to identify key and chord
progressions. Results are grouped into sections and stored in the database.

Usage:
    from pipeline.analyze_chords import analyze_chords
    sections = analyze_chords("path/to/song.mp3")
"""

import re
import tempfile
from collections import Counter
from pathlib import Path

import numpy as np
import soundfile as sf
from music21 import chord as m21chord
from music21 import key as m21key
from music21 import note as m21note
from music21 import roman
from music21 import stream
from music21 import tempo as m21tempo

from pipeline.separate_stems import separate_stems
from shared.db import engine, get_session
from shared.models import Base, ChordSection, Sample

# Cached basic-pitch model (loaded on first call to _extract_notes)
_BP_MODEL = None


def _get_bp_model():
    global _BP_MODEL
    if _BP_MODEL is None:
        from basic_pitch import ICASSP_2022_MODEL_PATH
        from basic_pitch.inference import Model
        _BP_MODEL = Model(ICASSP_2022_MODEL_PATH)
    return _BP_MODEL


def _get_harmonic_mix(audio_path: Path) -> Path:
    """Separate stems and mix bass + other into a single mono WAV."""
    stems = separate_stems(audio_path)
    harmonic = [p for p in stems if p.stem in ("bass", "other")]

    if not harmonic:
        return audio_path  # fallback to full mix

    arrays = []
    sr = None
    for p in harmonic:
        data, file_sr = sf.read(str(p))
        if sr is None:
            sr = file_sr
        if data.ndim > 1:
            data = data.mean(axis=1)
        arrays.append(data)

    max_len = max(len(a) for a in arrays)
    mixed = np.zeros(max_len, dtype=np.float32)
    for a in arrays:
        mixed[: len(a)] += a.astype(np.float32)

    peak = np.abs(mixed).max()
    if peak > 0:
        mixed = mixed / peak * 0.9

    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    sf.write(tmp.name, mixed, sr)
    return Path(tmp.name)


def _extract_notes(audio_path: Path) -> list:
    """Run basic-pitch on audio. Returns list of (start_s, end_s, pitch_midi, amp, ...)."""
    from basic_pitch.inference import predict

    model = _get_bp_model()
    _, _, note_events = predict(str(audio_path), model)
    return note_events


def _build_chord_groups(note_events: list) -> list[tuple[float, list[int]]]:
    """
    Group notes that start within WINDOW seconds of each other into chords.
    Returns list of (time_sec, [pitch_midi, ...]).
    """
    if not note_events:
        return []

    WINDOW = 0.08  # 80 ms — notes within this window are considered simultaneous

    events = sorted(note_events, key=lambda e: e[0])
    groups = []
    i = 0
    while i < len(events):
        t = events[i][0]
        pitches = {int(events[i][2])}
        j = i + 1
        while j < len(events) and events[j][0] - t < WINDOW:
            pitches.add(int(events[j][2]))
            j += 1
        groups.append((t, sorted(pitches)))
        i = j

    return groups


def _detect_key(note_events: list, chord_groups: list) -> m21key.Key:
    """
    Estimate the global key from note events using music21.

    music21 tends to prefer major keys. If the detected key is major but its
    relative minor's tonic appears more often as a chord root, switch to
    relative minor.
    """
    part = stream.Part()
    part.insert(0, m21tempo.MetronomeMark(number=120))

    for start_s, end_s, pitch, *_ in note_events[:500]:
        n = m21note.Note(int(pitch))
        n.duration.quarterLength = max(0.125, (end_s - start_s) * 2.0)
        part.insert(start_s * 2.0, n)

    detected = part.analyze("key")

    if detected.mode == "major":
        root_counts: Counter = Counter()
        for _, pitches in chord_groups:
            if len(pitches) >= 3:
                c = m21chord.Chord(pitches)
                if c.quality != "other":
                    try:
                        root_counts[c.root().pitchClass] += 1
                    except Exception:
                        pass

        major_pc = detected.tonic.pitchClass
        rel_minor_pc = (major_pc + 9) % 12  # relative minor tonic
        if root_counts.get(rel_minor_pc, 0) > root_counts.get(major_pc, 0):
            detected = detected.relative

    return detected


def _chord_label(c: m21chord.Chord) -> str:
    """Return a short chord label like 'Amin', 'Cmaj', 'Bdim'."""
    try:
        root = c.root().name.replace("-", "b")  # E- → Eb
        suffix = {"major": "maj", "minor": "min", "diminished": "dim", "augmented": "aug"}.get(
            c.quality, c.quality
        )
        return root + suffix
    except Exception:
        return "?"


_FIGURE_RE = re.compile(r"^([b#]*)([IViv]+)([+o°]?)")


def _roman_figure(c: m21chord.Chord, key: m21key.Key) -> str:
    """
    Return a simplified roman numeral for a chord in a given key.
    Strips inversion and extension suffixes, keeping only the scale degree,
    accidental prefix, and quality marker (+ or o).
    e.g. 'vii65#3' → 'vii', 'V+6' → 'V+', '#ivob75b2' → '#ivo'
    """
    try:
        figure = roman.romanNumeralFromChord(c, key).figure
        m = _FIGURE_RE.match(figure)
        return (m.group(1) + m.group(2) + m.group(3)) if m else figure
    except Exception:
        return "?"


def _detect_sections(
    chord_groups: list[tuple[float, list[int]]],
    key: m21key.Key,
    duration_sec: float,
) -> list[dict]:
    """
    Annotate chords with roman numerals, then group into sections.

    A new section starts when the set of roman numerals in a 4-chord window
    differs substantially from the current section's pattern.
    """
    # Annotate each chord group, skipping ambiguous/non-triadic chords
    annotated = []  # (time_sec, roman_fig, chord_label)
    for t, pitches in chord_groups:
        if len(pitches) < 3:  # need at least a triad
            continue
        c = m21chord.Chord(pitches)
        if c.quality == "other":  # non-triadic — not identifiable
            continue
        rn = _roman_figure(c, key)
        label = _chord_label(c)
        if rn != "?":
            annotated.append((t, rn, label))

    if not annotated:
        return [
            {
                "start_sec": 0.0,
                "end_sec": duration_sec,
                "key": str(key),
                "progression": "?",
                "chords": [],
            }
        ]

    # Deduplicate consecutive identical roman numerals
    deduped = [annotated[0]]
    for item in annotated[1:]:
        if item[1] != deduped[-1][1]:
            deduped.append(item)

    # Chunk into groups of 8 chords; each chunk is a candidate section unit
    N = 8
    chunks = [deduped[i : i + N] for i in range(0, len(deduped), N)]

    # Merge adjacent chunks whose roman numeral sets overlap ≥ 50%
    merged = [chunks[0]]
    for chunk in chunks[1:]:
        prev_rns = frozenset(rn for _, rn, _ in merged[-1])
        curr_rns = frozenset(rn for _, rn, _ in chunk)
        union = prev_rns | curr_rns
        overlap = len(prev_rns & curr_rns) / len(union) if union else 0
        if overlap >= 0.5:
            merged[-1] = merged[-1] + chunk
        else:
            merged.append(chunk)

    # Build output dicts
    result = []
    for i, sec in enumerate(merged):
        start = sec[0][0]
        end = merged[i + 1][0][0] if i + 1 < len(merged) else duration_sec

        # Unique roman numerals and chord labels in first-occurrence order
        seen: set[str] = set()
        ordered_rns: list[str] = []
        ordered_labels: list[str] = []
        for _, rn, label in sec:
            if rn not in seen:
                seen.add(rn)
                ordered_rns.append(rn)
                ordered_labels.append(label)

        result.append(
            {
                "start_sec": round(start, 2),
                "end_sec": round(end, 2),
                "key": str(key),
                "progression": " - ".join(ordered_rns),
                "chords": ordered_labels,
            }
        )

    return result


def _store_results(audio_path: Path, duration_sec: float, sections: list[dict]) -> None:
    """Upsert sample row and replace its chord sections."""
    with get_session() as session:
        sample = session.query(Sample).filter_by(file_path=str(audio_path)).first()
        if sample is None:
            sample = Sample(file_path=str(audio_path), duration_sec=duration_sec)
            session.add(sample)
            session.flush()
        else:
            sample.duration_sec = duration_sec
            session.query(ChordSection).filter_by(sample_id=sample.id).delete()

        for idx, sec in enumerate(sections):
            session.add(
                ChordSection(
                    sample_id=sample.id,
                    section_index=idx,
                    start_sec=sec["start_sec"],
                    end_sec=sec["end_sec"],
                    key=sec["key"],
                    progression=sec["progression"],
                    chords=sec["chords"],
                )
            )

        session.commit()


def analyze_chords(audio_path: Path | str) -> list[dict]:
    """
    Full pipeline: separate stems → mix harmonic stems → extract notes →
    detect chord sections → store in DB.

    Args:
        audio_path: Path to an audio file (WAV or MP3).

    Returns:
        List of chord section dicts, each with keys:
        start_sec, end_sec, key, progression, chords.
    """
    audio_path = Path(audio_path)

    Base.metadata.create_all(engine)

    print(f"[analyze_chords] Separating stems: {audio_path.name}")
    harmonic_mix = _get_harmonic_mix(audio_path)

    print("[analyze_chords] Running basic-pitch note extraction...")
    note_events = _extract_notes(harmonic_mix)

    duration_sec = sf.info(str(harmonic_mix)).duration

    print(f"[analyze_chords] Detected {len(note_events)} note events. Building chord groups...")
    chord_groups = _build_chord_groups(note_events)
    print(f"[analyze_chords] Built {len(chord_groups)} chord groups. Detecting sections...")

    key = _detect_key(note_events, chord_groups)
    print(f"[analyze_chords] Key (refined): {key}")

    sections = _detect_sections(chord_groups, key, duration_sec)
    print(f"[analyze_chords] Found {len(sections)} section(s).")

    _store_results(audio_path, duration_sec, sections)
    print("[analyze_chords] Stored results to DB.")

    return sections
