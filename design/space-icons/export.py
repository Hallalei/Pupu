"""出空间图标。

    python3 design/space-icons/export.py

- out/<id>.svg：矢量，fill 是 currentColor，跟着文字色或空间色走；
- out/<id>@3x.png：48×48 黑色模板图，iOS 当 template image 用；
- out/overview.png：总览，每个图标放在空间色的标记方块里，浅色和深色窗框上各看一遍。

颜色和尺寸照设计规范：方块底是空间原色（mark-*），图标是 on-mark，20pt 方块里画 16pt，40pt 里画 32pt。
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from icons import ICONS  # noqa: E402

OUT = os.path.join(HERE, "out")
# 设计规范 tokens.json 里的值：mark-*（就是空间原色）、on-mark，和默认强度下的窗框 frame-*。
SPACES = ["#b9d3f0", "#c4dcc2", "#f4cfae", "#d9cbf3", "#ecebab", "#cfcfd3"]
ON_MARK = "#1b1b1a"
FRAME_LIGHT = "#e2e9f1"
FRAME_DARK = "#1d1f22"


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


def tile(grid, cell, color):
    """一个标记方块：边长 = 图标 16 格 + 两边各 2 个 pt（按 cell 缩放），圆角是边长的 30%。"""
    side = (16 + 4) * cell
    im = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, side - 1, side - 1], round(side * 0.3), fill=rgba(color), outline=(0, 0, 0, 31), width=max(1, cell // 2))
    im.alpha_composite(png(grid, cell, rgba(ON_MARK)), (2 * cell, 2 * cell))
    return im


def overview():
    """@2x 画：大方块是 mark-lg 40，小方块是 mark 20，分别放在浅色和深色窗框上。"""
    cols, cell_w, cell_h = 5, 236, 200
    items = list(ICONS.items())
    rows = (len(items) + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * cell_w, rows * cell_h + 20), rgba(FRAME_LIGHT))
    d = ImageDraw.Draw(sheet)
    for i, (iid, (name, grid)) in enumerate(items):
        x, y = (i % cols) * cell_w + 20, (i // cols) * cell_h + 20
        color = SPACES[i % 6]
        sheet.alpha_composite(tile(grid, 4, color), (x, y))
        dark = Image.new("RGBA", (64, 64), rgba(FRAME_DARK))
        dark.alpha_composite(tile(grid, 2, color), (12, 12))
        sheet.alpha_composite(tile(grid, 2, color), (x + 100, y + 4))
        sheet.alpha_composite(dark, (x + 140 + 8, y - 8))
        d.text((x, y + 92), name, fill=rgba("#1b1b1a"), font=font(22))
        d.text((x, y + 122), iid, fill=rgba("#6f6f6a"), font=font(16))
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
