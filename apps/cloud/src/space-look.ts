/**
 * 空间的颜色和图标，见设计规范的 SpaceColor、SpaceMark。颜色只染窗框和标记方块，图标是 16×16 的像素画
 * （源头 design/space-icons）。id 存进数据库、发给各端以后不改。
 */

/** 六个空间色，雾蓝是默认。 */
export const SPACE_COLORS = ["mist", "sage", "apricot", "lilac", "lemon", "graphite"] as const;
export type SpaceColor = (typeof SPACE_COLORS)[number];
export const DEFAULT_SPACE_COLOR: SpaceColor = "mist";

/** 二十个空间图标，顺序和规范资产「空间图标」一样。 */
export const SPACE_ICONS = [
  "folder",
  "rocket",
  "house",
  "book",
  "briefcase",
  "code",
  "chart",
  "palette",
  "music",
  "camera",
  "leaf",
  "globe",
  "heart",
  "star",
  "coffee",
  "gift",
  "bulb",
  "flag",
  "chat",
  "paw"
] as const;
export type SpaceIcon = (typeof SPACE_ICONS)[number];

export function isSpaceColor(value: unknown): value is SpaceColor {
  return SPACE_COLORS.includes(value as SpaceColor);
}

export function isSpaceIcon(value: unknown): value is SpaceIcon {
  return SPACE_ICONS.includes(value as SpaceIcon);
}

/** 名字里出现这些词就用这个图标。前面的先比，「官网改版」是地球不是调色板。 */
const KEYWORDS: readonly (readonly [SpaceIcon, readonly string[]])[] = [
  ["paw", ["猫", "狗", "宠物", "pet"]],
  ["globe", ["官网", "网站", "网页", "域名", "海外", "国际", "seo", "web", "site"]],
  ["code", ["代码", "开发", "研发", "工程", "前端", "后端", "接口", "bug", "api", "app", "code"]],
  ["chart", ["数据", "报表", "周报", "月报", "日报", "分析", "指标", "统计", "财报", "增长", "kpi"]],
  ["briefcase", ["招聘", "面试", "销售", "客户", "商务", "合同", "人事", "hr"]],
  ["rocket", ["上线", "发布", "发版", "启动", "冲刺", "launch", "mvp"]],
  ["palette", ["设计", "品牌", "视觉", "插画", "美术", "design", "ui"]],
  ["camera", ["拍摄", "视频", "照片", "摄影", "短片", "宣传片", "直播", "video"]],
  ["music", ["音乐", "歌", "播客", "音频", "podcast"]],
  ["book", ["读书", "笔记", "学习", "文档", "课程", "知识", "wiki", "book"]],
  ["house", ["家庭", "家里", "家居", "装修", "房子", "搬家", "租房"]],
  ["leaf", ["健康", "健身", "运动", "植物", "养生", "环保"]],
  ["coffee", ["团建", "下午茶", "聚餐", "午饭", "咖啡"]],
  ["gift", ["礼物", "节日", "抽奖", "活动"]],
  ["heart", ["生日", "婚礼", "公益", "关怀", "福利"]],
  ["bulb", ["想法", "创意", "点子", "灵感", "头脑风暴", "调研", "研究", "idea"]],
  ["flag", ["计划", "规划", "目标", "里程碑", "okr"]],
  ["chat", ["客服", "沟通", "反馈", "社群", "会议", "访谈"]],
  ["star", ["精选", "收藏", "年度", "评选"]]
];

/**
 * 新空间按名字挑一个图标（规范：「官网改版」用地球）。哪个词都没碰上是 null，方块里写名字的第一个字。
 * Pupu 建空间时可以自己挑，挑的不是这二十个之一才走这里。
 */
export function pickSpaceIcon(name: string): SpaceIcon | null {
  const text = name.toLowerCase();
  for (const [icon, words] of KEYWORDS) {
    if (words.some((word) => mentions(text, word))) return icon;
  }
  return null;
}

/** 中文按字面找；英文要整个词，「build」里的 ui、「happy」里的 app 不算。 */
function mentions(text: string, word: string): boolean {
  if (!/^[a-z]+$/.test(word)) return text.includes(word);
  return new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(text);
}
