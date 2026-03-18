#!/usr/bin/env python3
"""
NYAGI 静的ファイル + /api プロキシ
- localhost: 8787 直（app.js で指定）
- LAN/Tailscale: 同一オリジン /api → 8787 プロキシ（モバイル回線＋VPN 可）
"""
import http.server
import urllib.request
import urllib.error
import json
import os

PORT = 8003
API_PROXY = 'http://127.0.0.1:8787'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class StaticWithProxyHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        if self.path.startswith('/api/'):
            self._proxy('GET')
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith('/api/'):
            self._proxy('POST')
        else:
            super().do_POST()

    def do_PUT(self):
        if self.path.startswith('/api/'):
            self._proxy('PUT')
        else:
            super().do_PUT()

    def do_PATCH(self):
        if self.path.startswith('/api/'):
            self._proxy('PATCH')
        else:
            super().do_PATCH()

    def do_OPTIONS(self):
        if self.path.startswith('/api/'):
            self._proxy('OPTIONS')
        else:
            super().do_OPTIONS()

    def _proxy(self, method):
        url = API_PROXY + self.path
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length) if length else None
        except Exception:
            body = None

        req = urllib.request.Request(url, data=body, method=method)
        for h in ['Content-Type', 'X-Admin-Key', 'X-Staff-Id', 'Origin', 'Referer']:
            v = self.headers.get(h)
            if v:
                req.add_header(h, v)

        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                self.send_response(r.status)
                for k, v in r.headers.items():
                    if k.lower() not in ('transfer-encoding', 'connection'):
                        self.send_header(k, v)
                self.end_headers()
                self.wfile.write(r.read())
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e.code), 'message': str(e.reason)}).encode())
        except (OSError, urllib.error.URLError) as e:
            errstr = str(e)
            if '10061' in errstr or 'Connection refused' in errstr or '接続できません' in errstr:
                msg = 'Worker (8787) が起動していません。run-dev.ps1 で Worker を先に起動してください。'
            else:
                msg = errstr
            self.send_response(503)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': 'connection_refused', 'message': msg}).encode())
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': 'proxy_error', 'message': str(e)}).encode())


if __name__ == '__main__':
    os.chdir(ROOT)
    httpd = http.server.HTTPServer(('', PORT), StaticWithProxyHandler)
    print('NYAGI: http://localhost:%d/nyagi-app/' % PORT)
    print('  LAN/Tailscale: http://<PCのIP>:%d/nyagi-app/  (モバイル回線＋VPN可)' % PORT)
    print('  API: 8787 直 or /api プロキシ. Login: 3374')
    httpd.serve_forever()
