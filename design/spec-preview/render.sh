#!/bin/zsh
# 用法：render.sh <project 目录> <组件名或 html 相对路径> [dark]
# 本机看设计规范的组件预览：把 tokens.json 变成 CSS 变量，连同 bundle.css 插进预览页，
# 用无头 Chrome 按 2x 截图，截到 out/。只近似 claude.ai 上的样子，够看裁切、对比和像素糊没糊。
# <project 目录> 是用 Artifact 的 read 把「Pupu 设计规范」的 project/ 拉到本地的那个目录。
H=${0:A:h}; P=$1; F=$2; THEME=${3:-light}
mkdir -p $H/out
[[ $F == *.html ]] || F=components/$F/preview.html
/usr/bin/python3 $H/gen_css.py $P/tokens.json $H/tokens.css >/dev/null
html=$P/$F
size=$(grep -o '@dsCard[^>]*' $html | head -1)
w=$(echo $size | grep -o 'width=[0-9]*' | cut -d= -f2); h=$(echo $size | grep -o 'height=[0-9]*' | cut -d= -f2)
w=${w:-390}; h=${h:-400}
name=$(echo $F | tr '/' '_' | sed 's/.html$//')
tmp=$H/out/$name-$THEME.html
/usr/bin/python3 - "$html" "$tmp" "$THEME" "$H" "$P" <<'PY'
import sys
src, dst, theme, H, P = sys.argv[1:]
s = open(src).read()
inject = f'<link rel="stylesheet" href="file://{H}/tokens.css"><link rel="stylesheet" href="file://{P}/components/bundle.css">'
import re
m = re.search(r"@dsCard[^>]*width=(\d+)", s); w = int(m.group(1)) if m else 390
inject += f"<style>html,body{{width:{w}px;overflow:hidden}}</style>"
s = s.replace("<head>", "<head>" + inject, 1) if "<head>" in s else inject + s
if theme == "dark":
    s = s.replace("<html", '<html data-theme="dark"', 1)
open(dst, "w").write(s)
PY
ww=$(( w < 800 ? 800 : w ))
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --window-size=$ww,$h --screenshot=$H/out/$name-$THEME.png file://$tmp >/dev/null 2>&1
/usr/bin/python3 -c "from PIL import Image; im=Image.open('$H/out/$name-$THEME.png'); im.crop((0,0,$w*2,$h*2)).save('$H/out/$name-$THEME.png')"
echo $H/out/$name-$THEME.png
