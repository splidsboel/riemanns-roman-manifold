# riemanns-roman-manifold

3D vector space visualization of ragrats chunks. Reads 2556-dimensional embeddings from the ragrats PostgreSQL database, reduces to 3D via UMAP, and renders as an interactive Three.js point cloud.

## Repo structure

```
api/            # FastAPI backend — REST endpoints, serves static UI
ui/             # Vanilla Three.js frontend — interactive 3D visualization
pipeline/       # UMAP dimensionality reduction (2556D → 3D)
shared/         # Database config, models, utilities
```

## Architecture

### Backend (Python)
- **Framework**: FastAPI + uvicorn
- **Database**: PostgreSQL on localhost:5433 (ragrats instance)
- **Dimensionality reduction**: UMAP → 3D coordinates, computed on startup
- **API style**: REST (GET /api/chunks, GET /api/chunk/{id})

### Frontend
- **Rendering**: Vanilla Three.js
- **Interaction**: Drag to rotate, scroll to zoom, click to inspect
- **Display**: Point cloud with vessel-based color coding; chunk text in bottom panel

## Setup

```bash
# Install uv
curl -LsSf https://astral.sh/uv/install.sh | sh

# Install dependencies
uv sync

# Run the API
uv run uvicorn api.main:app --reload
```

API runs on http://localhost:8000

## Database

Reads from ragrats database:
- Host: localhost:5433
- User: teamragrats
- Password: ragrats
- Database: ragrats
- Table: chunks (with 2556D embedding vectors)

## Data flow

1. Startup: Load all chunks from `chunks` table
2. Compute: UMAP reduction of 2556D embeddings to 3D
3. Serve: API returns chunks with 3D coordinates
4. Render: Three.js visualizes points in 3D space
5. Interact: Click point → display text in panel

## Development notes

- No embedding model runs during visualization (uses pre-computed vectors)
- UMAP parameters: n_components=3, n_neighbors=15, min_dist=0.1
- Point colors hash vessel name for consistency
- Auto-rotation pauses on drag
