from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    db_host: str = "localhost"
    db_port: int = 5433
    db_user: str = "teamragrats"
    db_password: str = "ragrats"
    db_name: str = "ragrats"

    @property
    def database_url(self) -> str:
        return f"postgresql+psycopg://{self.db_user}:{self.db_password}@{self.db_host}:{self.db_port}/{self.db_name}"


def get_config() -> Config:
    return Config()
