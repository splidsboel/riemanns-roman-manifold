import httpx

OLLAMA_URL = "http://localhost:11434"
MODEL = "gemma4:26b"
MODEL_TEST = "gemma3:1b"


async def chat(messages: list[dict]) -> str:
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(
            f"{OLLAMA_URL}/api/chat",
            json={"model": MODEL, "messages": messages, "stream": False},
        )
        response.raise_for_status()
        return response.json()["message"]["content"]
