from pgvector.sqlalchemy import Vector
from sqlalchemy import Column, Float, Integer, String

from .config import EMBEDDING_DIM
from .engine import Base


class Sample(Base):
    __tablename__ = "samples"

    id = Column(Integer, primary_key=True)
    path = Column(String, unique=True, nullable=False)
    filename = Column(String, nullable=False)
    embedding = Column(Vector(EMBEDDING_DIM), nullable=False)
    umap_x = Column(Float, nullable=False)
    umap_y = Column(Float, nullable=False)
    umap_z = Column(Float, nullable=False)
    cluster = Column(Integer, nullable=False)
