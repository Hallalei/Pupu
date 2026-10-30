import UIKit

/// 屏幕底部的输入栏：Liquid Glass 胶囊，回车换行，发送只靠按钮。
/// Pupu 在回复、输入框又是空的时候，按钮换成停止；这时再发的消息排在这一轮后面。
final class ComposerView: UIView, UITextViewDelegate {
    static let minHeight = Theme.Size.control
    static let maxHeight: CGFloat = 160

    var onSend: ((String) -> Void)?
    var onStop: (() -> Void)?
    /// 高度变了，控制器要跟着动画并改列表的底部留白。
    var onResize: (() -> Void)?

    var placeholder = "" {
        didSet {
            placeholderLabel.text = placeholder
            textView.accessibilityLabel = placeholder
        }
    }

    var running = false {
        didSet { if running != oldValue { update() } }
    }

    var connected = false {
        didSet { if connected != oldValue { update() } }
    }

    var text: String { textView.text }

    let textView = UITextView()
    private let placeholderLabel = UILabel(style: .body, color: Theme.inkMuted)
    private let button = UIButton(configuration: .prominentGlass())
    private var height: NSLayoutConstraint!
    private static let inset = (minHeight - Theme.font(.body).lineHeight) / 2

    init() {
        super.init(frame: .zero)
        let glass = GlassView(radius: Theme.Radius.composer)
        addSubview(glass)
        glass.pin(to: self)

        textView.font = Theme.font(.body)
        textView.adjustsFontForContentSizeCategory = true
        textView.textColor = Theme.ink
        textView.tintColor = Theme.ink
        textView.backgroundColor = .clear
        textView.isScrollEnabled = false
        textView.textContainerInset = UIEdgeInsets(top: Self.inset, left: 0, bottom: Self.inset, right: 0)
        textView.textContainer.lineFragmentPadding = 0
        textView.delegate = self
        textView.translatesAutoresizingMaskIntoConstraints = false
        placeholderLabel.translatesAutoresizingMaskIntoConstraints = false
        placeholderLabel.isAccessibilityElement = false

        var config = UIButton.Configuration.prominentGlass()
        config.baseForegroundColor = Theme.onAction
        config.cornerStyle = .capsule
        config.contentInsets = .zero
        config.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)
        button.configuration = config
        button.tintColor = Theme.action
        button.translatesAutoresizingMaskIntoConstraints = false
        button.addAction(UIAction { [weak self] _ in self?.pressed() }, for: .primaryActionTriggered)

        let content = glass.contentView
        content.addSubview(textView)
        content.addSubview(placeholderLabel)
        content.addSubview(button)
        height = heightAnchor.constraint(equalToConstant: Self.minHeight)
        let margin = (Self.minHeight - Theme.Size.controlSmall) / 2
        NSLayoutConstraint.activate([
            height,
            textView.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: Theme.Space.s4),
            textView.topAnchor.constraint(equalTo: content.topAnchor),
            textView.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            textView.trailingAnchor.constraint(equalTo: button.leadingAnchor, constant: -Theme.Space.s2),
            placeholderLabel.leadingAnchor.constraint(equalTo: textView.leadingAnchor),
            placeholderLabel.trailingAnchor.constraint(lessThanOrEqualTo: textView.trailingAnchor),
            placeholderLabel.topAnchor.constraint(equalTo: textView.topAnchor, constant: Self.inset),
            button.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -6),
            button.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -margin),
            button.widthAnchor.constraint(equalToConstant: Theme.Size.controlSmall),
            button.heightAnchor.constraint(equalToConstant: Theme.Size.controlSmall)
        ])
        update()
    }

    required init?(coder: NSCoder) { fatalError() }

    func clear() {
        textView.text = ""
        update()
        resize()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        resize()
    }

    func textViewDidChange(_ textView: UITextView) {
        update()
        resize()
    }

    private func pressed() {
        if running && text.isBlank {
            onStop?()
        } else {
            onSend?(text)
        }
    }

    private func update() {
        placeholderLabel.isHidden = !textView.text.isEmpty
        let stop = running && text.isBlank
        button.configuration?.image = UIImage(systemName: stop ? "stop.fill" : "arrow.up")
        let enabled = connected && (stop || !text.isBlank)
        button.isEnabled = enabled
        button.alpha = enabled ? 1 : 0.3
        button.accessibilityLabel = stop ? "停止" : running ? "排队发送" : "发送"
    }

    /// 最多长到 160pt，大约 6 行，再多就在框里滚动。
    private func resize() {
        let width = textView.bounds.width
        guard width > 0 else { return }
        let natural = ceil(textView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height)
        let target = min(max(natural, Self.minHeight), Self.maxHeight)
        let scrolls = natural > Self.maxHeight
        if textView.isScrollEnabled != scrolls { textView.isScrollEnabled = scrolls }
        guard abs(height.constant - target) > 0.5 else { return }
        height.constant = target
        onResize?()
    }
}

/// 引用回复时输入栏上方的那条：被引用的内容放在气泡里，最多 4 行，右边一个玻璃圆按钮取消。
final class QuotePreview: UIView {
    var onCancel: (() -> Void)?
    private let bubble = SurfaceView(.strong, radius: Theme.Radius.bubble, lifted: true)
    private let label = UILabel(style: .message, lines: 4)

    init() {
        super.init(frame: .zero)
        label.lineBreakMode = .byTruncatingTail
        bubble.contentView.addSubview(label)
        label.pin(to: bubble.contentView, insets: Bubble.insets)

        let close = UIButton.glass(image: "xmark")
        close.configuration?.cornerStyle = .capsule
        close.configuration?.contentInsets = .zero
        close.accessibilityLabel = "取消回复"
        close.addAction(UIAction { [weak self] _ in self?.onCancel?() }, for: .primaryActionTriggered)

        let row = UIStackView(arrangedSubviews: [bubble, close])
        row.spacing = Theme.Space.s2
        row.alignment = .top
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
            bubble.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, multiplier: Theme.Size.bubbleMax),
            close.widthAnchor.constraint(equalToConstant: Theme.Size.controlSmall),
            close.heightAnchor.constraint(equalToConstant: Theme.Size.controlSmall)
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(_ text: String, width: CGFloat) {
        let attributed = NSMutableAttributedString(string: text, attributes: Theme.messageAttributes())
        // 截断要写在段落样式里，否则 attributedText 会盖掉 lineBreakMode。
        if let paragraph = Theme.messageParagraph().mutableCopy() as? NSMutableParagraphStyle {
            paragraph.lineBreakMode = .byTruncatingTail
            attributed.addAttribute(.paragraphStyle, value: paragraph, range: NSRange(location: 0, length: attributed.length))
        }
        label.attributedText = attributed
        label.preferredMaxLayoutWidth = width - Bubble.horizontal
        label.accessibilityLabel = "回复：\(text)"
    }
}

/// 开场建议这类胶囊：一行放不下就换行，每行居中。
final class FlowView: UIView {
    var spacing: CGFloat = Theme.Space.s2
    private var items: [UIView] = []

    /// 控制器在布局时告诉它可用宽度，它据此算出自己的高度。
    var preferredWidth: CGFloat = 0 {
        didSet {
            if preferredWidth != oldValue {
                invalidateIntrinsicContentSize()
                setNeedsLayout()
            }
        }
    }

    func setItems(_ views: [UIView]) {
        items.forEach { $0.removeFromSuperview() }
        items = views
        views.forEach(addSubview)
        invalidateIntrinsicContentSize()
    }

    override var intrinsicContentSize: CGSize {
        CGSize(width: preferredWidth, height: frames(for: preferredWidth).last?.maxY ?? 0)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        for (view, frame) in zip(items, frames(for: bounds.width)) { view.frame = frame }
    }

    private func frames(for width: CGFloat) -> [CGRect] {
        guard width > 0 else { return [] }
        var rows: [[CGSize]] = [[]]
        var used: CGFloat = 0
        for view in items {
            var size = view.systemLayoutSizeFitting(UIView.layoutFittingCompressedSize)
            size.width = min(size.width, width)
            let needed = rows[rows.count - 1].isEmpty ? size.width : used + spacing + size.width
            if needed > width && !rows[rows.count - 1].isEmpty {
                rows.append([size])
                used = size.width
            } else {
                rows[rows.count - 1].append(size)
                used = needed
            }
        }
        var frames: [CGRect] = []
        var y: CGFloat = 0
        for row in rows where !row.isEmpty {
            let total = row.map(\.width).reduce(0, +) + spacing * CGFloat(row.count - 1)
            let height = row.map(\.height).max() ?? 0
            var x = (width - total) / 2
            for size in row {
                frames.append(CGRect(x: x, y: y + (height - size.height) / 2, width: size.width, height: size.height))
                x += size.width + spacing
            }
            y += height + spacing
        }
        return frames
    }
}
