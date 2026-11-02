"""从 pixels.py 的像素网格出三端要用的全部图标文件。

    python3 export.py

要 Pillow（系统自带的 python3 已经装了）。macOS 26 的 Assets.car 要 Xcode 26 的 actool，
没有就跳过那一步，其余照出。
"""
import json
import os
import shutil
import subprocess
import tempfile
from PIL import Image, ImageDraw, ImageFilter

from pixels import BACKGROUND, BADGE, BADGE_AT, DARK, MAIN, PALETTE, SMALL, TINTED, TRAY, TRAY_DOTS_ROW

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(HERE, "out")
IOS = os.path.join(ROOT, "apps/ios/Pupu/Assets.xcassets/AppIcon.appiconset")
WEB = os.path.join(ROOT, "apps/cloud/public")
DESKTOP = os.path.join(ROOT, "apps/desktop/icons")
DESKTOP_STATIC = os.path.join(ROOT, "apps/desktop/static/icons")


# ── 网格 → 图 ─────────────────────────────────────────────────────────

def rgba(hexc):
    return tuple(int(hexc[i:i + 2], 16) for i in (1, 3, 5)) + (255,)


def gray(hexc):
    r, g, b, _ = rgba(hexc)
    y = round(0.2126 * r + 0.7152 * g + 0.0722 * b)
    return f"#{y:02x}{y:02x}{y:02x}"


def cells(rows, palette, background):
    """每格的颜色；background 为 None 时背景透明。"""
    assert len({len(r) for r in rows}) == 1, "每行要一样长"
    return [[(background if ch == "." else palette[ch]) for ch in row] for row in rows]


def render(grid, size):
    """放大到 size×size；格子边界取整，24 格放到 1024 时每格 42 或 43 像素，不留缝。"""
    h, w = len(grid), len(grid[0])
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    xs = [round(i * size / w) for i in range(w + 1)]
    ys = [round(i * size / h) for i in range(h + 1)]
    for y, row in enumerate(grid):
        for x, c in enumerate(row):
            if c:
                d.rectangle([xs[x], ys[y], xs[x + 1] - 1, ys[y + 1] - 1], fill=rgba(c))
    return im


def svg(grid):
    """同一行里连续同色的格子并成一个矩形。"""
    h, w = len(grid), len(grid[0])
    rects = []
    for y, row in enumerate(grid):
        x = 0
        while x < w:
            c = row[x]
            run = 1
            while x + run < w and row[x + run] == c:
                run += 1
            if c:
                rects.append(f'<rect x="{x}" y="{y}" width="{run}" height="1" fill="{c}"/>')
            x += run
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" shape-rendering="crispEdges">\n'
            + "\n".join(rects) + "\n</svg>\n")


def save(im, *parts):
    path = os.path.join(*parts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.save(path, optimize=True)
    return path


def write(text, *parts):
    path = os.path.join(*parts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)
    return path


# ── 三种外观 ──────────────────────────────────────────────────────────

LIGHT = cells(MAIN, PALETTE, BACKGROUND)
DARK_GRID = cells(MAIN, {**PALETTE, **DARK}, None)
# 着色外观：苹果要灰度图。照 LoopFollow 的做法垫黑底，系统按亮度上色。
TINTED_GRID = cells(MAIN, {**{k: gray(v) for k, v in PALETTE.items()}, **TINTED}, "#000000")
FOREGROUND = cells(MAIN, PALETTE, None)


def mac_tile(grid):
    """macOS 老式图标的网格：1024 画布里放 824 的圆角方块，带一点投影。"""
    size, body, radius = 1024, 824, 185
    off = (size - body) // 2
    mask = Image.new("L", (body, body), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, body - 1, body - 1], radius=radius, fill=255)
    tile = Image.new("RGBA", (body, body), (0, 0, 0, 0))
    tile.paste(render(grid, body), (0, 0), mask)
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow.paste((0, 0, 0, 90), (off, off + 12), mask)
    canvas = shadow.filter(ImageFilter.GaussianBlur(14))
    canvas.alpha_composite(tile, (off, off))
    return canvas


# ── 各端 ─────────────────────────────────────────────────────────────

def export_design():
    write(svg(LIGHT), OUT, "pupu-icon.svg")
    write(svg(cells(SMALL, PALETTE, BACKGROUND)), OUT, "pupu-icon-16.svg")
    save(render(LIGHT, 1024), OUT, "pupu-icon-1024.png")
    save(render(DARK_GRID, 1024), OUT, "pupu-icon-1024-dark.png")
    save(render(TINTED_GRID, 1024), OUT, "pupu-icon-1024-tinted.png")
    save(render(cells(SMALL, PALETTE, BACKGROUND), 128), OUT, "pupu-icon-16-x8.png")


def export_ios():
    """单尺寸 1024，加深色和着色两张。Contents.json 的写法照 LoopFollow 的 AppIcon.appiconset。"""
    files = {"any": "icon-1024.png", "dark": "icon-1024-dark.png", "tinted": "icon-1024-tinted.png"}
    save(render(LIGHT, 1024).convert("RGB"), IOS, files["any"])  # 默认外观不能带透明
    save(render(DARK_GRID, 1024), IOS, files["dark"])
    save(render(TINTED_GRID, 1024).convert("RGB"), IOS, files["tinted"])
    images = []
    for look, name in files.items():
        entry = {"filename": name, "idiom": "universal", "platform": "ios", "size": "1024x1024"}
        if look != "any":
            entry = {"appearances": [{"appearance": "luminosity", "value": look}], **entry}
        images.append(entry)
    write(json.dumps({"images": images, "info": {"author": "xcode", "version": 1}}, indent=2) + "\n",
          IOS, "Contents.json")


def export_web():
    small = render(cells(SMALL, PALETTE, BACKGROUND), 16)
    small32 = small.resize((32, 32), Image.NEAREST)
    os.makedirs(WEB, exist_ok=True)
    small32.save(os.path.join(WEB, "favicon.ico"), format="ICO", sizes=[(16, 16), (32, 32)],
                 append_images=[small])
    write(svg(cells(SMALL, PALETTE, BACKGROUND)), WEB, "favicon.svg")
    # iOS「添加到主屏幕」：180×180、不透明，系统自己切圆角。
    save(render(LIGHT, 1024).resize((180, 180), Image.LANCZOS).convert("RGB"), WEB, "apple-touch-icon.png")


def export_desktop():
    tile = mac_tile(LIGHT)
    # 老式 icns：macOS 26 以前用，DMG 也用它。
    iconset = tempfile.mkdtemp(suffix=".iconset")
    for pt in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            px = pt * scale
            name = f"icon_{pt}x{pt}{'@2x' if scale == 2 else ''}.png"
            tile.resize((px, px), Image.LANCZOS).save(os.path.join(iconset, name))
    os.makedirs(DESKTOP, exist_ok=True)
    subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(DESKTOP, "icon.icns")], check=True)
    shutil.rmtree(iconset)

    # macOS 26 的图标：Icon Composer 的 .icon 包，墨色底 + 一层不加玻璃效果的像素图。
    # 结构照 comm 的 lib/icons/apple.icon 和 kinopio 的 icon-composer.icon。
    package = os.path.join(DESKTOP, "AppIcon.icon")
    shutil.rmtree(package, ignore_errors=True)
    save(render(FOREGROUND, 1024), package, "Assets", "pupu.png")
    r, g, b, _ = rgba(BACKGROUND)
    solid = f"srgb:{r / 255:.5f},{g / 255:.5f},{b / 255:.5f},1.00000"
    icon = {
        "fill-specializations": [{"value": {"solid": solid}}, {"appearance": "dark", "value": {"solid": solid}}],
        "groups": [{
            "layers": [{"glass": False, "image-name": "pupu.png", "name": "pupu"}],
            "shadow": {"kind": "neutral", "opacity": 0.5},
            "specular": False,
            "translucency": {"enabled": False, "value": 0.5},
        }],
        "supported-platforms": {"squares": "shared"},
    }
    write(json.dumps(icon, indent=2) + "\n", package, "icon.json")
    compile_assets_car(package)

    # 开发版 Electron 的程序坞图标（打包后用 App 包里的图标，不用这张）。
    save(tile.resize((512, 512), Image.LANCZOS), DESKTOP_STATIC, "dock.png")
    export_tray()


def compile_assets_car(package):
    """.icon 编成 Assets.car，打包时放进 Contents/Resources，Info.plist 写 CFBundleIconName = AppIcon。
    actool 的参数照 kinopio 的 src-tauri/compile-icon.js。"""
    if shutil.which("xcrun") is None:
        print("没有 xcrun，跳过 Assets.car")
        return
    work = tempfile.mkdtemp()
    out = os.path.join(work, "out")
    os.makedirs(out)
    shutil.copytree(package, os.path.join(work, "AppIcon.icon"))
    result = subprocess.run([
        "xcrun", "actool", os.path.join(work, "AppIcon.icon"),
        "--compile", out,
        "--output-format", "human-readable-text", "--notices", "--warnings", "--errors",
        "--output-partial-info-plist", os.path.join(out, "partial.plist"),
        "--app-icon", "AppIcon", "--include-all-app-icons",
        "--enable-on-demand-resources", "NO", "--development-region", "en",
        "--target-device", "mac", "--minimum-deployment-target", "11.0", "--platform", "macosx",
    ], capture_output=True, text=True)
    car = os.path.join(out, "Assets.car")
    if not os.path.exists(car):
        print(result.stdout, result.stderr)
        print("actool 没出 Assets.car；报 Bad file descriptor 时先 pkill -x ibtoold 再试")
    else:
        shutil.copyfile(car, os.path.join(DESKTOP, "Assets.car"))
    shutil.rmtree(work)


def export_tray():
    """菜单栏四种状态，各出 1x、2x 两张（加载方式照 emdash 的 tray.ts：addRepresentation 两份）。"""
    busy = [list(r) for r in TRAY]
    idle = [list(r) for r in TRAY]
    w = len(TRAY[0])
    left, right = TRAY[TRAY_DOTS_ROW].index("#"), TRAY[TRAY_DOTS_ROW].rindex("#")
    for x in range(left, right + 1):
        idle[TRAY_DOTS_ROW][x] = "#"
    waiting = [r[:] for r in busy]
    bx, by = BADGE_AT
    badge = {(bx + x, by + y) for y, row in enumerate(BADGE) for x, ch in enumerate(row) if ch == "#"}
    ring = {(x + dx, y + dy) for x, y in badge for dx in (-1, 0, 1) for dy in (-1, 0, 1)} - badge
    for x, y in ring:
        if 0 <= x < w and 0 <= y < len(TRAY):
            waiting[y][x] = "."
    for x, y in badge:
        waiting[y][x] = "#"
    states = {"idle": (idle, 255), "busy": (busy, 255), "waiting": (waiting, 255), "offline": (idle, 102)}
    for name, (rows, alpha) in states.items():
        im = Image.new("RGBA", (w, len(rows)), (0, 0, 0, 0))
        for y, row in enumerate(rows):
            for x, ch in enumerate(row):
                if ch == "#":
                    im.putpixel((x, y), (0, 0, 0, alpha))
        save(im, DESKTOP_STATIC, f"tray-{name}.png")
        save(im.resize((w * 2, len(rows) * 2), Image.NEAREST), DESKTOP_STATIC, f"tray-{name}@2x.png")


if __name__ == "__main__":
    export_design()
    export_ios()
    export_web()
    export_desktop()
    print("已出：design/icon/out、iOS AppIcon、网页 public、电脑 App icons 和 static/icons")
