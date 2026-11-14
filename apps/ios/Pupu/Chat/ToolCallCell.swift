import UIKit

/// 只跑命令、读写文件的那几步（规范 ToolCallCard）：`surface-inset` 底、`radius-row`，占满内容列，不加阴影。
/// 一步一张「在「mbpro」上跑了 npm test」，有输出的点开看；连着几步合成一组「在「mbpro」上做了 3 件事」，点开再看每一件。
/// 失败的默认展开。只能看，停止在输入栏。用过屏幕的那几步画成 ComputerCardCell。和网页 Chat.tsx 的 ToolCallCard 一起改。
final class ToolCallCell: ChatCell {
    private let card = SurfaceView(.inset, radius: Theme.Radius.row)
    /// 一步时是那一步，几步时是「做了 N 件事」那一行。
    private let head = ToolHeadView(nested: false)
    private let output = ToolOutputView(fill: Theme.surface, insets: UIEdgeInsets(top: 0, left: Theme.Space.s3, bottom: Theme.Space.s3, right: Theme.Space.s3), pathPrefix: "完整输出：")
    /// 组展开后的每一件。
    private let list = UIStackView()
    private var items: [(head: ToolHeadView, output: ToolOutputView)] = []
    /// 点了哪一行：一步是 `tool:<callId>`，一组是卡片的 id。
    var onToggle: ((String) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        list.axis = .vertical
        list.isLayoutMarginsRelativeArrangement = true
        list.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 0, leading: 0, bottom: Theme.Space.s1, trailing: 0)
        let stack = UIStackView(arrangedSubviews: [head, output, list])
        stack.axis = .vertical
        card.contentView.addSubview(stack)
        stack.pin(to: card.contentView)
        place(card, alignment: .left, fraction: 1)
        card.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true
    }

    required init?(coder: NSCoder) { fatalError() }

    override var bubbleView: UIView? { card }
    override var bubbleRadius: CGFloat { Theme.Radius.row }

    /// 卡片里的几步。width 是整列的宽。
    func configure(task: ComputerTask, width: CGFloat) {
        if task.steps.count == 1, let step = task.steps.first {
            configure(step: step, width: width)
            return
        }
        let place = task.computer.map { "在「\($0)」上" } ?? "在电脑上"
        head.configure(
            icon: "terminal",
            title: "\(place)做了 \(task.steps.count) 件事",
            result: .group(task),
            expanded: task.expanded,
            toggles: true
        )
        head.onTap = { [weak self] in self?.onToggle?(task.id) }
        output.isHidden = true
        list.isHidden = !task.expanded
        guard task.expanded else { return }
        while items.count < task.steps.count {
            let item = (head: ToolHeadView(nested: true), output: ToolOutputView(fill: Theme.surface, insets: UIEdgeInsets(top: 0, left: Theme.Space.s3, bottom: Theme.Space.s3, right: Theme.Space.s3), pathPrefix: "完整输出："))
            list.addArrangedSubview(item.head)
            list.addArrangedSubview(item.output)
            items.append(item)
        }
        for (index, item) in items.enumerated() {
            guard index < task.steps.count else {
                item.head.isHidden = true
                item.output.isHidden = true
                continue
            }
            let step = task.steps[index]
            item.head.isHidden = false
            show(step, title: ChatRows.stepText(step), head: item.head, output: item.output, width: width)
        }
    }

    /// 单独的一步：合卡片之前的兜底，和只有一步的卡片。
    func configure(step: ToolStep, width: CGFloat) {
        list.isHidden = true
        show(step, title: step.title, head: head, output: output, width: width)
    }

    private func show(_ step: ToolStep, title: String, head: ToolHeadView, output: ToolOutputView, width: CGFloat) {
        let hasOutput = !step.output.isBlank || step.outputPath != nil
        head.configure(icon: step.icon, title: title, result: .step(step.status), expanded: step.expanded, toggles: hasOutput)
        let id = "tool:\(step.callId)"
        head.onTap = hasOutput ? { [weak self] in self?.onToggle?(id) } : nil
        output.isHidden = !(step.expanded && hasOutput)
        if !output.isHidden { output.configure(step.output, path: step.outputPath, width: width) }
    }
}

/// 工具卡片的一行：动作图标（`ink-muted`）、一句话（`subheadline`，截成一行）、结果、`chevron.right`（`ink-faint`，展开时转 90°）。
/// 有输出才能点。
final class ToolHeadView: UIControl {
    enum Result {
        /// 一步的结果：成功不写字，失败 `danger-ink`，等批是 warning 小胶囊，进行中是小转圈。
        case step(ToolStep.Status)
        /// 一组的结果：还在做是转圈，等批是小胶囊，有没成的写几件没成。
        case group(ComputerTask)
    }

    private let icon = UIImageView()
    private let title = UILabel(style: .subheadline)
    private let result = UILabel(style: .caption, color: Theme.inkMuted)
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let waiting = WaitingMark()
    private let chevron = UIImageView(image: UIImage(systemName: "chevron.right"))
    var onTap: (() -> Void)?

    init(nested: Bool) {
        super.init(frame: .zero)
        icon.tintColor = Theme.inkMuted
        icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .body)
        icon.contentMode = .center
        chevron.tintColor = Theme.inkFaint
        chevron.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .footnote, scale: .medium)
        chevron.contentMode = .center
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        title.setContentHuggingPriority(.defaultLow, for: .horizontal)
        for view in [icon, result, spinner, waiting, chevron] as [UIView] {
            view.setContentHuggingPriority(.required, for: .horizontal)
            view.setContentCompressionResistancePriority(.required, for: .horizontal)
        }
        spinner.hidesWhenStopped = true
        let row = UIStackView(arrangedSubviews: [icon, title, result, spinner, waiting, chevron])
        row.spacing = Theme.Space.s2
        row.alignment = .center
        row.isUserInteractionEnabled = false
        addSubview(row)
        let vertical = nested ? Theme.Space.s2 : Theme.Space.s3
        row.pin(to: self, insets: UIEdgeInsets(top: vertical, left: Theme.Space.s4, bottom: vertical, right: Theme.Space.s3))
        NSLayoutConstraint.activate([
            icon.widthAnchor.constraint(equalToConstant: 22),
            chevron.widthAnchor.constraint(equalToConstant: 14)
        ])
        addAction(UIAction { [weak self] _ in self?.onTap?() }, for: .primaryActionTriggered)
        isAccessibilityElement = true
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(icon name: String, title text: String, result kind: Result, expanded: Bool, toggles: Bool) {
        icon.image = UIImage(systemName: name)
        title.text = text
        var note: String?
        var failed = false
        var live = false
        var waits = false
        switch kind {
        case .step(let status):
            live = status == .running
            waits = status == .waiting
            note = waits ? nil : status.note
            failed = status == .failed
        case .group(let task):
            live = task.state == .live
            waits = task.state == .waiting
            note = live || waits || task.status.isEmpty ? nil : task.status
            failed = task.steps.contains { $0.status == .failed }
        }
        result.text = note
        result.isHidden = note == nil
        result.textColor = failed ? Theme.dangerInk : Theme.inkMuted
        waiting.isHidden = !waits
        if live { spinner.startAnimating() } else { spinner.stopAnimating() }
        chevron.isHidden = !toggles
        chevron.transform = expanded ? CGAffineTransform(rotationAngle: .pi / 2) : .identity
        isEnabled = toggles
        accessibilityTraits = toggles ? .button : .staticText
        accessibilityLabel = [text, note ?? (waits ? "等你批准" : live ? "在做" : nil)].compactMap { $0 }.joined(separator: "，")
        accessibilityValue = toggles ? (expanded ? "已展开" : "已收起") : nil
    }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.6 : 1 }
    }
}

/// 展开后的输出：`code` 字，最多 12 行，超出在块里滚；最后一行 `caption` 写完整输出在哪。
/// 工具卡片里嵌在 `surface-inset` 上，底用 `surface`；电脑卡不填底，底用 `surface-inset`。
final class ToolOutputView: UIView {
    private let block = UIScrollView()
    private let label = UILabel(style: .code, lines: 0)
    private let path = UILabel(style: .caption, color: Theme.inkMuted, lines: 0)
    private let insets: UIEdgeInsets
    private let pathPrefix: String
    private var height: NSLayoutConstraint!

    init(fill: UIColor, insets: UIEdgeInsets, pathPrefix: String) {
        self.insets = insets
        self.pathPrefix = pathPrefix
        super.init(frame: .zero)
        block.backgroundColor = fill
        block.layer.cornerRadius = Theme.Radius.tag
        block.layer.cornerCurve = .continuous
        label.lineBreakMode = .byCharWrapping
        label.translatesAutoresizingMaskIntoConstraints = false
        block.addSubview(label)
        let content = block.contentLayoutGuide
        height = block.heightAnchor.constraint(equalToConstant: 0)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: Theme.Space.s3),
            label.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -Theme.Space.s3),
            label.topAnchor.constraint(equalTo: content.topAnchor, constant: Theme.Space.s2),
            label.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -Theme.Space.s2),
            label.widthAnchor.constraint(equalTo: block.frameLayoutGuide.widthAnchor, constant: -Theme.Space.s3 * 2),
            height
        ])
        let stack = UIStackView(arrangedSubviews: [block, path])
        stack.axis = .vertical
        stack.spacing = Theme.Space.s2
        addSubview(stack)
        stack.pin(to: self, insets: insets)
    }

    required init?(coder: NSCoder) { fatalError() }

    /// width 是这一块自己的宽（含左右留白）。
    func configure(_ text: String, path file: String?, width: CGFloat) {
        let outer = width - insets.left - insets.right
        let inner = outer - Theme.Space.s3 * 2
        block.isHidden = text.isBlank
        if label.text != text { label.text = text }
        label.preferredMaxLayoutWidth = inner
        let natural = ceil(label.sizeThatFits(CGSize(width: inner, height: .greatestFiniteMagnitude)).height)
        let limit = ceil(Theme.font(.code).lineHeight * 12)
        height.constant = min(natural, limit) + Theme.Space.s2 * 2
        block.isScrollEnabled = natural > limit
        path.isHidden = file == nil
        if let file {
            let attributed = NSMutableAttributedString(string: pathPrefix, attributes: [.font: Theme.font(.caption), .foregroundColor: Theme.inkMuted])
            let mono = UIFontMetrics(forTextStyle: .caption1).scaledFont(for: .monospacedSystemFont(ofSize: 12, weight: .regular))
            attributed.append(NSAttributedString(string: file, attributes: [.font: mono, .foregroundColor: Theme.inkMuted]))
            path.attributedText = attributed
        }
        path.preferredMaxLayoutWidth = outer
    }
}

extension ToolStep.Status {
    /// 一步后面那一行小字。做完了和正在做靠转圈和勾说明，不写字。和网页 STEP_NOTES 一样。
    var note: String? {
        switch self {
        case .running, .done: nil
        case .waiting: "等你批准"
        case .failed: "失败"
        case .denied: "已拒绝"
        case .expired: "没人批，作废了"
        case .unfinished: "没做完"
        }
    }
}
