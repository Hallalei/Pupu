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

/// 靠左，头像在气泡旁边，名字在气泡里：滚动的字不直接写在天空上。
final class OtherCell: ChatCell {
    private let avatar = SurfaceView(.strong, radius: Theme.Size.avatar / 2)
    private let initial = UILabel(style: .footnote)
    private let picture = UIImageView()
    private var avatarPath: String?
    private var avatarToken: NSObjectProtocol?
    private let bubble = SurfaceView(.user, radius: Theme.Radius.bubble)
    private let name = UILabel(style: .footnote)
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
        picture.layer.cornerRadius = Theme.Size.avatar / 2
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
            avatar.widthAnchor.constraint(equalToConstant: Theme.Size.avatar),
            avatar.heightAnchor.constraint(equalToConstant: Theme.Size.avatar)
        ])

        let text = UIStackView(arrangedSubviews: [name, label])
        text.axis = .vertical
        bubble.contentView.addSubview(text)
        text.pin(to: bubble.contentView, insets: Bubble.insets)

        let column = UIStackView(arrangedSubviews: [quote, bubble])
        column.axis = .vertical
        column.alignment = .leading
        column.spacing = Theme.Space.s1

        let row = UIStackView(arrangedSubviews: [avatar, column])
        row.alignment = .top
        row.spacing = Theme.Space.s2
        place(row, alignment: .left)
        quote.addAction(UIAction { [weak self] _ in self?.onQuote?() }, for: .touchUpInside)
        isAccessibilityElement = true
    }

    required init?(coder: NSCoder) { fatalError() }

    override var bubbleView: UIView? { bubble }

    func configure(body: String, quote text: String?, sender: Sender, avatar path: String?, width: CGFloat) {
        let column = width - Theme.Size.avatar - Theme.Space.s2
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

/// 气泡上方那条引用：点它滚回原消息。
final class QuoteStrip: UIControl {
    private let surface = SurfaceView(.glass, radius: Theme.Radius.row)
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
        row.pin(to: surface.contentView, insets: UIEdgeInsets(top: Theme.Space.s2, left: Theme.Space.s3, bottom: Theme.Space.s2, right: Theme.Space.s3))
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

final class AssistantCell: ChatCell {
    private let bubble = SurfaceView(.strong, radius: Theme.Radius.bubble, lifted: true)
    private let stack = UIStackView()
    private var full: NSLayoutConstraint!
    private var text = ""
    var onLink: ((URL) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        stack.axis = .vertical
        stack.spacing = Theme.Space.s2
        bubble.contentView.addSubview(stack)
        stack.pin(to: bubble.contentView, insets: Bubble.insets)
        place(bubble, alignment: .left)
        full = bubble.widthAnchor.constraint(equalToConstant: 0)
        isAccessibilityElement = true
    }

    required init?(coder: NSCoder) { fatalError() }

    override var bubbleView: UIView? { bubble }

    func configure(text next: String, width: CGFloat) {
        let segments = Markdown.segments(next)
        let inner = width - Bubble.horizontal
        let views = stack.arrangedSubviews
        for (index, segment) in segments.enumerated() {
            let existing = index < views.count ? views[index] : nil
            switch segment {
            case .text(let attributed):
                let label = (existing as? LinkLabel) ?? replace(at: index, with: LinkLabel())
                if text != next || label.attributedText != attributed { label.attributedText = attributed }
                label.preferredMaxLayoutWidth = inner
                label.onLink = { [weak self] url in self?.onLink?(url) }
            case .code(let code):
                let block = (existing as? CodeScrollView) ?? replace(at: index, with: CodeScrollView())
                block.text = code
            }
        }
        for view in stack.arrangedSubviews.dropFirst(segments.count) { view.removeFromSuperview() }
        text = next
        // 有代码块就占满宽度，代码在块里横向滚动。
        full.constant = width
        full.isActive = segments.contains { if case .code = $0 { true } else { false } }
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

/// Pupu 还没出字：三个点依次明暗。
final class TypingCell: ChatCell {
    private let bubble = SurfaceView(.strong, radius: Theme.Radius.bubble, lifted: true)
    private let dots = (0..<3).map { _ in UIView() }
    private let label = UILabel(style: .subheadline, color: Theme.inkMuted)

    override init(frame: CGRect) {
        super.init(frame: frame)
        let row = UIStackView(arrangedSubviews: dots)
        row.spacing = Theme.Space.s1
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

final class TagCell: ChatCell {
    private let button = UIButton(configuration: .plain())
    var onTap: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        var config = UIButton.Configuration.plain()
        config.image = UIImage(systemName: "folder")
        config.imagePadding = Theme.Space.s2
        config.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(textStyle: .footnote)
        config.baseForegroundColor = Theme.ink
        config.titleLineBreakMode = .byTruncatingTail
        config.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: Theme.Space.s3, bottom: 6, trailing: Theme.Space.s3)
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = Theme.font(.footnote)
            return attributes
        }
        var background = UIBackgroundConfiguration.clear()
        background.backgroundColor = Theme.surfaceStrong
        background.visualEffect = UIBlurEffect(style: .systemUltraThinMaterial)
        background.strokeColor = Theme.lineGlass
        background.strokeWidth = 1
        background.cornerRadius = Theme.Radius.tag
        config.background = background
        button.configuration = config
        button.layer.shadowColor = UIColor(red: 15 / 255, green: 23 / 255, blue: 42 / 255, alpha: 1).cgColor
        button.layer.shadowOpacity = 0.06
        button.layer.shadowRadius = 10
        button.layer.shadowOffset = CGSize(width: 0, height: 6)
        button.addAction(UIAction { [weak self] _ in self?.onTap?() }, for: .primaryActionTriggered)
        place(button, alignment: .left, fraction: 0.8)
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(name: String, enabled: Bool) {
        button.configuration?.title = name
        button.isEnabled = enabled
        button.accessibilityLabel = "项目：\(name)"
        button.accessibilityHint = enabled ? "打开这个项目" : nil
    }
}

// MARK: - 电脑上的操作

/// 一步操作，或者合起来的一组。收起时一行，点开看输出。只能看，不能操作。
final class ToolCell: ChatCell {
    private let card = SurfaceView(.strong, radius: Theme.Radius.row)
    private let icon = UIImageView()
    private let title = UILabel(style: .subheadline)
    private let result = UILabel(style: .caption, color: Theme.inkMuted)
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let waiting = WaitingMark()
    private let chevron = UIImageView(image: UIImage(systemName: "chevron.right"))
    private let output = OutputView()
    private let path = UILabel(style: .caption, color: Theme.inkMuted, lines: 0)
    private var width: NSLayoutConstraint!
    var onToggle: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        icon.tintColor = Theme.inkMuted
        icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .subheadline)
        icon.contentMode = .center
        icon.setContentHuggingPriority(.required, for: .horizontal)
        chevron.tintColor = Theme.inkMuted
        chevron.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .caption1)
        chevron.setContentHuggingPriority(.required, for: .horizontal)
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        for view in [result, spinner, waiting] as [UIView] {
            view.setContentHuggingPriority(.required, for: .horizontal)
            view.setContentCompressionResistancePriority(.required, for: .horizontal)
        }
        spinner.hidesWhenStopped = true

        let header = UIStackView(arrangedSubviews: [icon, title, result, spinner, waiting, chevron])
        header.spacing = Theme.Space.s2
        header.alignment = .center
        header.heightAnchor.constraint(greaterThanOrEqualToConstant: 24).isActive = true

        let stack = UIStackView(arrangedSubviews: [header, output, path])
        stack.axis = .vertical
        stack.spacing = Theme.Space.s2
        card.contentView.addSubview(stack)
        stack.pin(to: card.contentView, insets: UIEdgeInsets(top: Theme.Space.s2_5, left: Theme.Space.s3, bottom: Theme.Space.s2_5, right: Theme.Space.s3))
        place(card, alignment: .left)
        width = card.widthAnchor.constraint(equalToConstant: 0)
        width.priority = .defaultHigh
        width.isActive = true

        card.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    required init?(coder: NSCoder) { fatalError() }

    override var bubbleView: UIView? { card }
    override var bubbleRadius: CGFloat { Theme.Radius.row }

    @objc private func tapped() {
        onToggle?()
    }

    func configure(step: ToolStep, width: CGFloat) {
        self.width.constant = width
        icon.image = UIImage(systemName: step.icon)
        title.text = step.title
        show(step.status, failures: step.status == .failed ? 1 : 0)
        let hasOutput = !step.output.isBlank || step.outputPath != nil
        chevron.isHidden = !hasOutput
        chevron.transform = step.expanded ? CGAffineTransform(rotationAngle: .pi / 2) : .identity
        output.isHidden = !(step.expanded && !step.output.isBlank)
        output.configure(step.output, width: width - Theme.Space.s3 * 2)
        path.isHidden = !(step.expanded && step.outputPath != nil)
        path.text = step.outputPath.map { "完整输出：\($0)" }
        path.preferredMaxLayoutWidth = width - Theme.Space.s3 * 2
        accessibilityLabel = "\(step.title)，\(result.text ?? (step.status == .waiting ? "等你批准" : "进行中"))"
        accessibilityValue = hasOutput ? (step.expanded ? "已展开" : "已收起") : nil
    }

    private func show(_ status: ToolStep.Status, failures: Int) {
        let text: String? = switch status {
        case .done: "完成"
        case .failed: failures > 1 ? "\(failures) 件没成" : "失败"
        case .denied: "已拒绝"
        case .expired: "没人批，作废了"
        case .unfinished: "没做完"
        case .running, .waiting: nil
        }
        result.text = text
        result.isHidden = text == nil
        result.textColor = status == .failed ? Theme.dangerInk : Theme.inkMuted
        waiting.isHidden = status != .waiting
        if status == .running { spinner.startAnimating() } else { spinner.stopAnimating() }
    }
}

/// 工具的输出：等宽字、surface-inset 底，最多 12 行，多了在块里滚动。
final class OutputView: UIScrollView {
    private let label = UILabel(style: .code, lines: 0)
    private var height: NSLayoutConstraint!

    init() {
        super.init(frame: .zero)
        backgroundColor = Theme.surfaceInset
        layer.cornerRadius = Theme.Radius.tag
        layer.cornerCurve = .continuous
        label.lineBreakMode = .byCharWrapping
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        let content = contentLayoutGuide
        height = heightAnchor.constraint(equalToConstant: 0)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: Theme.Space.s3),
            label.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -Theme.Space.s3),
            label.topAnchor.constraint(equalTo: content.topAnchor, constant: Theme.Space.s2),
            label.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -Theme.Space.s2),
            label.widthAnchor.constraint(equalTo: frameLayoutGuide.widthAnchor, constant: -Theme.Space.s3 * 2),
            height
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(_ text: String, width: CGFloat) {
        let inner = width - Theme.Space.s3 * 2
        if label.text != text { label.text = text }
        label.preferredMaxLayoutWidth = inner
        let natural = ceil(label.sizeThatFits(CGSize(width: inner, height: .greatestFiniteMagnitude)).height)
        let limit = ceil(Theme.font(.code).lineHeight * 12)
        height.constant = min(natural, limit) + Theme.Space.s2 * 2
        isScrollEnabled = natural > limit
    }
}

// MARK: - 提示和出错

/// 居中的小卡片：「上下文已重置」，或者项目里「从聊天转来」的事。文字不直接压在天空上。
final class NoticeCell: ChatCell {
    private let surface = SurfaceView(.glass, radius: Theme.Radius.row)
    private let heading = UILabel(style: .caption, color: Theme.inkMuted)
    private let label = UILabel(style: .subheadline, lines: 0)

    override init(frame: CGRect) {
        super.init(frame: frame)
        heading.textAlignment = .center
        let stack = UIStackView(arrangedSubviews: [heading, label])
        stack.axis = .vertical
        stack.spacing = 2
        surface.contentView.addSubview(stack)
        stack.pin(to: surface.contentView, insets: UIEdgeInsets(top: Theme.Space.s2, left: Theme.Space.s3, bottom: Theme.Space.s2, right: Theme.Space.s3))
        place(surface, alignment: .center)
        isAccessibilityElement = true
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(heading text: String?, body: String, width: CGFloat) {
        heading.text = text
        heading.isHidden = text == nil
        label.text = body
        label.font = Theme.font(text == nil ? .caption : .subheadline)
        label.textColor = text == nil ? Theme.inkMuted : Theme.ink
        label.textAlignment = text == nil ? .center : .natural
        label.preferredMaxLayoutWidth = width - Theme.Space.s3 * 2
        accessibilityLabel = [text, body].compactMap { $0 }.joined(separator: "：")
    }
}

/// 对话里的出错提示：跟在出事的那一步后面，靠左。
final class ErrorCell: ChatCell {
    private let surface = SurfaceView(.strong, radius: Theme.Radius.row)
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
