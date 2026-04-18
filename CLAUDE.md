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
- **Navigation mode**: TBD — will be specified when visualization work begins

### Search
- **Text-to-audio**: Natural language queries ("warm pad", "punchy kick") via CLAP text embeddings → pgvector cosine similarity
- **Audio-to-audio**: Select/upload a sample → find similar via CLAP audio embeddings → pgvector cosine similarity

### Pipeline
- Triggered via API endpoint (not CLI)
- Processes audio files from a configured directory on the host machine
- Supported formats: WAV, MP3
- Steps: load audio → extract metadata (spec TBD) → compute CLAP embedding → store in pgvector
- UMAP coordinates are pre-computed after embedding, with an API endpoint to trigger recomputation when new samples are added

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

## Development

### Setup
```bash
# Install uv (if not installed)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Install Python dependencies
uv sync

# Start pgvector
docker compose -f docker/docker-compose.yml up -d

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
