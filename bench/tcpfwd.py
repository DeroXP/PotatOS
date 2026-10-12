# Tiny TCP forwarder: listen 0.0.0.0:LPORT -> 127.0.0.1:RPORT (runs in the client sidecar,
# so the CDP port of a headless Chromium that only binds 127.0.0.1 becomes publishable).
import asyncio, sys
LPORT, RPORT = int(sys.argv[1]), int(sys.argv[2])
async def pipe(r, w):
    try:
        while (d := await r.read(65536)):
            w.write(d); await w.drain()
    except Exception: pass
    finally:
        try: w.close()
        except Exception: pass
async def handle(cr, cw):
    try: ur, uw = await asyncio.open_connection('127.0.0.1', RPORT)
    except Exception: cw.close(); return
    await asyncio.gather(pipe(cr, uw), pipe(ur, cw))
async def main():
    srv = await asyncio.start_server(handle, '0.0.0.0', LPORT)
    async with srv: await srv.serve_forever()
asyncio.run(main())
