# Claude 아티팩트용 단일 HTML 만들기: python3 tools/bundle_artifact.py . <출력.html>
import re, sys, pathlib
src = pathlib.Path(sys.argv[1]); out = pathlib.Path(sys.argv[2])
html = (src/'index.html').read_text()
title = re.search(r'<title>(.*?)</title>', html).group(1)
body = re.search(r'<body>(.*)</body>', html, re.S).group(1)
body = re.sub(r'\s*<script src="app\.js(\?v=[^"]*)?"></script>\s*', '\n', body)
css = (src/'styles.css').read_text()
js = (src/'app.js').read_text()
out.write_text(f'<title>{title}</title>\n<style>\n{css}\n</style>\n{body}\n<script>\n{js}\n</script>\n')
print(out, len(out.read_text()))
