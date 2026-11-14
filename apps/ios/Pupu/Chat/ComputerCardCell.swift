import UIKit

/// 电脑任务卡：顶上一行写在哪台电脑上和状态，带回过截图就显示最近的画面，下沿是最近的一步、「步骤」和「接手」。
/// 样子学浏览器卡片和原型里的子会话卡。网页 Chat.tsx 里的 ComputerCard 是同一个样子，两边一起改。
/// 「步骤」展开后，每一步排在卡片下面（ToolCell），点开看输出。
final class ComputerCardCell: ChatCell {
    private let card = SurfaceView(.strong, radius: Theme.Radius.row)
    private let icon = UIImageView(image: UIImage(systemName: "desktopcomputer"))
    private let title = UILabel(style: .subheadline)
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let status = UILabel(style: .caption, color: Theme.inkMuted)
    private let waiting = WaitingMark()
    private let screen = UIImageView()
    private let latest = UILabel(style: .footnote, color: Theme.inkMuted)
    private let stepsButton = ComputerCardCell.pill(title: "步骤", image: "chevron.down")
    private let takeOverButton = ComputerCardCell.pill(title: "接手", image: nil)
    private var width: NSLayoutConstraint!
    private var screenHeight: NSLayoutConstraint!
    /// 解码过的截图，按 base64 记着，滚动时不重复解码。
    private var decoded: (data: String, image: UIImage?)?

    var onToggle: (() -> Void)?
    /// 打开这台电脑的远程桌面。nil 时不放「接手」：不是自己名下的电脑。
    var onTakeOver: (() -> Void)? {
        didSet { takeOverButton.isHidden = onTakeOver == nil }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        icon.tintColor = Theme.ink
        icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .subheadline)
        icon.setContentHuggingPriority(.required, for: .horizontal)
        title.font = Theme.font(.subheadline, weight: .semibold)
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        for view in [spinner, status, waiting] as [UIView] {
            view.setContentHuggingPriority(.required, for: .horizontal)
            view.setContentCompressionResistancePriority(.required, for: .horizontal)
        }
        spinner.hidesWhenStopped = true
        let header = UIStackView(arrangedSubviews: [icon, title, spinner, status, waiting])
        header.spacing = Theme.Space.s2
        header.alignment = .center
        header.isLayoutMarginsRelativeArrangement = true
        header.directionalLayoutMargins = NSDirectionalEdgeInsets(top: Theme.Space.s2_5, leading: 14, bottom: 0, trailing: 14)

        screen.contentMode = .scaleAspectFill
        screen.clipsToBounds = true
        screen.layer.cornerRadius = Theme.Radius.tag
        screen.layer.cornerCurve = .continuous
        screen.layer.borderWidth = 1
        screen.layer.borderColor = UIColor.black.withAlphaComponent(0.05).cgColor
        screen.isAccessibilityElement = true
        let screenBox = UIView()
        screenBox.addSubview(screen)
        screen.pin(to: screenBox, insets: UIEdgeInsets(top: 0, left: 14, bottom: 0, right: 14))
        screenHeight = screen.heightAnchor.constraint(equalToConstant: 132)
        screenHeight.priority = .defaultHigh
        screenHeight.isActive = true

        latest.lineBreakMode = .byTruncatingTail
        latest.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        stepsButton.addAction(UIAction { [weak self] _ in self?.onToggle?() }, for: .primaryActionTriggered)
        takeOverButton.addAction(UIAction { [weak self] _ in self?.onTakeOver?() }, for: .primaryActionTriggered)
        takeOverButton.isHidden = true
        let footer = UIStackView(arrangedSubviews: [latest, stepsButton, takeOverButton])
        footer.spacing = Theme.Space.s2
        footer.alignment = .center
        footer.isLayoutMarginsRelativeArrangement = true
        footer.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 0, leading: 14, bottom: Theme.Space.s3, trailing: 14)

        let stack = UIStackView(arrangedSubviews: [header, screenBox, footer])
        stack.axis = .vertical
        stack.spacing = Theme.Space.s2
        card.contentView.addSubview(stack)
        stack.pin(to: card.contentView)
        place(card, alignment: .left, fraction: 1)
        width = card.widthAnchor.constraint(equalToConstant: 300)
        width.priority = .defaultHigh
        width.isActive = true
    }

    required init?(coder: NSCoder) { fatalError() }

    override var bubbleView: UIView? { card }
    override var bubbleRadius: CGFloat { Theme.Radius.row }

    func configure(task: ComputerTask, width cardWidth: CGFloat) {
        let boxWidth = min(cardWidth, 420)
        width.constant = boxWidth
        title.text = task.computer.map { "在「\($0)」上" } ?? "在电脑上"

        let active = task.state == .live || task.state == .waiting
        if task.state == .live { spinner.startAnimating() } else { spinner.stopAnimating() }
        waiting.isHidden = task.state != .waiting
        status.isHidden = task.state == .waiting
        status.text = task.status
        status.textColor = task.state == .failed ? Theme.dangerInk : Theme.inkMuted

        let image = task.screen.flatMap(decode)
        screen.superview?.isHidden = image == nil
        screen.image = image
        screen.alpha = active ? 1 : 0.8
        if let image {
            let ratio = image.size.height / max(image.size.width, 1)
            screenHeight.constant = min((boxWidth - 28) * ratio, 200)
        }
        screen.accessibilityLabel = "「\(task.computer ?? "电脑")」上的画面"

        latest.text = task.latest
        var config = stepsButton.configuration
        config?.image = UIImage(systemName: task.expanded ? "chevron.up" : "chevron.down")
        stepsButton.configuration = config
        stepsButton.accessibilityValue = task.expanded ? "已展开" : "已收起"

        card.isAccessibilityElement = false
        title.accessibilityLabel = "\(title.text ?? "")，\(task.status)"
    }

    private func decode(_ image: StepImage) -> UIImage? {
        if let decoded, decoded.data == image.data { return decoded.image }
        let result = Data(base64Encoded: image.data).flatMap { UIImage(data: $0) }
        decoded = (image.data, result)
        return result
    }

    /// 浅灰底的小胶囊，比如「步骤」「接手」。
    static func pill(title: String, image: String?) -> UIButton {
        var config = UIButton.Configuration.filled()
        config.title = title
        config.image = image.flatMap { UIImage(systemName: $0) }
        config.imagePlacement = .trailing
        config.imagePadding = 4
        config.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(textStyle: .caption2, scale: .small)
        config.baseBackgroundColor = Theme.surfaceInset
        config.baseForegroundColor = Theme.ink
        config.cornerStyle = .capsule
        config.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 14, bottom: 6, trailing: 14)
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = Theme.font(.footnote, weight: .semibold)
            return attributes
        }
        let button = UIButton(configuration: config)
        button.setContentHuggingPriority(.required, for: .horizontal)
        button.setContentCompressionResistancePriority(.required, for: .horizontal)
        return button
    }
}
