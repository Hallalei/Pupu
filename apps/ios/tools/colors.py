"""把「Pupu 设计规范」的 tokens.json 变成资产目录里的颜色。

用法：python3 tools/colors.py <tokens.json>

tokens.json 从设计规范的 artifact 里取（project/tokens.json）。每个颜色 token
生成一个同名的 colorset，浅色和深色各一个值；只给网页预览用的 glass-*，
以及灵动岛的 island、on-island（在 SwiftUI 小组件里用）不生成。
"""

import json
import math
import re
import shutil
import sys
from pathlib import Path

SKIP = {"glass-fill", "glass-highlight", "glass-rim", "island", "on-island"}
CATALOG = Path(__file__).resolve().parent.parent / "Pupu" / "Assets.xcassets" / "Colors"


def oklch_to_srgb(lightness: float, chroma: float, hue: float) -> tuple[float, float, float]:
    a = chroma * math.cos(math.radians(hue))
    b = chroma * math.sin(math.radians(hue))
    l_ = lightness + 0.3963377774 * a + 0.2158037573 * b
    m_ = lightness - 0.1055613458 * a - 0.0638541728 * b
    s_ = lightness - 0.0894841775 * a - 1.2914855480 * b
    l, m, s = l_**3, m_**3, s_**3
    linear = (
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    )

    def encode(x: float) -> float:
        x = max(0.0, min(1.0, x))
        return 12.92 * x if x <= 0.0031308 else 1.055 * x ** (1 / 2.4) - 0.055

    return tuple(encode(v) for v in linear)  # type: ignore[return-value]


def rgba(value: str) -> tuple[float, float, float, float]:
    match = re.fullmatch(r"oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)", value.strip())
    if match:
        lightness = float(match.group(1)) / (100 if match.group(2) else 1)
        r, g, b = oklch_to_srgb(lightness, float(match.group(3)), float(match.group(4)))
        return r, g, b, 1.0
    hex_value = value.strip().lstrip("#")
    if len(hex_value) not in (6, 8):
        raise ValueError(f"认不出的颜色：{value}")
    r, g, b = (int(hex_value[i : i + 2], 16) / 255 for i in (0, 2, 4))
    alpha = int(hex_value[6:8], 16) / 255 if len(hex_value) == 8 else 1.0
    return r, g, b, alpha


def entry(value: tuple[float, float, float, float], dark: bool) -> dict:
    r, g, b, a = value
    color = {
        "color-space": "srgb",
        "components": {
            "red": f"{r:.3f}",
            "green": f"{g:.3f}",
            "blue": f"{b:.3f}",
            "alpha": f"{a:.3f}",
        },
    }
    item: dict = {"color": color, "idiom": "universal"}
    if dark:
        item["appearances"] = [{"appearance": "luminosity", "value": "dark"}]
    return item


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    tokens = json.loads(Path(sys.argv[1]).read_text())["color"]["tokens"]
    by_name = {token["name"]: token for token in tokens}

    def resolve(token: dict, theme: str, depth: int = 0) -> str:
        value = token["value"]
        raw = value if isinstance(value, str) else value.get(theme, value.get("light"))
        alias = re.fullmatch(r"\{(.+)\}", raw)
        if alias and depth < 16:
            return resolve(by_name[alias.group(1)], theme, depth + 1)
        return raw

    if CATALOG.exists():
        shutil.rmtree(CATALOG)
    CATALOG.mkdir(parents=True)
    (CATALOG / "Contents.json").write_text(
        json.dumps({"info": {"author": "xcode", "version": 1}, "properties": {"provides-namespace": False}}, indent=2) + "\n"
    )
    for token in tokens:
        name = token["name"]
        if name in SKIP:
            continue
        light = rgba(resolve(token, "light"))
        dark = rgba(resolve(token, "dark"))
        folder = CATALOG / f"{name}.colorset"
        folder.mkdir()
        contents = {"colors": [entry(light, False), entry(dark, True)], "info": {"author": "xcode", "version": 1}}
        (folder / "Contents.json").write_text(json.dumps(contents, indent=2) + "\n")
        print(name)


if __name__ == "__main__":
    main()
