import os

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql+psycopg://postgres:postgres@localhost:5432/manifold",
)

# CLAP produces 512-dim embeddings. Kept as a single source of truth so seed
# data and real embeddings stay in sync when the real encoder lands.
EMBEDDING_DIM = 512
