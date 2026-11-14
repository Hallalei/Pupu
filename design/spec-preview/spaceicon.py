"""把 design/space-icons 的像素图标变成内联 svg，往规范的预览里贴。

    python3 -c "import spaceicon; print(spaceicon.svg('globe'))"
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "space-icons"))
from icons import ICONS  # noqa: E402


def svg(iid):
    rects = []
    for y, row in enumerate(ICONS[iid][1]):
        x = 0
        while x < 16:
            if row[x] == "#":
                start = x
                while x < 16 and row[x] == "#":
                    x += 1
                rects.append(f'<rect x="{start}" y="{y}" width="{x - start}" height="1"/>')
            else:
                x += 1
    return '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' + "".join(rects) + "</svg>"


def name(iid):
    return ICONS[iid][0]
