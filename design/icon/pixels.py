"""Pupu 的图标：像素金渐层小猫扒在对话气泡上（2026-11-02 定的方向 C「探头」）。

每张图是一组等长的字符串，一个字符一格，字母查 PALETTE 换颜色，「.」是背景。
改一格就改一个字母，再跑 `python3 export.py` 重新出各端的文件。
"""

# 浅色（默认外观）的颜色。金渐层五档：D 背上最深 → c 下巴肚子最浅。
PALETTE = {
    "D": "#7a532e", "d": "#ad7638", "g": "#d8a04e", "l": "#eec57e", "c": "#fae7c3",
    "O": "#3b2717",  # 描边
    "o": "#8a5c35",  # 软描边：爪子的趾缝
    "E": "#4fae5a", "e": "#2c7a3c", "P": "#13201a", "h": "#ffffff",  # 绿眼睛、深绿、瞳孔、高光
    "N": "#d4826e", "n": "#7d4a30", "p": "#e8a090",  # 鼻子、嘴、耳朵里
    "W": "#f5f2ea", "w": "#d6d0c4", "k": "#3a3d48",  # 气泡、气泡底边、输入点
}
BACKGROUND = "#17181e"  # 墨色，和 App 主操作同一个色系

# iOS 深色外观：背景透明（系统垫自己的深色底），亮白的气泡压暗，输入点反过来变浅。
DARK = {"W": "#3a3d47", "w": "#2b2d34", "k": "#d9d4c8"}

# iOS 着色外观：其余颜色按亮度转灰；气泡原本最亮，会抢猫脸，压到中灰。
TINTED = {"W": "#a0a0a0", "w": "#787878", "k": "#262626"}

# 主图：24×24。iOS、macOS、apple-touch-icon 都从它放大。
MAIN = [
    "........................",
    ".....O............O.....",
    ".....OO..........OO.....",
    ".....OdOO.OOOO.OOdO.....",
    ".....OpddOddddOddpO.....",
    ".....OppddddddddppO.....",
    ".....OdgdgdgdgdgdgO.....",
    "....OggeeggggggeeggO....",
    "....OgePheggggePhegO....",
    "....OgEPPEggggEPPEgO....",
    "....OllEElcccclEEllO....",
    ".....OlllccNNcclllO.....",
    ".....OllcncnncncllO.....",
    "....OOOOOOnOOnOOOOOO....",
    "...WOcccOWWWWWWOcccOW...",
    "..WWOoOoOWWWWWWOoOoOWW..",
    "..WWWWWWWWWWWWWWWWWWWW..",
    "..WWWWWWkkWkkWkkWWWWWW..",
    "..WWWWWWkkWkkWkkWWWWWW..",
    "..WWWWWWWWWWWWWWWWWWWW..",
    "...wwwwwwwwwwwwwwwwww...",
    ".....ww.................",
    "........................",
    "........................",
]

# 16×16 简化版：favicon。24 格直接缩到 16px 会糊，所以另画，去掉了爪子。
SMALL = [
    "................",
    "..OO........OO..",
    ".OdpO......OpdO.",
    ".OdppOOOOOOppdO.",
    ".OddddddddddddO.",
    ".OgdgdgddgdgdgO.",
    "OgggPhggggPhgggO",
    "OgggPPggggPPgggO",
    "OlggEEgllgEEgglO",
    "OlllllcNNclllllO",
    ".WWWWWWWWWWWWWW.",
    "WWWWWWWWWWWWWWWW",
    "WWWkkWWkkWWkkWWW",
    "WWWWWWWWWWWWWWWW",
    ".wwwwwwwwwwwwww.",
    "..ww............",
]

# 菜单栏模板图：# 不透明，. 透明，系统按菜单栏深浅把它染黑或染白。
# 这一张是「忙」：气泡里有输入点。其余状态在 export.py 里由它变出来。
TRAY = [
    "................",
    "..##........##..",
    ".####......####.",
    ".##############.",
    ".##############.",
    ".##############.",
    "####..####..####",
    "####..####..####",
    "####..####..####",
    "################",
    "................",
    ".##############.",
    "###..##..##..###",
    "################",
    ".##############.",
    "..##............",
]
TRAY_DOTS_ROW = 12  # 输入点所在的行，「空闲」时把它填满

# 「等你批准」的角标：盖在右上角，四周挖空一圈，和猫头分开。
BADGE = [
    ".###.",
    "#####",
    "#####",
    "#####",
    ".###.",
]
BADGE_AT = (11, 0)
