import UIKit

/// 项目报回聊天的结果：项目名、状态、一句结果，点「去项目看」过去。同一个项目没看过的几条合成这一张。
/// 长按或右滑能引用回复，引用里带着项目名，聊天里的 Pupu 就知道在说哪个项目。和网页 Chat.tsx 的 ReportBubble 一样。
final class ReportCell: ChatCell {
    private let card = SurfaceView(.strong, radius: Theme.Radius.row)
    private let icon = UIImageView(image: UIImage(systemName: "folder"))
    private let name = UILabel(style: .footnote)
    private let status = UILabel(style: .caption, color: Theme.inkMuted)
    private let blocked = WaitingMark(text: "卡住了要你定")
    private let summary = UILabel(style: .subheadline, lines: 0)
    private let more = UILabel(style: .caption, color: Theme.inkMuted)
    private let open = UIButton(configuration: .plain())
    private var width: NSLayoutConstraint!
    var onOpen: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        icon.tintColor = Theme.inkMuted
        icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .footnote)
        icon.setContentHuggingPriority(.required, for: .horizontal)
        name.font = Theme.font(.footnote, weight: .semibold)
        name.lineBreakMode = .byTruncatingTail
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        for view in [status, blocked] as [UIView] {
            view.setContentHuggingPriority(.required, for: .horizontal)
            view.setContentCompressionResistancePriority(.required, for: .horizontal)
        }
        let header = UIStackView(arrangedSubviews: [icon, name, status, blocked])
        header.spacing = Theme.Space.s2
        header.alignment = .center

        var config = UIButton.Configuration.plain()
        config.image = UIImage(systemName: "chevron.right")
        config.imagePlacement = .trailing
        config.imagePadding = 2
        config.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(textStyle: .caption1)
        config.baseForegroundColor = Theme.ink
        config.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 0, bottom: 6, trailing: 0)
        config.title = "去项目看"
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = Theme.font(.footnote, weight: .semibold)
            return attributes
        }
        open.configuration = config
        open.setContentHuggingPriority(.required, for: .horizontal)
        open.addAction(UIAction { [weak self] _ in self?.onOpen?() }, for: .primaryActionTriggered)
        let footer = UIStackView(arrangedSubviews: [more, UIView(), open])
        footer.alignment = .center
        footer.spacing = Theme.Space.s2

        let stack = UIStackView(arrangedSubviews: [header, summary, footer])
        stack.axis = .vertical
        stack.spacing = Theme.Space.s1
        stack.setCustomSpacing(0, after: summary)
        card.contentView.addSubview(stack)
        stack.pin(to: card.contentView, insets: UIEdgeInsets(top: Theme.Space.s2_5, left: Theme.Space.s3, bottom: Theme.Space.s1, right: Theme.Space.s3))
        place(card, alignment: .left)
        width = card.widthAnchor.constraint(equalToConstant: 0)
        width.priority = .defaultHigh
        width.isActive = true

        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    required init?(coder: NSCoder) { fatalError() }

    override var bubbleView: UIView? { card }
    override var bubbleRadius: CGFloat { Theme.Radius.row }

    override func accessibilityActivate() -> Bool {
        onOpen?()
        return onOpen != nil
    }

    func configure(card report: ReportCard, width: CGFloat) {
        self.width.constant = width
        name.text = report.projectName
        let state = report.currentStatus
        blocked.isHidden = state != .blocked
        status.isHidden = state == .blocked
        status.text = state.label
        status.textColor = state == .failed ? Theme.dangerInk : Theme.inkMuted
        summary.text = report.summary
        summary.preferredMaxLayoutWidth = width - Theme.Space.s3 * 2
        more.text = report.more > 0 ? "还有 \(report.more) 条" : nil
        more.isHidden = report.more == 0
        accessibilityLabel = "项目「\(report.projectName)」\(state.label)：\(report.summary)" + (report.more > 0 ? "，还有 \(report.more) 条" : "")
        accessibilityHint = "打开这个项目"
    }
}
