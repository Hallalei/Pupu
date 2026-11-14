"""成员的预设头像：从 Pupu 图标的像素小猫（design/icon/pixels.py 的 MAIN）衍生出来。

每个预设 = 一套毛色 + 一个表情 + 一个配件 + 一块底色。毛色只换 PALETTE 里的字母，
表情和配件是盖在网格上的补丁，所以和图标是同一只猫、同一种像素风。

加一个新头像：在 PRESETS 里加一行，跑 `python3 design/avatars/export.py`。
id 一旦发出去就别改：成员选的是 id，改了他的头像就回到首字母。
"""

# ── 毛色 ─────────────────────────────────────────────────────────────
# 字母和 pixels.py 一样：D 背上最深 → c 下巴最浅；p 耳朵里；N 鼻子；E/e 眼睛亮/暗；
# 另外 X、Y 是三花的黑斑和橘斑，没用到的毛色里它们就是 g。

FURS = {
    # 橘猫：比 Pupu 的金渐层更红、更亮
    "orange": {"D": "#9c4a1c", "d": "#cf6a26", "g": "#ee8f3c", "l": "#f6b877", "c": "#fde3c4"},
    # 黑猫：黄眼睛
    "black": {"D": "#14151b", "d": "#22242c", "g": "#2f323c", "l": "#41444f", "c": "#5a5d68",
              "E": "#f2c94c", "e": "#b58a12", "p": "#8a5a62", "N": "#7a5560"},
    # 白猫：蓝眼睛
    "white": {"D": "#cfc8bb", "d": "#e2dccf", "g": "#f3efe6", "l": "#faf7f0", "c": "#ffffff",
              "E": "#6fb3e8", "e": "#2f78b8", "O": "#5b5148"},
    # 蓝灰（英短）：铜色眼睛
    "gray": {"D": "#4d5563", "d": "#68717f", "g": "#8790a0", "l": "#a8b0bd", "c": "#cfd4dc",
             "E": "#e89a3c", "e": "#a8611c", "O": "#2a2e36"},
    # 三花：白底，黑斑橘斑
    "calico": {"D": "#d9d2c4", "d": "#ebe5d8", "g": "#f7f3ea", "l": "#fbf8f2", "c": "#ffffff",
               "X": "#2f2d33", "Y": "#e58a3a", "O": "#3b2e26"},
    # 暹罗：奶油身子，深色面罩和耳朵，蓝眼睛
    "siamese": {"D": "#4a3428", "d": "#6b4c3b", "g": "#efe2cc", "l": "#f5ead8", "c": "#fbf4e8",
                "M": "#6b4c3b", "E": "#79b8f0", "e": "#3474b4"},
    # 奶牛猫：黑背白下巴
    "tuxedo": {"D": "#16171c", "d": "#23252c", "g": "#2c2e36", "l": "#ffffff", "c": "#ffffff",
               "E": "#8ccf6a", "e": "#4d8c32"},
    # 金渐层：Pupu 本身的毛色，只在换了表情或配件时用，免得和 Pupu 分不清
    "golden": {},
    # 奶油：很浅的杏色
    "cream": {"D": "#c29a6b", "d": "#d9b688", "g": "#ecd3ab", "l": "#f5e4c8", "c": "#fdf5e8",
              "E": "#a7c45a", "e": "#6c8a2a"},
}

# ── 底色 ─────────────────────────────────────────────────────────────
# 圆形头像的底。都是浅色，和 Pupu 自己的墨色底分开。

BACKGROUNDS = {
    "mint": "#cdebd9", "lavender": "#ddd5f3", "sky": "#cfe6f7", "peach": "#fadccb",
    "pink": "#f8d3de", "sand": "#efe3c8", "lemon": "#f6edb0", "rose": "#f3c9c4",
    "sage": "#d7e3c6", "lilac": "#ecd6ee", "aqua": "#c8ece9", "apricot": "#fbe2b8",
}

# 配件和表情用到的颜色，和毛色合在一起查。
EXTRA = {
    "K": "#2a2b31",  # 镜框、耳机
    "R": "#e0485a",  # 红：蝴蝶结、爱心
    "r": "#a82638",  # 深红
    "H": "#3f7fcf",  # 帽子
    "B": "#f6f2ea",  # 帽子白条、绒球
    "G": "#f2c13a",  # 金：皇冠
    "Q": "#b88a12",  # 深金
    "F": "#f27aa0",  # 花瓣
    "f": "#ffd84d",  # 花心
    "Z": "#59606e",  # 耳机罩
}

# ── 补丁 ─────────────────────────────────────────────────────────────
# 坐标是猫的 24×24 网格（MAIN），y 可以是负的（画到猫头上方）。每行字符串从 (x, y) 开始画，空格跳过。


def patch(x, y, rows):
    cells = []
    for dy, row in enumerate(rows):
        for dx, ch in enumerate(row):
            if ch != " ":
                cells.append((x + dx, y + dy, ch))
    return cells


# 眼睛在 MAIN 里占 x 6–9、14–17，y 7–10。下面的表情把眼睛整块换掉。
def eye_block(x, kind):
    if kind == "open":
        return []
    if kind == "happy":  # ^ ^
        return patch(x, 7, ["gggg", "gOOg", "OggO", "llll"])
    if kind == "sleepy":  # — —
        return patch(x, 7, ["gggg", "gggg", "OOOO", "llll"])
    if kind == "wink":  # >
        return patch(x, 7, ["gggg", "OOgg", "ggOO", "llll"])
    raise ValueError(kind)


EXPRESSIONS = {
    "open": [],
    "happy": eye_block(6, "happy") + eye_block(14, "happy"),
    "sleepy": eye_block(6, "sleepy") + eye_block(14, "sleepy"),
    "wink": eye_block(14, "wink"),
}

ACCESSORIES = {
    "none": [],
    "glasses": patch(5, 7, ["KKKKKK  KKKKKK",
                            "K    KKKK    K",
                            "K    K  K    K",
                            "KKKKKK  KKKKKK"]),
    "headphones": (patch(5, 0, ["ZZZZZZZZZZZZZZ"]) + patch(4, 1, ["Z"] * 6) + patch(19, 1, ["Z"] * 6)
                   + patch(3, 7, ["KK", "KK", "KK", "KK"]) + patch(19, 7, ["KK", "KK", "KK", "KK"])),
    "bow": patch(16, 0, ["RR RR", "RRrRR", "RR RR"]),
    "beanie": (patch(10, -2, [" BB ", "BBBB"]) + patch(6, 0, ["HHHHHHHHHHHH"]) + patch(5, 1, ["HHHHHHHHHHHHHH"])
               + patch(5, 2, ["HBHBHBHBHBHBHB"]) + patch(5, 3, ["BBBBBBBBBBBBBB"])),
    "crown": patch(8, -2, ["G  G  G ", "GGGGGGGG", "GQGGGGQG", "GGGGGGGG"]),
    "flower": patch(3, 1, [" F ", "FfF", " F "]),
}

# 气泡里的东西：MAIN 里是三个输入点（y 17–18）。
BUBBLES = {
    "dots": [],
    "heart": patch(8, 16, ["WWWWWWWW", "WRRWRRWW", "WRRRRRWW", "WWRRRWWW"]),
    "blank": patch(8, 17, ["WWWWWWWW", "WWWWWWWW"]),
}

# 毛色上的花纹（三花的斑、暹罗的面罩、奶牛猫的白脸）。
MARKINGS = {
    "calico": patch(6, 3, ["XX", "XXX", "XX"]) + patch(14, 3, ["  YY", " YYYY", "YYYY"]) + patch(16, 6, ["YY"]),
    "siamese": (patch(6, 4, ["MM", "MM"]) + patch(16, 4, ["MM", "MM"])
                + patch(10, 10, ["MMMM"]) + patch(9, 11, ["MMMMMM"]) + patch(9, 12, ["MMMMMM"])),
    "tuxedo": patch(10, 6, ["llll"]) + patch(10, 7, ["llll"]) + patch(9, 8, ["llllll"]) + patch(9, 9, ["llllll"]),
}

# ── 预设 ─────────────────────────────────────────────────────────────
# (id, 中文名, 毛色, 表情, 配件, 气泡, 底色)

PRESETS = [
    ("orange", "橘子", "orange", "open", "none", "dots", "mint"),
    ("black", "煤球", "black", "open", "none", "dots", "lavender"),
    ("white", "雪团", "white", "open", "bow", "dots", "sky"),
    ("gray", "灰灰", "gray", "open", "glasses", "dots", "peach"),
    ("calico", "三花", "calico", "happy", "flower", "heart", "pink"),
    ("siamese", "暹罗", "siamese", "open", "none", "dots", "sand"),
    ("tuxedo", "奶牛", "tuxedo", "open", "headphones", "dots", "lemon"),
    ("golden-happy", "笑笑", "golden", "happy", "none", "heart", "rose"),
    ("cream-wink", "眨眼", "cream", "wink", "none", "dots", "sage"),
    ("orange-beanie", "毛线帽", "orange", "open", "beanie", "blank", "lilac"),
    ("gray-sleepy", "困了", "gray", "sleepy", "none", "blank", "aqua"),
    ("black-crown", "国王", "black", "open", "crown", "dots", "apricot"),
]
