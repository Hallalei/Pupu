import UIKit

/// 协调模式的主会话里，派给子会话的一件事：状态点、名字、一句状态，右边箭头，点了进子会话。
/// 照原型画板 PhoneSpace 的任务卡。
final class TaskCardCell: ChatCell {
    private let card = SurfaceView(.strong, radius: Theme.Radius.row, lifted: true)
    private let dotHolder = UIView()
    private let name = UILabel(style: .headline)
    private let line = UILabel(style: .subheadline, color: Theme.inkMuted, lines: 2)
    private var width: NSLayoutConstraint!
    var onOpen: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        name.lineBreakMode = .byTruncatingTail
        let words = UIStackView(arrangedSubviews: [name, line])
        words.axis = .vertical
        words.spacing = 2
        words.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let chevron = UIImageView(image: UIImage(systemName: "chevron.right"))
        chevron.tintColor = Theme.ink
        chevron.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .footnote, scale: .small)
        chevron.setContentHuggingPriority(.required, for: .horizontal)
        dotHolder.setContentHuggingPriority(.required, for: .horizontal)
        let row = UIStackView(arrangedSubviews: [dotHolder, words, chevron])
        row.spacing = Theme.Space.s3
        row.alignment = .center
        row.isUserInteractionEnabled = false
        card.contentView.addSubview(row)
        row.pin(to: card.contentView, insets: UIEdgeInsets(top: Theme.Space.s3, left: Theme.Space.s4, bottom: Theme.Space.s3, right: Theme.Space.s4))
        place(card, alignment: .left)
        width = card.widthAnchor.constraint(equalToConstant: 0)
        width.priority = .defaultHigh
        width.isActive = true
        card.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityHint = "打开这件事的会话"
    }

    required init?(coder: NSCoder) { fatalError() }

    override var bubbleView: UIView? { card }
    override var bubbleRadius: CGFloat { Theme.Radius.row }

    @objc private func tapped() { onOpen?() }

    override func accessibilityActivate() -> Bool {
        onOpen?()
        return onOpen != nil
    }

    func configure(task: SpaceTask, width: CGFloat) {
        self.width.constant = width
        name.text = task.title
        line.text = task.line
        line.preferredMaxLayoutWidth = width - 70
        dotHolder.subviews.forEach { $0.removeFromSuperview() }
        let dot = childDot(task.status)
        dotHolder.addSubview(dot)
        dot.pin(to: dotHolder)
        accessibilityLabel = "\(task.title)，\(task.line)"
    }
}
