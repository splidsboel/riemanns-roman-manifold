# riemanns-roman-manifold

Music producers explore their sample libraries through 3D vector space visualization and semantic search. Samples are embedded using CLAP models, reduced to 3D via UMAP, and rendered as an interactive scene in Three.js.

## Repo structure

```
api/            # Python FastAPI service (uvicorn) — REST endpoints, serves frontend static files
ui/             # Vanilla Three.js frontend — interactive 3D visualization, Web Audio playback
pipeline/       # Audio processing — embedding (CLAP), metadata extraction, UMAP computation
producerpal/    # Ableton Live AI assistant — OSC bridge + Gemma 4 agent
shared/         # Shared Python utilities (DB models, config, types)
docker/         # Docker Compose config (pgvector, Ollama/Gemma 4)
data/           # Local sample data directory (not committed)
```

Flat monorepo. Single Python project with `uv` for dependency management.

## Architecture

### Backend (Python)
- **Framework**: FastAPI + uvicorn
- **Database**: PostgreSQL + pgvector (Docker Compose)
- **Embedding model**: LAION CLAP (starting point — may experiment with other models)
- **Dimensionality reduction**: UMAP → 3D coordinates, pre-computed and stored in DB
- **API style**: REST (WebSocket planned for future Ableton integration)

### Frontend
- **Rendering**: Vanilla Three.js (no framework)
- **Visualization**: Interactive 3D nodes — clickable, hoverable, showing sample metadata
- **Audio**: Web Audio API for in-browser sample playback
- **Serving**: Static files served by the Python API (single origin, no CORS)
- **Navigation mode**: FPS-style pointer-lock, WASD + arrow keys for movement, Space/Shift for up/down

## UI

The semantic-search pane lives in `ui/` — vanilla Three.js, no build step, served directly as static files. Detailed change log in `ui/CHANGES.md`.

### Design language
- **Palette**: pure black + white, with a single red accent (`#d40000`) used *only* for current location + destination markers in the global-world cube.
- **Typography**: JetBrains Mono (typewriter aesthetic), uppercase bracket-delimited tokens in the HUD (`[ wasd ]`, `[ esc ]`).
- **Shapes**: angular 1px black borders on white for all panels; points rendered as round anti-aliased black discs (no cluster colors, no sprites with spikes).

### Layout (fixed-position zones)
- **Local world** — full-viewport Three.js canvas. FPS pointer-lock, WASD/arrows + Space/Shift.
- **Semantic search** (bottom-left) — text input, Enter triggers the 3-phase search flow.
- **Global world** (bottom-right) — 220×220 canvas with a rotating 1×1×1 wireframe cube acting as a minimap. Shows red current-location sphere continuously; red destination sphere + black travel line appear during a search and clear on arrival.
- **Settings** (top-right `[ * ]`) — toggle panel with 5 sliders: world scale, cluster density, point size, move speed, fog.
- **Crosshair** (center, always visible) — small black dot replacing the old hover-tooltip; filename appears beneath when a point sits on the crosshair (works under pointer lock).

### Search flow (3 phases, parallel local + global)
1. **Gimbal** (`runGimbal`, 600 ms) — camera stays in place, rotation eases toward the match centroid. Yaw wrapped to nearest angle so it never spins the long way.
2. **Illuminate** (`runIlluminate`, 1000 ms) — matched points pulse via per-vertex `aIllum` attribute: disc grows slightly *and* radiates a thin black ring outward (stays inside the B/W palette).
3. **Travel** (`runTravel`, 1500 ms) — camera lerps to the centroid with a small offset. `setGlobalDestination()` is called at the *start* of this phase so the local fly-in and the global-cube line appear and complete simultaneously (shared `PHASE.TRAVEL_MS`).

After arrival: destination marker + line removed, illumination cleared, status reads `arrived · N results`.

### Standalone demo mode
When `/visualization/status` is unreachable, the UI falls back to a generated 6-cluster × 250-point demo cloud. `doSearch()` also has a fake-search path (`pickDemoMatches`) that hashes the query and picks a deterministic cluster, so the gimbal/illuminate/travel animation can be exercised end-to-end without a backend. Serve the `ui/` folder over any static HTTP server (`python3 -m http.server`) and open the root.

### Planned three-pane shell
The UI will eventually live inside a tiled three-pane layout (ProducerPal · Ableton · Semantic Search) that is locked together so panes don't need per-window resizing. The current DOM is flat and every element uses `position: fixed` — migration path is to wrap the pane in a single `#search-root` container and switch children to a relative grid. The Three.js renderers already accept target canvases, so only CSS needs to move.

### Backend endpoints expected by the UI
Not yet implemented on the API side — until they exist, demo fallback kicks in.

| Method | Endpoint | Purpose |
|---|---|---|
| `GET`  | `/visualization/status` | Bootstrap polling |
| `GET`  | `/visualization/layout` | Initial point cloud — `{points: [{path, filename, x, y, z, cluster}]}` |
| `POST` | `/search` | `{query, k}` → `{results: [{path, ...}]}` |

### Search
- **Text-to-audio**: Natural language queries ("warm pad", "punchy kick") via CLAP text embeddings → pgvector cosine similarity
- **Audio-to-audio**: Select/upload a sample → find similar via CLAP audio embeddings → pgvector cosine similarity

### Pipeline
- Triggered via API endpoint (not CLI)
- Processes audio files from a configured directory on the host machine
- Supported formats: WAV, MP3
- Long files (full songs) are pre-processed before embedding — split into stems, then segments

#### Implemented steps
- **Stem separation** (`pipeline/separate_stems.py`): splits a track into bass, drums, vocals, other using [demucs](https://github.com/facebookresearch/demucs) (htdemucs model). Output cached under `demix/`. Returns list of WAV paths.

#### Planned steps (not yet implemented)
- **Structural segmentation**: split stems/tracks into verse, chorus, bridge, etc. — boundaries snapped to nearest downbeat
- **Metadata extraction**: BPM, key, roman numeral analysis (spec TBD)
- **CLAP embedding**: compute audio embeddings → store in pgvector
- **UMAP recomputation**: triggered via API endpoint when new samples are added

### ProducerPal
- AI assistant that knows Ableton Live's functionality and can control it
- **Ableton bridge**: AbletonOSC Max for Live device — OSC protocol (send port 11000, receive port 11001)
- **LLM**: Gemma 4 running locally via Ollama (Docker Compose service, port 11434)
- **Transport**: WebSocket between API and frontend for real-time interaction
- **Scope**: Can query and control Live's session view, tracks, clips, devices, and transport

## Deployment

- **Backend host**: NVIDIA DGX Spark (Ubuntu) — runs API, pipeline, pgvector (Docker Compose)
- **Demo**: MacBook (macOS) with mirror dataset — same Docker Compose setup
- **Cross-platform**: Must work on both Ubuntu and macOS
- **Frontend**: Served by the API, accessed via browser on any machine

## Docker containers

Startes altid via CLI-script (ikke Docker Desktop — understøtter ikke GPU):
```bash
bash docker/start.sh
```

| Container | Image | Port | Formål |
|---|---|---|---|
| `docker-pgvector-1` | `pgvector/pgvector:pg16` | `5432` | PostgreSQL + pgvector extension |
| `docker-ollama-1` | `ollama/ollama:latest` | `11434` | Ollama LLM runtime |

**Ollama-modeller hentet:**
- `gemma4:26b` (17 GB, MoE) — produktionsmodel til ProducerPal
- `gemma3:1b` (777 MB) — testmodel

**pgvector:**
- Database: `manifold`, user: `postgres`, password: `postgres`
- `vector`-extension er aktiveret og klar til brug
- Bekræftet: forbindelse OK, CREATE TABLE/DROP TABLE virker

## Development

### Setup
```bash
# Install uv (if not installed)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Install system dependencies (required for audio processing)
brew install ffmpeg   # macOS

# Install Python dependencies
uv sync

# Start containers (pgvector + Ollama)
bash docker/start.sh

# Run the API (serves frontend too)
uv run uvicorn api.main:app --reload
```

### Testing
Minimal tests for critical paths only (pipeline processing, search endpoints). No enforced linting or formatting.

### Scale target
Up to 100,000 samples per library.

## Future work (not yet specified)
- WebSocket support for ProducerPal real-time chat interface
- Detailed metadata extraction specification (BPM, key, spectral features, etc.)
- Advanced 3D navigation modes

## Reference
- Inspiration repo: https://github.com/splidsboel/samplevec
- This file will be continuously updated as individual features are specified
