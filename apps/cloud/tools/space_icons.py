"""把空间图标的 svg 变成网页用的 path 数据。

    python3 apps/cloud/tools/space_icons.py

源头是 design/space-icons（规范资产「空间图标」也从那里来）：改了图标先跑那边的 export.py，再跑这个。
每个 rect 变成一段 `M x y h w v h h -w z`，16×16 网格，`fill: currentColor`。
"""
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "../../.."))
SRC = os.path.join(ROOT, "design/space-icons/out")
DST = os.path.join(ROOT, "apps/cloud/src/client/space-icons.ts")
ORDER = ["folder", "rocket", "house", "book", "briefcase", "code", "chart", "palette", "music", "camera",
         "leaf", "globe", "heart", "star", "coffee", "gift", "bulb", "flag", "chat", "paw"]

lines = []
for name in ORDER:
    svg = open(os.path.join(SRC, f"{name}.svg")).read()
    rects = re.findall(r'<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/>', svg)
    path = "".join(f"M{x} {y}h{w}v{h}h-{w}z" for x, y, w, h in rects)
    lines.append(f'  {name}: "{path}"')

out = (
    "// 由 apps/cloud/tools/space_icons.py 从 design/space-icons/out/*.svg 生成，不要手改。\n"
    'import type { SpaceIcon } from "../space-look";\n\n'
    "/** 二十个空间图标的像素，16×16 网格，一个 path 画完。 */\n"
    "export const SPACE_ICON_PATHS: Record<SpaceIcon, string> = {\n" + ",\n".join(lines) + "\n};\n"
)
open(DST, "w").write(out)
print(f"{len(ORDER)} icons -> {os.path.relpath(DST, ROOT)}")
