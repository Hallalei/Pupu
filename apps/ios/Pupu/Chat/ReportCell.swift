import UIKit

/// 项目报回聊天的结果：空间标记、项目名、状态、一句结果，整张卡点过去。同一个项目没看过的几条合成这一张。
/// 长按或右滑能引用回复，引用里带着项目名，聊天里的 Pupu 就知道在说哪个项目。规范没画，和网页 Chat.tsx 的 ReportBubble 一样：
/// `surface-inset` 底、`radius-row`，最宽 85%。
final class ReportCell: ChatCell {
    private let card = SurfaceView(.inset, radius: Theme.Radius.row)
    private let mark = SpaceMarkView()
    private let name = UILabel(style: .footnote)
    private let status = UILabel(style: .caption, color: Theme.inkMuted)
    private let blocked = WaitingMark(text: ReportCard.Status.blocked.label)
    private let summary = UILabel(style: .subheadline, lines: 0)
    private let more = UILabel(style: .caption, color: Theme.inkMuted)
    private var width: NSLayoutConstraint!
    var onOpen: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        name.font = Theme.font(.footnote, weight: .semibold)
        name.lineBreakMode = .byTruncatingTail
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        name.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let chevron = UIImageView(image: UIImage(systemName: "chevron.right"))
        chevron.tintColor = Theme.inkFaint
        chevron.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .footnote, scale: .medium)
        for view in [status, blocked, chevron] as [UIView] {
            view.setContentHuggingPriority(.required, for: .horizontal)
            view.setContentCompressionResistancePriority(.required, for: .horizontal)
        }
        let header = UIStackView(arrangedSubviews: [mark, name, status, blocked, chevron])
        header.spacing = Theme.Space.s2
        header.alignment = .center

        let stack = UIStackView(arrangedSubviews: [header, summary, more])
        stack.axis = .vertical
        stack.spacing = Theme.Space.s1
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

    @objc private func tapped() { onOpen?() }

    override func accessibilityActivate() -> Bool {
        onOpen?()
        return onOpen != nil
    }

    /// project 是对得上的那个空间，用它的颜色和图标。
    func configure(card report: ReportCard, project: Project?, width: CGFloat) {
        self.width.constant = width
        if let project { mark.show(project) } else { mark.show(color: nil, icon: nil, name: report.projectName) }
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
