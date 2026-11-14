import UIKit

/// Pupu 在空间里派出去的几件事（规范 TaskList），列成一块挂在它的回复下面。
/// 1pt `line` 外框、`radius-row`，不填底、不加阴影；每行高 44，左右 14：状态圆点 8、名字（`subheadline`，截成一行）、
/// 状态词（`footnote`、`ink-muted`）、`chevron.right`（`ink-faint`），行之间 1pt `line`。点一行整页推进子会话。
/// 和网页 Spaces.tsx 的 TaskList 一起改。
final class TaskListCell: ChatCell {
    private let box = OutlineView(radius: Theme.Radius.row)
    private let stack = UIStackView()
    private var rows: [TaskRowView] = []
    private var width: NSLayoutConstraint!
    var onOpen: ((String) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        box.clipsToBounds = true
        stack.axis = .vertical
        box.addSubview(stack)
        stack.pin(to: box)
        place(box, alignment: .left, fraction: 1)
        width = box.widthAnchor.constraint(equalToConstant: 0)
        width.priority = .defaultHigh
        width.isActive = true
    }

    required init?(coder: NSCoder) { fatalError() }

    override var bubbleView: UIView? { box }
    override var bubbleRadius: CGFloat { Theme.Radius.row }

    /// width 是整列的宽，这一块最宽 480，和网页一样。
    func configure(tasks: [SpaceTask], width column: CGFloat) {
        width.constant = min(column, 480)
        while rows.count < tasks.count {
            let row = TaskRowView()
            stack.addArrangedSubview(row)
            rows.append(row)
        }
        for (index, row) in rows.enumerated() {
            row.isHidden = index >= tasks.count
            guard index < tasks.count else { continue }
            let task = tasks[index]
            row.configure(task, first: index == 0)
            row.onTap = task.session.isEmpty ? nil : { [weak self] in self?.onOpen?(task.session) }
        }
    }
}

/// TaskList 的一行。还没派出去（没有子会话）时是灰点和「正在派」，点不了。
private final class TaskRowView: TapControl {
    private let rule = UIView()
    private let mark = UIView()
    private let check = UIImageView(image: UIImage(systemName: "checkmark"))
    private var dot: UIView?
    private let name = UILabel(style: .subheadline)
    private let status = UILabel(style: .footnote, color: Theme.inkMuted)
    var onTap: (() -> Void)?

    init() {
        super.init(frame: .zero)
        rule.backgroundColor = Theme.line
        rule.translatesAutoresizingMaskIntoConstraints = false
        addSubview(rule)
        check.tintColor = Theme.online
        check.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .caption1, scale: .medium)
        check.translatesAutoresizingMaskIntoConstraints = false
        mark.addSubview(check)
        mark.translatesAutoresizingMaskIntoConstraints = false
        name.lineBreakMode = .byTruncatingTail
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        name.setContentHuggingPriority(.defaultLow, for: .horizontal)
        status.setContentCompressionResistancePriority(.required, for: .horizontal)
        status.setContentHuggingPriority(.required, for: .horizontal)
        let chevron = UIImageView(image: UIImage(systemName: "chevron.right"))
        chevron.tintColor = Theme.inkFaint
        chevron.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .footnote, scale: .medium)
        chevron.setContentHuggingPriority(.required, for: .horizontal)
        let row = UIStackView(arrangedSubviews: [mark, name, status, chevron])
        row.spacing = Theme.Space.s2_5
        row.alignment = .center
        row.isUserInteractionEnabled = false
        addSubview(row)
        row.pin(to: self, insets: UIEdgeInsets(top: 0, left: 14, bottom: 0, right: 14))
        NSLayoutConstraint.activate([
            heightAnchor.constraint(greaterThanOrEqualToConstant: Theme.Size.control),
            rule.topAnchor.constraint(equalTo: topAnchor),
            rule.leadingAnchor.constraint(equalTo: leadingAnchor),
            rule.trailingAnchor.constraint(equalTo: trailingAnchor),
            rule.heightAnchor.constraint(equalToConstant: 1),
            mark.widthAnchor.constraint(equalToConstant: 12),
            mark.heightAnchor.constraint(equalToConstant: 12),
            check.centerXAnchor.constraint(equalTo: mark.centerXAnchor),
            check.centerYAnchor.constraint(equalTo: mark.centerYAnchor)
        ])
        addAction(UIAction { [weak self] _ in self?.onTap?() }, for: .primaryActionTriggered)
        isAccessibilityElement = true
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(_ task: SpaceTask, first: Bool) {
        rule.isHidden = first
        let dispatched = !task.session.isEmpty
        let done = dispatched && task.status == .done
        check.isHidden = !done
        dot?.removeFromSuperview()
        dot = nil
        if !done {
            let next = dispatched ? childDot(task.status) : childDot(.idle)
            mark.addSubview(next)
            NSLayoutConstraint.activate([
                next.centerXAnchor.constraint(equalTo: mark.centerXAnchor),
                next.centerYAnchor.constraint(equalTo: mark.centerYAnchor)
            ])
            dot = next
        }
        name.text = task.title
        let word = dispatched ? task.status.label : "正在派"
        status.text = word
        isEnabled = dispatched
        accessibilityTraits = dispatched ? .button : .staticText
        accessibilityLabel = "\(task.title)，\(word)"
        accessibilityHint = dispatched ? "打开这件事的会话" : nil
    }

    override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted ? Theme.surfaceInset : nil }
    }
}
