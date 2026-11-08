"""로컬 미리보기용 서버. 브라우저가 예전 app.js/styles.css 를 캐시해 쓰지 않도록 no-store 헤더를 붙인다.

사용: python3 dev_server.py [포트]   (기본 8769, 이 폴더를 그대로 서비스)
"""
import functools
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8769
    handler = functools.partial(NoCacheHandler, directory=os.path.dirname(os.path.abspath(__file__)))
    http.server.ThreadingHTTPServer(('', port), handler).serve_forever()
