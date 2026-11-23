"""Servidor local del visor: como `python -m http.server`, pero obliga al navegador a comprobar
si hay versión nueva (Cache-Control: no-cache). Así, al regenerar datos o cambiar el visor,
basta con recargar la página; lo que no ha cambiado se sirve con 304 y sigue siendo rápido.
Escucha en IPv4 e IPv6 a la vez (localhost puede resolverse a ::1), igual que http.server."""
import functools
import http.server
import socket
import sys


class SinCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


class DobleStack(http.server.ThreadingHTTPServer):
    address_family = socket.AF_INET6
    daemon_threads = True

    def server_bind(self):
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except (AttributeError, OSError):
            pass
        super().server_bind()


if __name__ == "__main__":
    puerto = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    manejador = functools.partial(SinCache, directory=".")
    try:
        srv = DobleStack(("::", puerto), manejador)
    except OSError:                         # sin IPv6: solo IPv4
        srv = http.server.ThreadingHTTPServer(("", puerto), manejador)
    print(f"Servidor en http://localhost:{puerto}/visor/  (Ctrl+C o cierra la ventana para pararlo)")
    srv.serve_forever()
