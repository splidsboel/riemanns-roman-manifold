from pgvector.sqlalchemy import Vector
from sqlalchemy import Column, DateTime, Float, ForeignKey, Integer, JSON, String, func
from sqlalchemy.orm import relationship

from .config import EMBEDDING_DIM
from .engine import Base


class Sample(Base):
    __tablename__ = "samples"

    id = Column(Integer, primary_key=True)
    path = Column(String, unique=True, nullable=False)
    filename = Column(String, nullable=False)
    duration_sec = Column(Float, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    embedding = Column(Vector(EMBEDDING_DIM), nullable=True)
    umap_x = Column(Float, nullable=True)
    umap_y = Column(Float, nullable=True)
    umap_z = Column(Float, nullable=True)
    cluster = Column(Integer, nullable=True)

    chord_sections = relationship(
        "ChordSection", back_populates="sample", cascade="all, delete"
    )


class ChordSection(Base):
    __tablename__ = "chord_sections"

    id = Column(Integer, primary_key=True)
    sample_id = Column(
        Integer, ForeignKey("samples.id", ondelete="CASCADE"), nullable=False
    )
    section_index = Column(Integer, nullable=False)
    start_sec = Column(Float, nullable=False)
    end_sec = Column(Float, nullable=False)
    key = Column(String, nullable=False)         # e.g. "C major"
    progression = Column(String, nullable=False) # e.g. "I - vi - IV - V"
    chords = Column(JSON, nullable=False)         # ["Cmaj", "Amin", "Fmaj", "Gmaj"]

    sample = relationship("Sample", back_populates="chord_sections")
