"""成员（用户）的预设头像：像素小人，和 Pupu 的猫分开。

借动漫角色最好认的一两样特征（发型、帽子、伤疤、衣服），名字自己起，不用角色名和作品名。
每个人 = 同一张脸 + 一套头发 + 一种眼睛 + 一身衣服 + 底色。网格和猫一样是 24×24，画在 28 格的画布上。

加一个：在 PEOPLE 里加一行，跑 `python3 design/avatars/export.py`。id 发出去以后别改。
"""

# 脸：. 透明，O 描边，S 肤色，s 阴影，b 腮红，m 嘴，C/c 衣服亮/暗，D 衣服点缀。
FACE = [
    "........................",
    "........................",
    "........................",
    "........................",
    ".......OOOOOOOOOO.......",
    "......OSSSSSSSSSSO......",
    ".....OSSSSSSSSSSSSO.....",
    ".....OSSSSSSSSSSSSO.....",
    "....OSSSSSSSSSSSSSSO....",
    "....OSSSSSSSSSSSSSSO....",
    "....OSSSSSSSSSSSSSSO....",
    "...OOSSSSSSSSSSSSSSOO...",
    "...OsSSSSSSSSSSSSSSsO...",
    "....OSbbSSSSSSSSbbSO....",
    "....OSSSSSSmmSSSSSSO....",
    ".....OSSSSSSSSSSSSO.....",
    "......OOSSSSSSSSOO......",
    "........OOssssOO........",
    ".........OssssO.........",
    "......OOOCCCCCCOOO......",
    "...OOCCCCCCCCCCCCCCOO...",
    "..OCCCCCCCCCCCCCCCCCCO..",
    "..OCCCCCCCCCCCCCCCCCCO..",
    "..OCCCCCCCCCCCCCCCCCCO..",
]

SKIN = {"O": "#2b1d16", "S": "#f8d5b0", "s": "#e4ae86", "b": "#f3a593", "m": "#9a4130",
        "W": "#ffffff", "P": "#2b1d16", "h": "#ffffff"}


def rows(x, y, lines):
    """从 (x, y) 开始一行行画，空格和 . 都跳过。"""
    out = []
    for dy, line in enumerate(lines):
        for dx, ch in enumerate(line):
            if ch not in " .":
                out.append((x + dx, y + dy, ch))
    return out


# 眼睛：左眼 x 7–8，右眼 x 15–16，y 9–11。I 是瞳色。
EYES = {
    "open": rows(7, 9, ["OO      OO", "IW      IW", "II      II"]),
    "fierce": rows(6, 8, ["OO        OO", " OO      OO ", " IW      IW ", " II      II "]),
    "dots": rows(7, 10, ["OO      OO", "OO      OO"]),
    "grin": rows(7, 9, ["OO      OO", "IW      IW", "II      II"]) + rows(9, 14, ["mWWWm", " mmm "]),
    "scar-left": rows(6, 10, ["OOO"]) + rows(7, 8, ["r", "r", "r", "r", "r"]) + rows(15, 9, ["OO", "IW", "II"]),
    "hidden-right": rows(7, 9, ["OO", "IW", "II"]) + rows(6, 7, ["OOO", "   O"]),
}

# 头发：坐标同 FACE，y 可以是负的（画到头顶上方）。H 主色，A 高光，K 深色。
HAIR = {
    "spiky-gold": rows(1, -3, [
        "     O     O     O      ",
        "    OHO   OHO   OHO   O ",
        " O  OHHO OHHHO OHHO  OHO",
        " OHO OHHOHHHHHOHHHO OHHO",
        "  OHHOHHHHHHHHHHHHHOHHO ",
        "  OHHHHHHAHHHHHHHHHHHO  ",
        " OHHHHHHHHHHHHHHAHHHHHO ",
        " OHHHAHHHHHHHHHHHHHHHHO ",
        "  OHHHHHHHHHHHHHHHHHHO  ",
        "  OHHHOHHHHOHHHHOHHHHO  ",
        "  OHHO OHHO OHHO OHHO   ",
        "   OO   OO   OO   OO    ",
    ]),
    "spiky-black": rows(1, -1, [
        "  O     O      O    O   ",
        " OHO   OHO    OHO  OHO  ",
        " OHHO OHHHO  OHHHOOHHO  ",
        "OHHHHOHHHHHOOHHHHHHHHO  ",
        " OHHHHHHHHHHHHHHHHHHHHO ",
        "OHHHHHHHHHHHHHHHHHHHHHO ",
        " OHHHHHHHHHHHHHHHHHHHO  ",
        "  OHHHOHHHOHHHOHHHHHO   ",
        "  OHHO OHO  OHO OHHO    ",
        "  OO    O    O   OO     ",
    ]),
    "bald": rows(7, 4, ["OOOOOOOOOO"]) + rows(12, 5, ["hh"]) + rows(13, 6, ["h"]),
    "straw-hat": rows(2, 0, [
        "      OOOOOOOOOOO      ",
        "     OYYYYYYYYYYYYO     ",
        "     OYYYYYYYYYYYYO     ",
        "     ORRRRRRRRRRRRO     ",
        "OOOOOOOOOOOOOOOOOOOOOO",
        "OYYYYYYYYYYYYYYYYYYYYO",
        " OyyyyyyyyyyyyyyyyyyO ",
        "   OHHHOHHHHOHHHHHO   ",
        "   OHO  OHO  OHHO     ",
    ]) + rows(6, 12, ["rr"]),
    "green-short": rows(4, 2, [
        "   OOOOOOOOOO   ",
        "  OHHHHHHHHHHO  ",
        " OHHHAHHHHHHHHO ",
        " OHHHHHHHHHHHHHO",
        "OHHHHHHHHHHHHHHO",
        "OHO OHHHOHHHO OHO",
    ]) + rows(3, 11, ["G", "G", "G"]),
    "blond-swoop": rows(3, 1, [
        "    OOOOOOOOOOO    ",
        "   OHHHHHHHHHHHO   ",
        "  OHHHAHHHHHHHHHO  ",
        " OHHHHHHHHHHHAHHHO ",
        " OHHHHHHHHHHHHHHHO ",
        " OHO OHHHHHHHHHHHO ",
        " OO   OHHHHHHHHHHO ",
        "        OHHHHHHHHO ",
        "         OHHHHHHHO ",
        "          OHHHHHO  ",
        "           OHHHO   ",
        "            OOO    ",
    ]),
    "long-orange": rows(2, 2, [
        "     OOOOOOOOOOO      ",
        "   OOHHHHHHHHHHHOO    ",
        "  OHHHHAHHHHHHHHHHO   ",
        " OHHHHHHHHHHHHHHHHHO  ",
        " OHHHHHHHHHHHHHHHHHO  ",
        " OHHHO  OHHO   OHHHO  ",
        " OHHO           OHHO  ",
        " OHHO           OHHO  ",
        " OHHO           OHHO  ",
        " OHHO           OHHO  ",
        " OHHO           OHHO  ",
        " OHHHO         OHHHO  ",
        " OHHHO         OHHHO  ",
        "  OHHHO       OHHHO   ",
        "  OHHHO       OHHHO   ",
        "   OHHO       OHHO    ",
        "   OOO         OOO    ",
    ]),
    "blue-ponytail": rows(2, 1, [
        "                 RR   ",
        "    OOOOOOOOOO  ORRO  ",
        "   OHHHHHHHHHHOOHHHO  ",
        "  OHHHAHHHHHHHHHHHHHO ",
        " OHHHHHHHHHHHHHHHHHHO ",
        " OHHHHHHHHHHHHHHHHO HHO",
        " OHHO OHHHHO OHHHO  OHHO",
        " OHO   OHO    OHO   OHHO",
        "  O     O      O    OHO",
        "                   OHO ",
        "                   OO  ",
    ]),
}

# 头发用到的颜色之外，各种点缀。
EXTRA = {"Y": "#efc96b", "y": "#b8913a", "R": "#e0485a", "r": "#a82638", "G": "#f2c13a"}

# (id, 名字, 头发, 发色[H, A], 眼睛, 瞳色, 衣服[C, c, D], 衣服花样, 底色)
PEOPLE = [
    ("gold-fighter", "金发战士", "spiky-gold", ("#ffd84a", "#fff3a8"), "fierce", "#2fb9b0", ("#f28a26", "#c8681a", "#2f6fd0"), "gi", "#cfe6f7"),
    ("black-fighter", "黑发战士", "spiky-black", ("#24252c", "#3c3f4a"), "grin", "#2b1d16", ("#f28a26", "#c8681a", "#2f6fd0"), "gi", "#fbe2b8"),
    ("bald-hero", "光头英雄", "bald", ("#f8d5b0", "#ffffff"), "dots", "#2b1d16", ("#f2c13a", "#c99a1a", "#e0485a"), "cape", "#f6edb0"),
    ("straw-hat", "草帽", "straw-hat", ("#24252c", "#3c3f4a"), "grin", "#2b1d16", ("#e0485a", "#a82638", "#f8d5b0"), "vest", "#c8ece9"),
    ("green-swordsman", "绿发剑士", "green-short", ("#4fa35e", "#7cc489"), "scar-left", "#2b1d16", ("#f5f2ea", "#d6d0c4", "#3f9150"), "shirt", "#efe3c8"),
    ("blond-cook", "金发厨师", "blond-swoop", ("#f6d35a", "#fff0a6"), "hidden-right", "#3f7fcf", ("#24252c", "#3a3d48", "#3f7fcf"), "suit", "#ddd5f3"),
    ("orange-navigator", "橙发航海士", "long-orange", ("#f2862e", "#ffb46a"), "open", "#8a4a20", ("#f5f2ea", "#3f7fcf", "#3f7fcf"), "stripes", "#f8d3de"),
    ("blue-genius", "蓝发天才", "blue-ponytail", ("#4aa8e0", "#9ad4f5"), "open", "#3f7fcf", ("#e0485a", "#a82638", "#ffffff"), "dress", "#d7e3c6"),
]


def clothes(style):
    """衣服上的花样，盖在 FACE 的衣服格子上（只盖 C）。"""
    if style == "gi":  # 交叉领口露出深色内衬
        return rows(9, 19, ["DcDDcD"]) + rows(10, 20, ["DccD"]) + rows(11, 21, ["DD"])
    if style == "cape":  # 披风系在领口
        return rows(4, 19, ["DD          DD"]) + rows(3, 20, ["DD              DD"]) + rows(10, 19, ["WWWW"])
    if style == "vest":  # 敞开的背心
        return rows(10, 19, ["DDDD"]) + rows(10, 20, ["DDDD"]) + rows(11, 21, ["DD"]) + rows(11, 22, ["DD"]) + rows(11, 23, ["DD"])
    if style == "shirt":  # 白衬衫，腰上一圈绿
        return rows(3, 23, ["DDDDDDDDDDDDDDDDDD"]) + rows(11, 19, ["cc"])
    if style == "suit":  # 黑西装，蓝衬衫领口，领带
        return rows(9, 19, ["DDDDDD"]) + rows(10, 20, ["DccD"]) + rows(11, 21, ["cc"])
    if style == "stripes":  # 白底蓝条
        return rows(3, 21, ["cccccccccccccccccc"]) + rows(3, 23, ["cccccccccccccccccc"])
    if style == "dress":  # 红裙，白领
        return rows(8, 19, ["DDDDDDDD"])
    return []
