import UIKit

/// 电脑卡片（规范 ComputerCard）：Pupu 用某台电脑的屏幕时的那张卡。头一行写在哪台电脑上和状态，
/// 带回过截图就显示最近的画面，底一行是最新一步、「步骤」和「接手」；「步骤」展开后每一步列在卡片里（StepLine）。
/// 1pt `line` 外框、圆角 `radius-row` 加 2，不填底、不加阴影。网页 Chat.tsx 里的 ComputerCard 是同一个样子，两边一起改。
final class ComputerCardCell: ChatCell {
    private let card = OutlineView(radius: Theme.Radius.row + 2)
    private let icon = UIImageView(image: UIImage(systemName: "desktopcomputer"))
    private let title = UILabel(style: .subheadline)
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let status = UILabel(style: .footnote, color: Theme.inkMuted)
    private let waiting = WaitingMark()
    private let screenBox = UIView()
    private let screen = TopFillImageView(frame: .zero)
    private let latest = UILabel(style: .footnote, color: Theme.inkMuted)
    private let stepsButton = ComputerCardCell.pill(title: "步骤", image: "chevron.down")
    private let takeOverButton = ComputerCardCell.pill(title: "接手", image: nil)
    private let list = UIStackView()
    private var lines: [StepLineView] = []
    private var width: NSLayoutConstraint!
    /// 解码过的截图，按 base64 记着，滚动时不重复解码。
    private var decoded: (data: String, image: UIImage?)?

    /// 点了哪一个：「步骤」是卡片的 id，展开的一步是 `tool:<callId>`。
    var onToggle: ((String) -> Void)?
    /// 打开这台电脑的远程桌面。nil 时不放「接手」：不是自己名下的电脑，或者不在线。
    var onTakeOver: (() -> Void)? {
        didSet { takeOverButton.isHidden = onTakeOver == nil }
    }
    private var taskId = ""

    override init(frame: CGRect) {
        super.init(frame: frame)
        icon.tintColor = Theme.ink
        icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .body)
        icon.setContentHuggingPriority(.required, for: .horizontal)
        title.font = Theme.font(.subheadline, weight: .semibold)
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        title.setContentHuggingPriority(.defaultLow, for: .horizontal)
        for view in [spinner, status, waiting] as [UIView] {
            view.setContentHuggingPriority(.required, for: .horizontal)
            view.setContentCompressionResistancePriority(.required, for: .horizontal)
        }
        spinner.hidesWhenStopped = true
        let header = UIStackView(arrangedSubviews: [icon, title, spinner, status, waiting])
        header.spacing = Theme.Space.s2
        header.alignment = .center
        header.setCustomSpacing(6, after: spinner)
        header.isLayoutMarginsRelativeArrangement = true
        header.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 11, leading: 14, bottom: 9, trailing: 14)

        // 截图：高 140（规范 132 到 150），圆角 radius-row 减 4，内描 1pt line，从上往下铺满。
        screen.backgroundColor = Theme.surfaceInset
        screen.layer.cornerRadius = Theme.Radius.row - 4
        screen.layer.cornerCurve = .continuous
        screen.clipsToBounds = true
        screen.isAccessibilityElement = true
        let ring = OutlineView(radius: Theme.Radius.row - 4)
        ring.isUserInteractionEnabled = false
        screenBox.addSubview(screen)
        screenBox.addSubview(ring)
        screen.pin(to: screenBox, insets: UIEdgeInsets(top: 0, left: 14, bottom: 0, right: 14))
        ring.pin(to: screenBox, insets: UIEdgeInsets(top: 0, left: 14, bottom: 0, right: 14))
        screen.heightAnchor.constraint(equalToConstant: 140).isActive = true

        latest.lineBreakMode = .byTruncatingTail
        latest.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        latest.setContentHuggingPriority(.defaultLow, for: .horizontal)
        stepsButton.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.onToggle?(self.taskId)
        }, for: .primaryActionTriggered)
        takeOverButton.addAction(UIAction { [weak self] _ in self?.onTakeOver?() }, for: .primaryActionTriggered)
        takeOverButton.isHidden = true
        let footer = UIStackView(arrangedSubviews: [latest, stepsButton, takeOverButton])
        footer.spacing = Theme.Space.s2
        footer.alignment = .center
        footer.isLayoutMarginsRelativeArrangement = true
        footer.directionalLayoutMargins = NSDirectionalEdgeInsets(top: Theme.Space.s2_5, leading: 14, bottom: Theme.Space.s3, trailing: Theme.Space.s2_5)

        list.axis = .vertical
        list.spacing = 2
        list.isLayoutMarginsRelativeArrangement = true
        list.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 0, leading: Theme.Space.s2, bottom: Theme.Space.s2_5, trailing: Theme.Space.s2)

        let stack = UIStackView(arrangedSubviews: [header, screenBox, footer, list])
        stack.axis = .vertical
        card.addSubview(stack)
        stack.pin(to: card)
        place(card, alignment: .left, fraction: 1)
        width = card.widthAnchor.constraint(equalToConstant: 300)
        width.priority = .defaultHigh
        width.isActive = true
    }

    required init?(coder: NSCoder) { fatalError() }

    override var bubbleView: UIView? { card }
    override var bubbleRadius: CGFloat { Theme.Radius.row + 2 }

    /// width 是整列的宽，卡片最宽 420。
    func configure(task: ComputerTask, width column: CGFloat) {
        taskId = task.id
        let boxWidth = min(column, 420)
        width.constant = boxWidth
        title.text = task.computer.map { "在「\($0)」上" } ?? "在电脑上"

        let active = task.state == .live || task.state == .waiting
        if task.state == .live { spinner.startAnimating() } else { spinner.stopAnimating() }
        waiting.isHidden = task.state != .waiting
        status.isHidden = task.state == .waiting
        status.text = task.status
        status.textColor = task.state == .failed ? Theme.dangerInk : Theme.inkMuted

        let image = task.screen.flatMap(decode)
        screenBox.isHidden = image == nil
        screen.image = image
        screen.alpha = active ? 1 : 0.9
        screen.accessibilityLabel = "「\(task.computer ?? "电脑")」上的画面"

        latest.text = task.latest
        var config = stepsButton.configuration
        config?.image = UIImage(systemName: task.expanded ? "chevron.up" : "chevron.down")
        stepsButton.configuration = config
        stepsButton.accessibilityValue = task.expanded ? "已展开" : "已收起"

        list.isHidden = !task.expanded
        if task.expanded {
            while lines.count < task.steps.count {
                let line = StepLineView()
                list.addArrangedSubview(line)
                lines.append(line)
            }
            for (index, line) in lines.enumerated() {
                line.isHidden = index >= task.steps.count
                guard index < task.steps.count else { continue }
                let step = task.steps[index]
                let id = "tool:\(step.callId)"
                line.configure(step, width: boxWidth - Theme.Space.s2 * 2)
                line.onTap = { [weak self] in self?.onToggle?(id) }
            }
        }

        card.isAccessibilityElement = false
        title.accessibilityLabel = "\(title.text ?? "")，\(task.status)"
    }

    private func decode(_ image: StepImage) -> UIImage? {
        if let decoded, decoded.data == image.data { return decoded.image }
        let result = Data(base64Encoded: image.data).flatMap { UIImage(data: $0) }
        decoded = (image.data, result)
        return result
    }

    /// 卡片底行的「步骤」「接手」：`surface-inset` 胶囊，高 32，字 14 加粗。规范说它们是次要按钮。
    static func pill(title: String, image: String?) -> UIButton {
        var config = UIButton.Configuration.filled()
        config.title = title
        config.image = image.flatMap { UIImage(systemName: $0) }
        config.imagePlacement = .trailing
        config.imagePadding = Theme.Space.s1
        config.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 11, weight: .semibold)
        config.baseBackgroundColor = Theme.surfaceInset
        config.baseForegroundColor = Theme.ink
        config.cornerStyle = .capsule
        config.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 13, bottom: 0, trailing: 13)
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = UIFontMetrics(forTextStyle: .subheadline).scaledFont(for: .systemFont(ofSize: 14, weight: .semibold))
            return attributes
        }
        let button = UIButton(configuration: config)
        button.setContentHuggingPriority(.required, for: .horizontal)
        button.setContentCompressionResistancePriority(.required, for: .horizontal)
        button.heightAnchor.constraint(greaterThanOrEqualToConstant: 32).isActive = true
        return button
    }
}

/// 电脑卡里的一步（规范 StepLine）：左边记号，`subheadline` 的一句话，下一行 `caption` 写时间，没做成的跟上原因；有输出的点开看。
final class StepLineView: UIControl {
    private let mark = UIView()
    private let check = UIImageView(image: UIImage(systemName: "checkmark"))
    private let cross = UIImageView(image: UIImage(systemName: "xmark"))
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let dot = UIView()
    private let text = UILabel(style: .subheadline, lines: 0)
    private let note = UILabel(style: .caption, color: Theme.inkMuted)
    private let output = ToolOutputView(fill: Theme.surfaceInset, insets: UIEdgeInsets(top: 2, left: 6, bottom: Theme.Space.s1, right: 6), pathPrefix: "完整输出在 ")
    var onTap: (() -> Void)?

    init() {
        super.init(frame: .zero)
        check.tintColor = Theme.online
        check.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .footnote, scale: .medium)
        cross.tintColor = Theme.dangerInk
        cross.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .caption1, scale: .small)
        spinner.hidesWhenStopped = true
        spinner.transform = CGAffineTransform(scaleX: 0.7, y: 0.7)
        dot.layer.cornerRadius = 4
        for view in [check, cross, spinner, dot] as [UIView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            mark.addSubview(view)
            NSLayoutConstraint.activate([
                view.centerXAnchor.constraint(equalTo: mark.centerXAnchor),
                view.centerYAnchor.constraint(equalTo: mark.centerYAnchor)
            ])
        }
        mark.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            mark.widthAnchor.constraint(equalToConstant: 16),
            mark.heightAnchor.constraint(equalToConstant: Theme.font(.subheadline).lineHeight),
            dot.widthAnchor.constraint(equalToConstant: 8),
            dot.heightAnchor.constraint(equalToConstant: 8)
        ])
        let words = UIStackView(arrangedSubviews: [text, note])
        words.axis = .vertical
        let row = UIStackView(arrangedSubviews: [mark, words])
        row.spacing = Theme.Space.s2_5
        row.alignment = .top
        row.isLayoutMarginsRelativeArrangement = true
        row.directionalLayoutMargins = NSDirectionalEdgeInsets(top: Theme.Space.s1, leading: 6, bottom: Theme.Space.s1, trailing: 6)
        let stack = UIStackView(arrangedSubviews: [row, output])
        stack.axis = .vertical
        stack.isUserInteractionEnabled = false
        addSubview(stack)
        stack.pin(to: self)
        addAction(UIAction { [weak self] _ in self?.onTap?() }, for: .primaryActionTriggered)
        isAccessibilityElement = true
    }

    required init?(coder: NSCoder) { fatalError() }

    /// width 是这一行的宽。
    func configure(_ step: ToolStep, width: CGFloat) {
        check.isHidden = step.status != .done
        cross.isHidden = step.status != .failed
        if step.status == .running { spinner.startAnimating() } else { spinner.stopAnimating() }
        let dotted = [.waiting, .denied, .expired, .unfinished].contains(step.status)
        dot.isHidden = !dotted
        dot.backgroundColor = step.status == .waiting ? Theme.warning : Theme.offline

        let line = ChatRows.stepText(step)
        text.text = line
        text.preferredMaxLayoutWidth = width - 12 - 16 - Theme.Space.s2_5
        let time = step.at > 0 ? ChatRows.clockTime(step.at) : nil
        let reason = step.status.note
        let caption = NSMutableAttributedString()
        if let time { caption.append(NSAttributedString(string: time)) }
        if time != nil, reason != nil { caption.append(NSAttributedString(string: " · ")) }
        if let reason {
            caption.append(NSAttributedString(string: reason, attributes: step.status == .failed ? [.foregroundColor: Theme.dangerInk] : [:]))
        }
        note.attributedText = caption
        note.isHidden = caption.length == 0

        let hasOutput = !step.output.isBlank || step.outputPath != nil
        isEnabled = hasOutput
        output.isHidden = !(step.expanded && hasOutput)
        if !output.isHidden { output.configure(step.output, path: step.outputPath, width: width) }
        accessibilityTraits = hasOutput ? .button : .staticText
        accessibilityLabel = [line, time, reason].compactMap { $0 }.joined(separator: "，")
        accessibilityValue = hasOutput ? (step.expanded ? "已展开" : "已收起") : nil
    }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.6 : 1 }
    }
}

/// 截图按「铺满、贴上沿」显示：和网页的 `object-cover object-top` 一样，竖着多出来的裁掉下面。
final class TopFillImageView: UIImageView {
    override var image: UIImage? {
        didSet { setNeedsLayout() }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        contentMode = .scaleToFill
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let image, image.size.width > 0, image.size.height > 0, bounds.width > 0, bounds.height > 0 else {
            layer.contentsRect = CGRect(x: 0, y: 0, width: 1, height: 1)
            return
        }
        let imageRatio = image.size.height / image.size.width
        let boxRatio = bounds.height / bounds.width
        if imageRatio > boxRatio {
            // 图比框高：横向铺满，只露出上面那一截。
            layer.contentsRect = CGRect(x: 0, y: 0, width: 1, height: boxRatio / imageRatio)
        } else {
            // 图比框宽：竖向铺满，左右各裁一点。
            let visible = imageRatio / boxRatio
            layer.contentsRect = CGRect(x: (1 - visible) / 2, y: 0, width: visible, height: 1)
        }
    }
}
