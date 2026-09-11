#!/bin/zsh
# Bump the ?v= stamp on style.css and app.js so browsers fetch the new files
# immediately instead of serving GitHub Pages' 10-minute cache.
cd "$(dirname "$0")"
python3 - "$@" << 'PY'
import io, re
p = "index.html"
s = io.open(p, encoding="utf-8").read()
cur = int((re.search(r'style\.css\?v=(\d+)', s) or [0, 0])[1] or 0)
nxt = cur + 1
s = re.sub(r'href="style\.css\?v=\d+"', f'href="style.css?v={nxt}"', s)
s = re.sub(r'src="app\.js\?v=\d+"', f'src="app.js?v={nxt}"', s)
io.open(p, "w", encoding="utf-8").write(s)
print(f"bumped to v={nxt}")
PY
