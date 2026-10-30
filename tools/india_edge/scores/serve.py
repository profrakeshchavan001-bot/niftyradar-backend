"""Local preview: python scores/serve.py [port]  ->  http://127.0.0.1:8765/web/

Serves ONLY /web/* and /out/*.json from this folder. Python sources and config.yaml (the formulas and
weights) are never served; every other path is 404.
"""
import functools
import http.server
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse

HERE = Path(__file__).resolve().parent


def allowed(path: str) -> bool:
    p = unquote(urlparse(path).path)
    if ".." in p.split("/"):
        return False
    return p in ("/", "/web", "/web/") or p.startswith("/web/") and not p.endswith(".py") or \
        (p.startswith("/out/") and p.endswith(".json"))


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/":
            self.send_response(302); self.send_header("Location", "/web/"); self.end_headers(); return
        if not allowed(self.path):
            self.send_error(404); return
        super().do_GET()

    do_HEAD = do_GET


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=str(HERE))).serve_forever()
