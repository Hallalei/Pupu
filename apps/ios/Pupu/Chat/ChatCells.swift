import UIKit

/// 气泡的内边距：左右 space-4，上下 space-2.5。
enum Bubble {
    static let insets = UIEdgeInsets(top: Theme.Space.s2_5, left: Theme.Space.s4, bottom: Theme.Space.s2_5, right: Theme.Space.s4)
    static let horizontal = insets.left + insets.right
}

/// 列表里所有行的底：顶上留出和上一行的间距。
/// 宽度由控制器算好传进来（列宽的 85%），文字按它换行，cell 跟着内容自适应高度。
class ChatCell: UICollectionViewCell {
    let body = UIView()
    private var top: NSLayoutConstraint!

    override init(frame: CGRect) {
        super.init(frame: frame)
        body.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(body)
        top = body.topAnchor.constraint(equalTo: contentView.topAnchor)
        NSLayoutConstraint.activate([
            top,
            body.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            body.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            body.bottomAnchor.constraint(equalTo: contentView.bottomAnchor)
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    override func prepareForReuse() {
        super.prepareForReuse()
        body.transform = .identity
        body.alpha = 1
    }

    var gap: CGFloat {
        get { top.constant }
        set { top.constant = newValue }
    }

    /// 长按菜单的预览和「闪一下」用的视图：有气泡的行返回气泡。
    var bubbleView: UIView? { nil }
    var bubbleRadius: CGFloat { Theme.Radius.bubble }
    /// 预览的底色：气泡自己有底，透明就行；没有底的（Pupu 的回复）铺卡片的底。
    var previewBackground: UIColor { .clear }
    /// 预览比 `bubbleView` 往外多出的一圈。
    var previewOutset: UIEdgeInsets { .zero }

    /// 放一个靠左、靠右或居中的视图，最宽占 `fraction`。
    func place(_ view: UIView, alignment: NSTextAlignment, fraction: CGFloat = Theme.Size.bubbleMax) {
        view.translatesAutoresizingMaskIntoConstraints = false
        body.addSubview(view)
        let edge: NSLayoutConstraint = switch alignment {
        case .right: view.trailingAnchor.constraint(equalTo: body.trailingAnchor)
        case .center: view.centerXAnchor.constraint(equalTo: body.centerXAnchor)
        default: view.leadingAnchor.constraint(equalTo: body.leadingAnchor)
        }
        NSLayoutConstraint.activate([
            edge,
            view.topAnchor.constraint(equalTo: body.topAnchor),
            view.bottomAnchor.constraint(equalTo: body.bottomAnchor),
            view.widthAnchor.constraint(lessThanOrEqualTo: body.widthAnchor, multiplier: fraction)
        ])
    }
}

// MARK: - 我的消息

final class UserCell: ChatCell {
    private let bubble = SurfaceView(.user, radius: Theme.Radius.bubble)
    private let label = UILabel(style: .message, lines: 0)
    private let quote = QuoteStrip()
    var onQuote: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        bubble.contentView.addSubview(label)
        label.pin(to: bubble.contentView, insets: Bubble.insets)
        let stack = UIStackView(arrangedSubviews: [quote, bubble])
        stack.axis = .vertical
        stack.alignment = .trailing
        stack.spacing = Theme.Space.s1
        place(stack, alignment: .right)
        quote.addAction(UIAction { [weak self] _ in self?.onQuote?() }, for: .touchUpInside)
        isAccessibilityElement = true
    }

    required init?(coder: NSCoder) { fatalError() }

    override var bubbleView: UIView? { bubble }

    func configure(body: String, quote text: String?, width: CGFloat) {
        label.attributedText = NSAttributedString(string: body, attributes: Theme.messageAttributes())
        label.preferredMaxLayoutWidth = width - Bubble.horizontal
        quote.isHidden = text == nil
        // 引用 Pupu 的话时存的是 Markdown 原文，显示时去掉标记。
        quote.configure(text.map(Markdown.plainText) ?? "", width: width)
        accessibilityLabel = (text.map { "回复「\($0)」。" } ?? "") + "我：\(body)"
    }
}

// MARK: - 别人的消息

/// 靠左：28pt 头像在气泡左下旁边，名字写在气泡里第一行（`footnote`、`ink-muted`）。
final class OtherCell: ChatCell {
    private let avatar = SurfaceView(.inset, radius: Theme.Size.avatarMessage / 2)
    private let initial = UILabel(style: .caption)
    private let picture = UIImageView()
    private var avatarPath: String?
    private var avatarToken: NSObjectProtocol?
    private let bubble = SurfaceView(.user, radius: Theme.Radius.bubble)
    private let name = UILabel(style: .footnote, color: Theme.inkMuted)
    private let label = UILabel(style: .message, lines: 0)
    private let quote = QuoteStrip()
    var onQuote: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        initial.textAlignment = .center
        avatar.contentView.addSubview(initial)
        initial.pin(to: avatar.contentView)
        picture.contentMode = .scaleAspectFill
        picture.clipsToBounds = true
        picture.layer.cornerRadius = Theme.Size.avatarMessage / 2
        avatar.contentView.addSubview(picture)
        picture.pin(to: avatar.contentView)
        // 头像图拿到了再补上：列表不用为了一张图整个重画。
        avatarToken = NotificationCenter.default.addObserver(forName: Avatars.loaded, object: nil, queue: .main) { [weak self] note in
            let path = note.object as? String
            MainActor.assumeIsolated {
                guard let self, let path, path == self.avatarPath else { return }
                self.showAvatar()
            }
        }
        NSLayoutConstraint.activate([
            avatar.widthAnchor.constraint(equalToConstant: Theme.Size.avatarMessage),
            avatar.heightAnchor.constraint(equalToConstant: Theme.Size.avatarMessage)
        ])

        let text = UIStackView(arrangedSubviews: [name, label])
        text.axis = .vertical
        text.spacing = Theme.Space.s0_5
        bubble.contentView.addSubview(text)
        text.pin(to: bubble.contentView, insets: Bubble.insets)
        let column = UIStackView(arrangedSubviews: [quote, bubble])
        column.axis = .vertical
        column.alignment = .leading
        column.spacing = Theme.Space.s1

        let row = UIStackView(arrangedSubviews: [avatar, column])
        row.alignment = .bottom
        row.spacing = Theme.Space.s2
        place(row, alignment: .left)
        quote.addAction(UIAction { [weak self] _ in self?.onQuote?() }, for: .touchUpInside)
        isAccessibilityElement = true
    }

    required init?(coder: NSCoder) { fatalError() }

    override var bubbleView: UIView? { bubble }

    func configure(body: String, quote text: String?, sender: Sender, avatar path: String?, width: CGFloat) {
        let column = width - Theme.Size.avatarMessage - Theme.Space.s2
        initial.text = sender.name.first.map { String($0).uppercased() }
        avatarPath = path
        showAvatar()
        name.text = sender.name
        label.attributedText = NSAttributedString(string: body, attributes: Theme.messageAttributes())
        label.preferredMaxLayoutWidth = column - Bubble.horizontal
        quote.isHidden = text == nil
        quote.configure(text.map(Markdown.plainText) ?? "", width: column)
        accessibilityLabel = (text.map { "回复「\($0)」。" } ?? "") + "\(sender.name)：\(body)"
    }

    /// 有图盖在首字上面，没图（没换过、还没拿到）露出首字。
    private func showAvatar() {
        let image = Avatars.shared.image(avatarPath)
        picture.image = image
        picture.isHidden = image == nil
        picture.layer.magnificationFilter = Avatars.isPixelArt(avatarPath) ? .nearest : .linear
        initial.isHidden = image != nil
    }
}

/// 发出去的引用（规范 QuoteReply）：`surface-inset` 底、`radius-row`，左边 2pt `ink-muted` 竖线，
/// `footnote`、`ink-muted`，最多两行。点它滚回原消息。
final class QuoteStrip: UIControl {
    private let surface = SurfaceView(.inset, radius: Theme.Radius.row)
    private let label = UILabel(style: .footnote, color: Theme.inkMuted, lines: 2)

    init() {
        super.init(frame: .zero)
        surface.isUserInteractionEnabled = false
        addSubview(surface)
        surface.pin(to: self)
        let bar = UIView()
        bar.backgroundColor = Theme.inkMuted
        bar.layer.cornerRadius = 1
        bar.widthAnchor.constraint(equalToConstant: 2).isActive = true
        let row = UIStackView(arrangedSubviews: [bar, label])
        row.spacing = Theme.Space.s2
        surface.contentView.addSubview(row)
        row.pin(to: surface.contentView, insets: UIEdgeInsets(top: 6, left: Theme.Space.s3, bottom: 6, right: Theme.Space.s3))
        accessibilityTraits = .button
        accessibilityHint = "滚回被引用的消息"
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(_ text: String, width: CGFloat) {
        label.text = text
        label.preferredMaxLayoutWidth = width - Theme.Space.s3 * 2 - Theme.Space.s2 - 2
        accessibilityLabel = "引用：\(text)"
    }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.6 : 1 }
    }
}

// MARK: - Pupu 的消息

/// Pupu 的回复不套气泡（规范 MessageBubble）：没有底色、描边和头像，用 `message` 直接写在卡片上，占满整列。
final class AssistantCell: ChatCell {
    private let stack = UIStackView()
    private var text = ""
    var onLink: ((URL) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        stack.axis = .vertical
        stack.spacing = Theme.Space.s2
        place(stack, alignment: .left, fraction: 1)
        stack.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true
        isAccessibilityElement = true
    }

    required init?(coder: NSCoder) { fatalError() }

    override var bubbleView: UIView? { stack }
    override var bubbleRadius: CGFloat { Theme.Radius.row }
    /// 长按时浮起来的预览铺上卡片的底，四周留一点，字不贴边。
    override var previewBackground: UIColor { Theme.surface }
    override var previewOutset: UIEdgeInsets { UIEdgeInsets(top: Theme.Space.s2, left: Theme.Space.s3, bottom: Theme.Space.s2, right: Theme.Space.s3) }

    func configure(text next: String, width: CGFloat) {
        let segments = Markdown.segments(next)
        let views = stack.arrangedSubviews
        for (index, segment) in segments.enumerated() {
            let existing = index < views.count ? views[index] : nil
            switch segment {
            case .text(let attributed):
                let label = (existing as? LinkLabel) ?? replace(at: index, with: LinkLabel())
                if text != next || label.attributedText != attributed { label.attributedText = attributed }
                label.preferredMaxLayoutWidth = width
                label.onLink = { [weak self] url in self?.onLink?(url) }
            case .code(let code):
                let block = (existing as? CodeScrollView) ?? replace(at: index, with: CodeScrollView())
                block.text = code
            }
        }
        for view in stack.arrangedSubviews.dropFirst(segments.count) { view.removeFromSuperview() }
        text = next
        accessibilityLabel = "Pupu：" + Markdown.plainText(next)
    }

    private func replace<View: UIView>(at index: Int, with view: View) -> View {
        if index < stack.arrangedSubviews.count { stack.arrangedSubviews[index].removeFromSuperview() }
        stack.insertArrangedSubview(view, at: index)
        return view
    }
}

/// 代码块：等宽字、surface-inset 底，不换行，宽了横向滚动。
final class CodeScrollView: UIScrollView {
    private let label = UILabel(style: .code, lines: 0)

    var text: String? {
        get { label.text }
        set { if label.text != newValue { label.text = newValue } }
    }

    init() {
        super.init(frame: .zero)
        backgroundColor = Theme.surfaceInset
        layer.cornerRadius = Theme.Radius.tag
        layer.cornerCurve = .continuous
        showsHorizontalScrollIndicator = false
        alwaysBounceVertical = false
        label.lineBreakMode = .byClipping
        label.preferredMaxLayoutWidth = 10_000
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        let content = contentLayoutGuide
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: Theme.Space.s3),
            label.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -Theme.Space.s3),
            label.topAnchor.constraint(equalTo: content.topAnchor, constant: Theme.Space.s2),
            label.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -Theme.Space.s2),
            frameLayoutGuide.heightAnchor.constraint(equalTo: content.heightAnchor)
        ])
    }

    required init?(coder: NSCoder) { fatalError() }
}

// MARK: - 正在想

/// Pupu 还没出字：`bubble-user` 底的小气泡里三个点，`ink-muted`，依次明暗。
final class TypingCell: ChatCell {
    private let bubble = SurfaceView(.user, radius: Theme.Radius.bubble)
    private let dots = (0..<3).map { _ in UIView() }
    private let label = UILabel(style: .subheadline, color: Theme.inkMuted)

    override init(frame: CGRect) {
        super.init(frame: frame)
        let row = UIStackView(arrangedSubviews: dots)
        row.spacing = 5
        row.alignment = .center
        for dot in dots {
            dot.backgroundColor = Theme.inkMuted
            dot.layer.cornerRadius = 3
            dot.widthAnchor.constraint(equalToConstant: 6).isActive = true
            dot.heightAnchor.constraint(equalToConstant: 6).isActive = true
        }
        let line = UIStackView(arrangedSubviews: [row, label])
        line.spacing = Theme.Space.s2
        line.alignment = .center
        line.heightAnchor.constraint(greaterThanOrEqualToConstant: Theme.messageParagraph().minimumLineHeight).isActive = true
        bubble.contentView.addSubview(line)
        line.pin(to: bubble.contentView, insets: Bubble.insets)
        place(bubble, alignment: .left)
        isAccessibilityElement = true
        accessibilityTraits = .updatesFrequently
    }

    required init?(coder: NSCoder) { fatalError() }

    override var bubbleView: UIView? { bubble }

    func configure(retrying: Bool) {
        label.text = retrying ? "模型忙，正在重试…" : nil
        label.isHidden = !retrying
        accessibilityLabel = retrying ? "模型忙，正在重试" : "Pupu 在想"
        animate()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { animate() }
    }

    private func animate() {
        let now = CACurrentMediaTime()
        for (index, dot) in dots.enumerated() {
            let pulse = CABasicAnimation(keyPath: "opacity")
            pulse.fromValue = 1
            pulse.toValue = 0.25
            pulse.duration = 0.6
            pulse.autoreverses = true
            pulse.repeatCount = .infinity
            pulse.beginTime = now + Double(index) * 0.15
            pulse.fillMode = .backwards
            dot.layer.add(pulse, forKey: "pulse")
        }
    }
}

// MARK: - 项目标签

/// 回复上方的项目标签：这件事交给了哪个空间，点一下过去。规范没画，和网页一样照 SpaceMark 加名字：
/// `surface-inset` 底，高 32，标记方块离左边 6，外圆角跟着方块（6 加 6），名字 `footnote`。
final class TagCell: ChatCell {
    private let button = TapControl()
    private let mark = SpaceMarkView()
    private let name = UILabel(style: .footnote)
    var onTap: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        button.backgroundColor = Theme.surfaceInset
        button.layer.cornerRadius = Theme.Radius.mark + 6
        button.layer.cornerCurve = .continuous
        name.lineBreakMode = .byTruncatingTail
        let row = UIStackView(arrangedSubviews: [mark, name])
        row.spacing = Theme.Space.s2
        row.alignment = .center
        row.isUserInteractionEnabled = false
        button.addSubview(row)
        row.pin(to: button, insets: UIEdgeInsets(top: 6, left: 6, bottom: 6, right: Theme.Space.s3))
        button.heightAnchor.constraint(greaterThanOrEqualToConstant: 32).isActive = true
        button.addAction(UIAction { [weak self] _ in self?.onTap?() }, for: .primaryActionTriggered)
        button.addAction(UIAction { [weak self] _ in self?.button.alpha = 0.6 }, for: [.touchDown, .touchDragEnter])
        button.addAction(UIAction { [weak self] _ in self?.button.alpha = 1 }, for: [.touchUpInside, .touchUpOutside, .touchDragExit, .touchCancel])
        button.isAccessibilityElement = true
        button.accessibilityTraits = .button
        place(button, alignment: .left, fraction: 0.8)
    }

    required init?(coder: NSCoder) { fatalError() }

    /// project 是对得上的那个空间，用它的颜色和图标；对不上（建了又删了）就只有名字，按钮点不了。
    func configure(name text: String, project: Project?) {
        name.text = text
        if let project { mark.show(project) } else { mark.show(color: nil, icon: nil, name: text) }
        button.isEnabled = project != nil
        button.accessibilityLabel = "空间：\(text)"
        button.accessibilityHint = project != nil ? "打开这个空间" : nil
    }
}

// MARK: - 提示和出错

/// 居中的一句提示：「上下文已重置」「已切换到 DeepSeek」。`surface-inset` 底、`radius-row`，`footnote`、`ink-muted`，最宽 85%。
final class NoticeCell: ChatCell {
    private let surface = SurfaceView(.inset, radius: Theme.Radius.row)
    private let label = UILabel(style: .footnote, color: Theme.inkMuted, lines: 0)

    override init(frame: CGRect) {
        super.init(frame: frame)
        label.textAlignment = .center
        surface.contentView.addSubview(label)
        label.pin(to: surface.contentView, insets: UIEdgeInsets(top: Theme.Space.s2, left: Theme.Space.s3, bottom: Theme.Space.s2, right: Theme.Space.s3))
        place(surface, alignment: .center)
        isAccessibilityElement = true
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(_ text: String, width: CGFloat) {
        label.text = text
        label.preferredMaxLayoutWidth = width - Theme.Space.s3 * 2
        accessibilityLabel = text
    }
}

/// 子会话最上面那块「从主会话派来」（规范 SubSession）：占满整列，`surface-inset` 底、圆角 14，
/// 第一行 `footnote` 600 写从哪来，下面 `footnote`、`ink-muted` 是派来时的那段话。
final class HandoffCell: ChatCell {
    private let surface = SurfaceView(.inset, radius: 14)
    private let heading = UILabel(style: .footnote)
    private let label = UILabel(style: .footnote, color: Theme.inkMuted, lines: 0)

    override init(frame: CGRect) {
        super.init(frame: frame)
        heading.font = Theme.font(.footnote, weight: .semibold)
        let stack = UIStackView(arrangedSubviews: [heading, label])
        stack.axis = .vertical
        stack.spacing = Theme.Space.s0_5
        surface.contentView.addSubview(stack)
        stack.pin(to: surface.contentView, insets: UIEdgeInsets(top: Theme.Space.s2_5, left: 14, bottom: Theme.Space.s2_5, right: 14))
        place(surface, alignment: .left, fraction: 1)
        surface.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true
        isAccessibilityElement = true
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(heading text: String, body: String, width: CGFloat) {
        heading.text = text
        label.text = body
        label.preferredMaxLayoutWidth = width - 28
        accessibilityLabel = "\(text)：\(body)"
    }
}

/// 对话里的出错提示（规范 StatusLine）：跟在出事的那一步后面，靠左，内边距和气泡一样，`subheadline`、`danger-ink`。
/// 规范写 `surface` 底，会话卡本身就是 `surface`，和网页一样照预览用 `surface-inset`。
final class ErrorCell: ChatCell {
    private let surface = SurfaceView(.inset, radius: Theme.Radius.row)
    private let label = UILabel(style: .subheadline, color: Theme.dangerInk, lines: 0)

    override init(frame: CGRect) {
        super.init(frame: frame)
        surface.contentView.addSubview(label)
        label.pin(to: surface.contentView, insets: Bubble.insets)
        place(surface, alignment: .left)
        isAccessibilityElement = true
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(_ text: String, width: CGFloat) {
        label.text = text
        label.preferredMaxLayoutWidth = width - Bubble.horizontal
        accessibilityLabel = text
    }
}

/// 时间分隔线：隔了一段时间才出现，居中的 `footnote`、`ink-muted`，两边 `line` 细线：「今天 14:02」。
final class TimeCell: ChatCell {
    private let label = UILabel(style: .footnote, color: Theme.inkMuted)

    override init(frame: CGRect) {
        super.init(frame: frame)
        let rules = (0..<2).map { _ in
            let rule = UIView()
            rule.backgroundColor = Theme.line
            rule.heightAnchor.constraint(equalToConstant: 1).isActive = true
            return rule
        }
        label.setContentHuggingPriority(.required, for: .horizontal)
        label.setContentCompressionResistancePriority(.required, for: .horizontal)
        let row = UIStackView(arrangedSubviews: [rules[0], label, rules[1]])
        row.spacing = Theme.Space.s2
        row.alignment = .center
        rules[0].widthAnchor.constraint(equalTo: rules[1].widthAnchor).isActive = true
        row.translatesAutoresizingMaskIntoConstraints = false
        body.addSubview(row)
        row.pin(to: body)
        isAccessibilityElement = true
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(at: Double) {
        label.text = ChatRows.dividerTime(at)
        accessibilityLabel = label.text
    }
}
