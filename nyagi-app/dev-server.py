#!/usr/bin/env python3
"""
NYAGI 開発用サーバー
- 静的ファイルを配信
- /api/* を Worker (localhost:8787) にプロキシ → CORS 回避
"""
import http.server
import urllib.request
import urllib.error
import json
import os

PORT = 8001
API_PROXY = 'http://127.0.0.1:8787'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        if self.path.startswith('/api/'):
            self.proxy_request('GET')
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith('/api/'):
            self.proxy_request('POST')
        else:
            super().do_POST()

    def do_PUT(self):
        if self.path.startswith('/api/'):
            self.proxy_request('PUT')
        else:
            super().do_PUT()

    def do_OPTIONS(self):
        if self.path.startswith('/api/'):
            self.proxy_request('OPTIONS')
        else:
            super().do_OPTIONS()

    def proxy_request(self, method):
        url = API_PROXY + self.path
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length) if length else None
        except Exception:
            body = None

        req = urllib.request.Request(url, data=body, method=method)
        for h in ['Content-Type', 'X-Admin-Key', 'X-Staff-Id']:
            v = self.headers.get(h)
            if v:
                req.add_header(h, v)
        req.add_header('Origin', 'http://localhost:' + str(PORT))

        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                self.send_response(r.status)
                for k, v in r.headers.items():
                    if k.lower() not in ('transfer-encoding', 'connection'):
                        self.send_header(k, v)
                self.send_header('Access-Control-Allow-Origin', 'http://localhost:' + str(PORT))
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
    try:
        httpd = http.server.HTTPServer(('', PORT), ProxyHandler)
        print('NYAGI dev server: http://localhost:%d/nyagi-app/' % PORT)
        print('API proxy: /api/* -> %s (same-origin, no CORS)' % API_PROXY)
        print('(port 8001 = same-origin, no CORS)')
        httpd.serve_forever()
    except OSError as e:
        if '10013' in str(e) or 'Address already in use' in str(e):
            print('Port %d in use. Stop other server or use: python dev-server.py (edit PORT to 8001)' % PORT)
        raise
