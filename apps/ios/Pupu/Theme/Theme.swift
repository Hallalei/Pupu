import UIKit

/// 「Pupu 设计规范」里的颜色、字体和尺寸。
/// 颜色在 Assets.xcassets/Colors 里，由 tools/colors.py 从规范的 tokens.json 生成，名字和 token 一样。
enum Theme {
    static func color(_ name: String) -> UIColor {
        UIColor(named: name) ?? .systemPink
    }

    // 天空
    static let sky = ["sky-1", "sky-2", "sky-3", "sky-4", "sky-5"].map { color($0) }

    // 内容层
    static let surfaceGlass = color("surface-glass")
    static let surfaceStrong = color("surface-strong")
    static let surfaceInset = color("surface-inset")
    static let bubbleUser = color("bubble-user")
    static let lineGlass = color("line-glass")
    static let scrim = color("scrim")

    // 文字
    static let ink = color("ink")
    static let inkMuted = color("ink-muted")
    static let inkSky = color("ink-sky")
    static let inkSkyMuted = color("ink-sky-muted")
    static let onSkyStrong = color("on-sky-strong")

    // 操作和状态
    static let action = color("action")
    static let onAction = color("on-action")
    static let online = color("online")
    static let offline = color("offline")
    static let warning = color("warning")
    static let onWarning = color("on-warning")
    static let danger = color("danger")
    static let dangerInk = color("danger-ink")

    /// 规范里的间距（pt）。
    enum Space {
        static let s1: CGFloat = 4
        static let s2: CGFloat = 8
        static let s2_5: CGFloat = 10
        static let s3: CGFloat = 12
        static let s4: CGFloat = 16
        static let s5: CGFloat = 20
        static let s6: CGFloat = 24
        static let s8: CGFloat = 32
    }

    /// 规范里的圆角（pt），都用连续曲率。
    enum Radius {
        static let tag: CGFloat = 12
        static let row: CGFloat = 16
        static let bubble: CGFloat = 24
        static let composer: CGFloat = 26
        static let panel: CGFloat = 28
    }

    enum Size {
        static let avatar: CGFloat = 32
        static let controlSmall: CGFloat = 36
        static let control: CGFloat = 44
        static let bubbleMax: CGFloat = 0.85
    }

    /// 规范里的文字样式。字号是默认大小（大）下的值，跟着 Dynamic Type 缩放。
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

    /// `message` 的行高是 26pt，跟着 Dynamic Type 等比放大。
    static func messageParagraph() -> NSMutableParagraphStyle {
        let paragraph = NSMutableParagraphStyle()
        let height = UIFontMetrics(forTextStyle: .body).scaledValue(for: 26)
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
