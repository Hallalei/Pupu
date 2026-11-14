"""出空间图标。

    python3 design/space-icons/export.py

- out/<id>.svg：矢量，fill 是 currentColor，跟着文字色或空间色走；
- out/<id>@3x.png：48×48 黑色模板图，iOS 当 template image 用；
- out/overview.png：总览，每个图标放在六种空间色的标记方块上看一遍。
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from icons import ICONS  # noqa: E402

OUT = os.path.join(HERE, "out")
# 设计规范里的空间色：标记方块用的 mark 色（空间色往墨色压 30%）。
MARKS = ["#3a4049", "#3d443c", "#4a4037", "#423e4a", "#47463a", "#3e3e40"]
SPACES = ["#b9d3f0", "#c4dcc2", "#f4cfae", "#d9cbf3", "#ecebab", "#cfcfd3"]


def svg(rows):
    """按行合并成矩形，一行一段一个 rect。"""
    rects = []
    for y, row in enumerate(rows):
        x = 0
        while x < 16:
            if row[x] == "#":
                start = x
                while x < 16 and row[x] == "#":
                    x += 1
                rects.append(f'<rect x="{start}" y="{y}" width="{x - start}" height="1"/>')
            else:
                x += 1
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges" fill="currentColor">'
            + "".join(rects) + "</svg>\n")


def png(rows, scale, color=(0, 0, 0, 255)):
    im = Image.new("RGBA", (16 * scale, 16 * scale), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch == "#":
                d.rectangle([x * scale, y * scale, (x + 1) * scale - 1, (y + 1) * scale - 1], fill=color)
    return im


def rgba(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5)) + (255,)


def font(size):
    for path in ("/System/Library/Fonts/Hiragino Sans GB.ttc", "/System/Library/Fonts/STHeiti Medium.ttc"):
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def overview():
    cols, cell = 5, 220
    items = list(ICONS.items())
    rows = (len(items) + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * cell, rows * 190 + 20), rgba("#f3f3f1"))
    d = ImageDraw.Draw(sheet)
    for i, (iid, (name, grid)) in enumerate(items):
        x, y = (i % cols) * cell + 20, (i // cols) * 190 + 20
        # 大图：空间色底，墨色图标
        tile = Image.new("RGBA", (96, 96), (0, 0, 0, 0))
        ImageDraw.Draw(tile).rounded_rectangle([0, 0, 95, 95], 20, fill=rgba(SPACES[i % 6]))
        tile.alpha_composite(png(grid, 4, rgba("#1b1b1a")), (16, 16))
        sheet.alpha_composite(tile, (x, y))
        # 实际大小：16pt @2x 的标记方块，白图标
        small = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
        ImageDraw.Draw(small).rounded_rectangle([0, 0, 31, 31], 8, fill=rgba(MARKS[i % 6]))
        small.alpha_composite(png(grid, 2, (255, 255, 255, 255)))
        sheet.alpha_composite(small, (x + 112, y))
        # 不带方块，直接墨色
        sheet.alpha_composite(png(grid, 2, rgba("#1b1b1a")), (x + 112, y + 44))
        d.text((x, y + 104), name, fill=rgba("#1b1b1a"), font=font(22))
        d.text((x, y + 134), iid, fill=rgba("#6f6f6a"), font=font(16))
    return sheet


def main():
    os.makedirs(OUT, exist_ok=True)
    for iid, (_name, grid) in ICONS.items():
        with open(os.path.join(OUT, f"{iid}.svg"), "w") as f:
            f.write(svg(grid))
        png(grid, 3).save(os.path.join(OUT, f"{iid}@3x.png"), optimize=True)
    overview().convert("RGB").save(os.path.join(OUT, "overview.png"), optimize=True)
    print(f"{len(ICONS)} 个空间图标 → {os.path.relpath(OUT, os.path.dirname(os.path.dirname(HERE)))}")


if __name__ == "__main__":
    main()
