"""
AbletonOSC bridge — communicates with Ableton Live via OSC (port 11000 send, 11001 receive).
Requires AbletonOSC Max for Live device loaded in the Live set.
"""
from pythonosc.udp_client import SimpleUDPClient
from pythonosc.dispatcher import Dispatcher
from pythonosc.osc_server import AsyncIOOSCUDPServer
import asyncio

ABLETON_HOST = "127.0.0.1"
SEND_PORT = 11000
RECV_PORT = 11001

_client = SimpleUDPClient(ABLETON_HOST, SEND_PORT)


def send(address: str, *args) -> None:
    _client.send_message(address, list(args))


async def listen(handlers: dict[str, object]) -> None:
    dispatcher = Dispatcher()
    for address, handler in handlers.items():
        dispatcher.map(address, handler)
    server = AsyncIOOSCUDPServer(
        (ABLETON_HOST, RECV_PORT), dispatcher, asyncio.get_event_loop()
    )
    transport, _ = await server.create_serve_endpoint()
    return transport
