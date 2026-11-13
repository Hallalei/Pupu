"""出成员的预设头像。

    python3 design/avatars/export.py

要 Pillow（系统自带的 python3 已经装了）。出这些文件：

- apps/cloud/public/avatars/<id>.png：256×256 方图，带底色，各端自己裁成圆；
- apps/cloud/src/avatar-presets.ts：id 清单，云端只认清单里的 id；
- design/avatars/out/overview.png：总览图，按 32px 圆形缩小的样子也放了一排，看耳朵有没有被切掉。
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "design/icon"))

from pixels import MAIN, PALETTE  # noqa: E402
from presets import ACCESSORIES, BACKGROUNDS, BUBBLES, EXPRESSIONS, EXTRA, FURS, MARKINGS, PRESETS  # noqa: E402

WEB = os.path.join(ROOT, "apps/cloud/public/avatars")
MANIFEST = os.path.join(ROOT, "apps/cloud/src/avatar-presets.ts")
OUT = os.path.join(HERE, "out")

GRID = 28  # 画布格数：猫 24 格，四周留白，圆形裁切时耳尖和气泡角都在圆里
OFFSET = (2, 3)  # 猫的 (0, 0) 在画布上的位置；上面多留一格给帽子和皇冠
SIZE = 256
FUR = set("Ddglcp")  # 花纹只盖在毛上，不盖眼睛鼻子描边


def rgba(hexc):
    return tuple(int(hexc[i:i + 2], 16) for i in (1, 3, 5)) + (255,)


def grid_of(fur, expression, accessory, bubble):
    """画布上每格的字母；None 是底色。"""
    canvas = [[None] * GRID for _ in range(GRID)]
    ox, oy = OFFSET
    for y, row in enumerate(MAIN):
        for x, ch in enumerate(row):
            if ch != ".":
                canvas[y + oy][x + ox] = ch

    def put(cells, only_fur=False):
        for x, y, ch in cells:
            cx, cy = x + ox, y + oy
            if not (0 <= cx < GRID and 0 <= cy < GRID):
                raise ValueError(f"补丁出了画布：{(x, y)}")
            if only_fur and canvas[cy][cx] not in FUR:
                continue
            canvas[cy][cx] = ch

    put(MARKINGS.get(fur, []), only_fur=True)
    put(EXPRESSIONS[expression])
    put(BUBBLES[bubble])
    put(ACCESSORIES[accessory])
    return canvas


def render(canvas, palette, background, size=SIZE):
    im = Image.new("RGBA", (size, size), rgba(background))
    d = ImageDraw.Draw(im)
    edges = [round(i * size / GRID) for i in range(GRID + 1)]
    for y, row in enumerate(canvas):
        for x, ch in enumerate(row):
            if ch is not None:
                d.rectangle([edges[x], edges[y], edges[x + 1] - 1, edges[y + 1] - 1], fill=rgba(palette[ch]))
    return im


def circle(im, size):
    """缩到 size 再裁成圆，看在聊天里的样子。"""
    big = im.resize((size * 4, size * 4), Image.NEAREST)
    mask = Image.new("L", big.size, 0)
    ImageDraw.Draw(mask).ellipse([0, 0, big.size[0] - 1, big.size[1] - 1], fill=255)
    out = Image.new("RGBA", big.size, (0, 0, 0, 0))
    out.paste(big, (0, 0), mask)
    return out.resize((size, size), Image.LANCZOS)


def font(size):
    for path in ("/System/Library/Fonts/Hiragino Sans GB.ttc", "/System/Library/Fonts/STHeiti Medium.ttc"):
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def overview(images):
    cols, cell, small = 6, 210, 32
    rows = (len(images) + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * cell, rows * (cell + 64) + 24), rgba("#f7f5f0"))
    d = ImageDraw.Draw(sheet)
    label = font(22)
    for i, (preset, im) in enumerate(images):
        x, y = (i % cols) * cell, (i // cols) * (cell + 64) + 12
        sheet.alpha_composite(circle(im, 160), (x + 20, y))
        sheet.alpha_composite(circle(im, small), (x + 20, y + 168))
        d.text((x + 20 + small + 10, y + 166), preset[1], fill=rgba("#3a3d48"), font=label)
        d.text((x + 20 + small + 10, y + 192), preset[0], fill=rgba("#8a8d96"), font=font(15))
    return sheet


def manifest():
    lines = [
        "// 由 design/avatars/export.py 生成，别手改。加头像改 design/avatars/presets.py 再跑一遍。",
        "",
        "/** 成员能选的预设头像。图在 public/avatars/<id>.png。 */",
        "export const AVATAR_PRESETS = [",
        *[f'  {{ id: "{p[0]}", name: "{p[1]}" }},' for p in PRESETS],
        "] as const;",
        "",
    ]
    return "\n".join(lines)


def main():
    ids = [p[0] for p in PRESETS]
    assert len(ids) == len(set(ids)), "id 重复了"
    os.makedirs(WEB, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)
    images = []
    for preset in PRESETS:
        pid, _name, fur, expression, accessory, bubble, background = preset
        palette = {**PALETTE, **EXTRA, "X": "#000000", "Y": "#000000", "M": "#000000", **FURS[fur]}
        im = render(grid_of(fur, expression, accessory, bubble), palette, BACKGROUNDS[background])
        im.convert("RGB").save(os.path.join(WEB, f"{pid}.png"), optimize=True)
        images.append((preset, im))
    overview(images).convert("RGB").save(os.path.join(OUT, "overview.png"), optimize=True)
    with open(MANIFEST, "w") as f:
        f.write(manifest())
    print(f"{len(PRESETS)} 个头像 → {os.path.relpath(WEB, ROOT)}")


if __name__ == "__main__":
    main()
