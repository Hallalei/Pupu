import UIKit

/// 「Pupu 设计规范」的 tokens，手机这一档。
/// 颜色在 Assets.xcassets/Colors 里，由 tools/colors.py 从规范的 tokens.json 生成，名字和 token 一样。
/// 自定义的视图和按钮一律实色，不用 Liquid Glass；系统组件（导航栏按钮、菜单、sheet、弹窗）交给系统。
enum Theme {
    static func color(_ name: String) -> UIColor {
        UIColor(named: name) ?? .systemPink
    }

    // 窗框和内容层
    /// 「我的 Pupu」的窗框；空间的窗框见 `SpaceColor.frame`。
    static let canvas = color("canvas")
    /// 会话卡。
    static let surface = color("surface")
    /// sheet 的底。
    static let surfaceSheet = color("surface-sheet")
    /// 卡片里再嵌一层：输入栏、代码块、分组列表的行、次要按钮。
    static let surfaceInset = color("surface-inset")
    /// 我和别人的气泡。
    static let bubbleUser = color("bubble-user")
    /// 分隔线、描边。
    static let line = color("line")
    /// 窗框上选中的东西：顶栏左右的按钮。
    static let selected = color("selected")
    /// sheet 和放大视图背后的压暗层，纯色，不加模糊。
    static let scrim = color("scrim")

    // 文字
    static let ink = color("ink")
    static let inkMuted = color("ink-muted")
    static let inkFaint = color("ink-faint")

    // 操作：主操作是墨色，没有品牌色。
    static let action = color("action")
    static let onAction = color("on-action")
    /// 主操作现在点不了时的底。
    static let actionOff = color("action-off")

    // 状态
    static let online = color("online")
    static let offline = color("offline")
    static let warning = color("warning")
    static let onWarning = color("on-warning")
    static let danger = color("danger")
    static let dangerInk = color("danger-ink")

    /// 远程桌面画面上的按钮底（和灵动岛一个颜色）。
    static let islandFill = color("island-fill")
    /// 灵动岛和远程桌面的黑底、上面的字和图标。两种主题一样，系统固定，不进资产目录（tools/colors.py 跳过它们）。
    static let island = UIColor.black
    static let onIsland = UIColor.white

    // 品牌层：只在登录页的天空上。
    static let sky = ["sky-1", "sky-2", "sky-3", "sky-4", "sky-5"].map { color($0) }
    static let inkSky = color("ink-sky")
    static let inkSkyMuted = color("ink-sky-muted")
    static let onSkyStrong = color("on-sky-strong")

    /// 空间标记方块里的图标和字。
    static let onMark = color("on-mark")

    /// 空间色（规范 SpaceColor）：染窗框和标记方块，不染内容。和云端 space-look.ts 的 SPACE_COLORS 一样。
    enum SpaceColor: String, CaseIterable, Sendable {
        case mist, sage, apricot, lilac, lemon, graphite

        /// 认不出的（老云端没给、或者以后加了新颜色）按雾蓝画。
        init(id: String?) {
            self = id.flatMap(Self.init(rawValue:)) ?? .mist
        }

        /// 原色：空间设置里的色板。
        var swatch: UIColor { Theme.color("space-\(rawValue)") }
        /// 默认强度（30%）下的窗框。
        var frame: UIColor { Theme.color("frame-\(rawValue)") }
        /// 标记方块的底。
        var mark: UIColor { Theme.color("mark-\(rawValue)") }

        var name: String {
            switch self {
            case .mist: "雾蓝"
            case .sage: "鼠尾草"
            case .apricot: "杏"
            case .lilac: "丁香"
            case .lemon: "柠檬"
            case .graphite: "石墨"
            }
        }
    }

    /// 空间图标：资产 `space-icon-<id>`，由 tools/space_icons.py 从 design/space-icons 生成。和云端 SPACE_ICONS 一样。
    enum SpaceIcon: String, CaseIterable, Sendable {
        case folder, rocket, house, book, briefcase, code, chart, palette, music, camera
        case leaf, globe, heart, star, coffee, gift, bulb, flag, chat, paw

        var image: UIImage? { UIImage(named: "space-icon-\(rawValue)")?.withRenderingMode(.alwaysTemplate) }

        var name: String {
            switch self {
            case .folder: "文件夹"
            case .rocket: "火箭"
            case .house: "房子"
            case .book: "书"
            case .briefcase: "公文包"
            case .code: "代码"
            case .chart: "图表"
            case .palette: "调色板"
            case .music: "音符"
            case .camera: "相机"
            case .leaf: "叶子"
            case .globe: "地球"
            case .heart: "爱心"
            case .star: "星星"
            case .coffee: "咖啡"
            case .gift: "礼物"
            case .bulb: "灯泡"
            case .flag: "旗子"
            case .chat: "对话"
            case .paw: "爪印"
            }
        }
    }

    /// 间距（pt），4pt 网格。
    enum Space {
        /// 行里名字和第二行之间，只用在这里。
        static let s0_5: CGFloat = 2
        static let s1: CGFloat = 4
        static let s2: CGFloat = 8
        static let s2_5: CGFloat = 10
        static let s3: CGFloat = 12
        static let s4: CGFloat = 16
        static let s5: CGFloat = 20
        static let s6: CGFloat = 24
        static let s8: CGFloat = 32
        /// 卡片离屏幕边和窗框的距离；sheet 也离屏幕边 6。
        static let frameGap: CGFloat = 6
    }

    /// 圆角（pt），都用连续曲率。
    enum Radius {
        /// 代码块、截图缩略图里的小块。
        static let tag: CGFloat = 8
        /// 20pt 的空间标记方块。
        static let mark: CGFloat = 6
        /// 40pt 的空间标记方块。
        static let markLarge: CGFloat = 12
        /// 输入框。
        static let field: CGFloat = 12
        /// 分组列表、任务列表外框、工具卡片、「从主会话派来」那块。
        static let row: CGFloat = 16
        /// 消息气泡、引用预览。
        static let bubble: CGFloat = 20
        /// 输入栏，单行时是胶囊。
        static let composer: CGFloat = 25
        /// 会话卡的上角：顶部和导航栏之间是直的，不需要和屏幕同心。
        static let cardTop: CGFloat = 26
        /// 会话卡和 sheet 的下角：屏幕圆角 47 减 frame-gap 6。
        static let card: CGFloat = 41
        /// sheet 的上角。
        static let sheetTop: CGFloat = 32
    }

    enum Size {
        /// 圆形图标按钮的直径：发送、停止、关闭引用。触控区补到 control。
        static let controlSmall: CGFloat = 36
        /// 最小触控区；顶栏左右按钮。
        static let control: CGFloat = 44
        /// 气泡和引用最宽占内容列的比例。
        static let bubbleMax: CGFloat = 0.85
        /// 对话列的最大宽度：iPad 和横屏居中放。
        static let columnMax: CGFloat = 700
        /// 空间标记方块。
        static let mark: CGFloat = 20
        static let markLarge: CGFloat = 40
        /// 别人消息旁的头像（规范 uikit.md「28pt 头像」）。
        static let avatarMessage: CGFloat = 28
        /// 成员头像叠在一起时。
        static let avatarSmall: CGFloat = 22
    }

    /// 阴影：一圈 0.5pt 的边加一层很淡的投影。深色只留那圈边。
    enum Shadow {
        /// 浮在窗框上的卡片和 sheet。
        case card
        /// 窗框上选中的东西：顶栏左右的按钮。
        case selected
        /// 卡片里稍稍抬起的东西：截图、色板。
        case raised
    }

    /// 文字样式。字号是默认大小（大）下的值，跟着 Dynamic Type 缩放。
    enum Text {
        case greeting, title, headline, message, body, subheadline, footnote, caption, code
    }

    static func font(_ text: Text) -> UIFont {
        switch text {
        case .greeting: scaled(.title1, size: 28, weight: .semibold)
        case .title: scaled(.title3, size: 20, weight: .semibold)
        case .headline: scaled(.headline, size: 17, weight: .semibold)
        case .message, .body: scaled(.body, size: 17, weight: .regular)
        case .subheadline: scaled(.subheadline, size: 15, weight: .regular)
        case .footnote: scaled(.footnote, size: 13, weight: .medium)
        case .caption: scaled(.caption1, size: 12, weight: .regular)
        case .code:
            UIFontMetrics(forTextStyle: .footnote)
                .scaledFont(for: .monospacedSystemFont(ofSize: 13, weight: .regular))
        }
    }

    static func font(_ text: Text, weight: UIFont.Weight) -> UIFont {
        let base = font(text)
        let style: UIFont.TextStyle = switch text {
        case .greeting: .title1
        case .title: .title3
        case .headline: .headline
        case .message, .body: .body
        case .subheadline: .subheadline
        case .footnote, .code: .footnote
        case .caption: .caption1
        }
        let size = base.pointSize / UIFontMetrics(forTextStyle: style).scaledValue(for: 1)
        return UIFontMetrics(forTextStyle: style).scaledFont(for: .systemFont(ofSize: size, weight: weight))
    }

    /// `message` 的行高是 27pt，跟着 Dynamic Type 等比放大。
    static func messageParagraph() -> NSMutableParagraphStyle {
        let paragraph = NSMutableParagraphStyle()
        let height = UIFontMetrics(forTextStyle: .body).scaledValue(for: 27)
        paragraph.minimumLineHeight = height
        paragraph.maximumLineHeight = height
        return paragraph
    }

    /// 正文用 `message` 样式时的属性。行高放大后字会贴底，用 baselineOffset 抬回中间。
    static func messageAttributes(color: UIColor = Theme.ink) -> [NSAttributedString.Key: Any] {
        let font = font(.message)
        let paragraph = messageParagraph()
        let offset = (paragraph.minimumLineHeight - font.lineHeight) / 4
        return [.font: font, .foregroundColor: color, .paragraphStyle: paragraph, .baselineOffset: offset]
    }

    private static func scaled(_ style: UIFont.TextStyle, size: CGFloat, weight: UIFont.Weight) -> UIFont {
        UIFontMetrics(forTextStyle: style).scaledFont(for: .systemFont(ofSize: size, weight: weight))
    }
}

extension UILabel {
    /// 用规范里的样式建一个跟随 Dynamic Type 的标签。
    convenience init(text: String? = nil, style: Theme.Text, color: UIColor = Theme.ink, lines: Int = 1) {
        self.init(frame: .zero)
        self.text = text
        font = Theme.font(style)
        textColor = color
        numberOfLines = lines
        adjustsFontForContentSizeCategory = true
    }
}

nonisolated enum Ago {
    /// 网页版的相对时间：刚刚、3 分钟前、2 小时前、1 天前。
    static func text(_ milliseconds: Double, now: Date = .now) -> String {
        let minutes = Int((now.timeIntervalSince1970 * 1000 - milliseconds) / 60_000)
        if minutes < 1 { return "刚刚" }
        if minutes < 60 { return "\(minutes) 分钟前" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours) 小时前" }
        return "\(hours / 24) 天前"
    }
}
