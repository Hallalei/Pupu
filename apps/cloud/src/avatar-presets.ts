// 由 design/avatars/export.py 生成，别手改。加头像改 design/avatars/people.py 或 presets.py 再跑一遍。

/** 成员能选的预设头像：像素小人。图在 public/avatars/<id>.png。 */
export const AVATAR_PRESETS = [
  { id: "gold-fighter", name: "金发战士" },
  { id: "black-fighter", name: "黑发战士" },
  { id: "bald-hero", name: "光头英雄" },
  { id: "straw-hat", name: "草帽" },
  { id: "green-swordsman", name: "绿发剑士" },
  { id: "blond-cook", name: "金发厨师" },
  { id: "orange-navigator", name: "橙发航海士" },
  { id: "blue-genius", name: "蓝发天才" },
] as const;

/** Pupu 能换的预设头像：Pupu 衍生的像素猫。 */
export const PUPU_AVATAR_PRESETS = [
  { id: "orange", name: "橘子" },
  { id: "black", name: "煤球" },
  { id: "white", name: "雪团" },
  { id: "gray", name: "灰灰" },
  { id: "calico", name: "三花" },
  { id: "siamese", name: "暹罗" },
  { id: "tuxedo", name: "奶牛" },
  { id: "golden-happy", name: "笑笑" },
  { id: "cream-wink", name: "眨眼" },
  { id: "orange-beanie", name: "毛线帽" },
  { id: "gray-sleepy", name: "困了" },
  { id: "black-crown", name: "国王" },
] as const;
