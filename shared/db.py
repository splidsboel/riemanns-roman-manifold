from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, Session
from sqlalchemy.pool import NullPool

from shared.config import get_config


def get_engine():
    config = get_config()
    return create_engine(
        config.database_url,
        poolclass=NullPool,
        echo=False,
    )


def get_session_factory():
    engine = get_engine()
    return sessionmaker(bind=engine, class_=Session)


def test_connection():
    engine = get_engine()
    with engine.connect() as conn:
        result = conn.execute(text("SELECT 1"))
        return result.scalar() == 1
