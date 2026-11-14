"""把空间图标的 48×48 模板图放进资产目录。

用法：python3 tools/space_icons.py

源头是 design/space-icons/out/<id>@3x.png（design/space-icons/export.py 出的黑色模板图）；
id 照云端 apps/cloud/src/space-look.ts 的 SPACE_ICONS，一个都不能少。每个图标生成一个
space-icon-<id> 的 imageset，按模板图渲染，App 里用 on-mark 染色（规范 SpaceMark）。
"""

import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "design" / "space-icons" / "out"
LOOK = ROOT / "apps" / "cloud" / "src" / "space-look.ts"
CATALOG = Path(__file__).resolve().parent.parent / "Pupu" / "Assets.xcassets" / "SpaceIcons"


def icon_ids() -> list[str]:
    source = LOOK.read_text()
    block = re.search(r"SPACE_ICONS = \[(.*?)\]", source, re.S)
    if not block:
        raise SystemExit(f"{LOOK} 里找不到 SPACE_ICONS")
    return re.findall(r'"([a-z0-9-]+)"', block.group(1))


def main() -> None:
    ids = icon_ids()
    missing = [icon for icon in ids if not (SOURCE / f"{icon}@3x.png").exists()]
    if missing:
        raise SystemExit(f"design/space-icons/out 里缺这些图标：{', '.join(missing)}，先跑 design/space-icons/export.py")
    if CATALOG.exists():
        shutil.rmtree(CATALOG)
    CATALOG.mkdir(parents=True)
    (CATALOG / "Contents.json").write_text(json.dumps({"info": {"author": "xcode", "version": 1}}, indent=2) + "\n")
    for icon in ids:
        folder = CATALOG / f"space-icon-{icon}.imageset"
        folder.mkdir()
        shutil.copyfile(SOURCE / f"{icon}@3x.png", folder / f"{icon}@3x.png")
        contents = {
            "images": [{"filename": f"{icon}@3x.png", "idiom": "universal", "scale": "3x"}],
            "info": {"author": "xcode", "version": 1},
            "properties": {"template-rendering-intent": "template"},
        }
        (folder / "Contents.json").write_text(json.dumps(contents, indent=2) + "\n")
    print(f"{len(ids)} 个图标 → {CATALOG}")


if __name__ == "__main__":
    main()
