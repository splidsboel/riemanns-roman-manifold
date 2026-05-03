from sqlalchemy import Column, String, Integer, Float, Text, ARRAY
from sqlalchemy.orm import declarative_base
from pgvector.sqlalchemy import Vector

Base = declarative_base()


class Chunk(Base):
    __tablename__ = "chunks"

    id = Column(String, primary_key=True)
    table_name = Column(String)
    thread_id = Column(String)
    vessel_name = Column(String)
    chunk_index = Column(Integer)
    text = Column(Text)
    embedding = Column(Vector(2556))
    token_count = Column(Integer)
    embedding_model = Column(String)
