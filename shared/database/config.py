import os

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql+psycopg://postgres:postgres@localhost:5432/manifold",
)

# CLAP 2023 model produces 1024-dim embeddings.
EMBEDDING_DIM = 1024
