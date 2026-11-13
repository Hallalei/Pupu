import UIKit

/// 顶栏中间的两段切换：玻璃胶囊底，选中的一段用 action 填充、on-action 写字，其余用 ink。
/// 聊天段是 Pupu 的头像加当前那条聊天，长按切换大家和私聊。
/// 不用 UISegmentedControl：iOS 26 把它放进导航栏后，选中段画成玻璃透镜，selectedSegmentTintColor 不生效，
/// 选中的字成了浅底白字，看不清。
final class SectionSwitch: UIControl {
    private static let inset: CGFloat = 4
    private static let widths: [CGFloat] = [82, 64]
    private static let chatIndex = 0

    private(set) var selectedIndex: Int

    /// 聊天段写的那条聊天。
    var chatTitle: String {
        get { labels[Self.chatIndex].text ?? "" }
        set {
            labels[Self.chatIndex].text = newValue
            update()
        }
    }

    /// 另一条聊天有新消息时，VoiceOver 读的话。没有新消息是 nil。
    var unread: String? {
        didSet {
            dot.isHidden = unread == nil
            update()
        }
    }

    /// 长按聊天段弹的菜单，nil 就不弹。
    var chatMenu: (() -> UIMenu?)? {
        get { chat.menu }
        set { chat.menu = newValue }
    }

    private let glass = GlassView(interactive: true)
    private let indicator = UIView()
    private let labels: [UILabel]
    private let chat = ChatSegment()
    private let avatar = UIImageView(image: UIImage(named: "pupu-avatar"))
    private let dot = UIView()

    init(titles: [String], selected: Int) {
        selectedIndex = selected
        labels = titles.map { UILabel(text: $0, style: .subheadline) }
        super.init(frame: .zero)
        glass.isUserInteractionEnabled = false
        addSubview(glass)
        glass.pin(to: self)
        indicator.backgroundColor = Theme.action
        indicator.layer.cornerCurve = .continuous
        indicator.isUserInteractionEnabled = false
        addSubview(indicator)
        for (index, label) in labels.enumerated() {
            label.textAlignment = index == Self.chatIndex ? .natural : .center
            label.adjustsFontSizeToFitWidth = true
            label.minimumScaleFactor = 0.7
            label.isAccessibilityElement = index != Self.chatIndex
            (index == Self.chatIndex ? chat : self).addSubview(label)
        }
        addSubview(chat)
        avatar.clipsToBounds = true
        avatar.layer.cornerRadius = 13
        avatar.layer.magnificationFilter = .nearest
        chat.addSubview(avatar)
        dot.backgroundColor = Theme.danger
        dot.layer.cornerRadius = 5
        dot.layer.borderWidth = 1
        dot.layer.borderColor = UIColor.white.cgColor
        dot.isHidden = true
        dot.isUserInteractionEnabled = false
        chat.addSubview(dot)
        chat.isContextMenuInteractionEnabled = true
        chat.addAction(UIAction { [weak self] _ in self?.pick(Self.chatIndex) }, for: .touchUpInside)
        chat.isAccessibilityElement = true
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
        isAccessibilityElement = false
        accessibilityTraits = .tabBar
        accessibilityElements = [chat, labels[1]]
        update()
    }

    required init?(coder: NSCoder) { fatalError() }

    override var intrinsicContentSize: CGSize {
        CGSize(width: Self.inset * 2 + Self.widths.reduce(0, +), height: Theme.Size.control)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        for (index, label) in labels.enumerated() where index != Self.chatIndex {
            label.frame = frame(of: index)
        }
        chat.frame = frame(of: Self.chatIndex)
        avatar.frame = CGRect(x: 6, y: (chat.bounds.height - 26) / 2, width: 26, height: 26)
        dot.frame = CGRect(x: 25, y: avatar.frame.minY - 2, width: 10, height: 10)
        labels[Self.chatIndex].frame = CGRect(x: avatar.frame.maxX + 6, y: 0, width: 36, height: chat.bounds.height)
        indicator.frame = frame(of: selectedIndex)
        indicator.layer.cornerRadius = indicator.bounds.height / 2
    }

    /// 换 Pupu 的头像。像素画放大按格子来，照片照常平滑。
    func setAvatar(_ image: UIImage?, pixelArt: Bool) {
        avatar.image = image
        avatar.layer.magnificationFilter = pixelArt ? .nearest : .linear
    }

    func select(_ index: Int, animated: Bool) {
        guard labels.indices.contains(index), index != selectedIndex else { return }
        selectedIndex = index
        update()
        let move = { self.indicator.frame = self.frame(of: index) }
        if animated && !UIAccessibility.isReduceMotionEnabled {
            UIView.animate(springDuration: 0.3, bounce: 0.15, animations: move)
        } else {
            move()
        }
    }

    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
        let x = gesture.location(in: self).x
        pick(labels.indices.first { x < frame(of: $0).maxX } ?? labels.count - 1)
    }

    private func pick(_ index: Int) {
        guard index != selectedIndex else { return }
        select(index, animated: true)
        sendActions(for: .valueChanged)
    }

    private func frame(of index: Int) -> CGRect {
        CGRect(
            x: Self.inset + Self.widths[..<index].reduce(0, +),
            y: Self.inset,
            width: Self.widths[index],
            height: max(0, bounds.height - Self.inset * 2)
        )
    }

    private func update() {
        for (index, label) in labels.enumerated() {
            let selected = index == selectedIndex
            label.textColor = selected ? Theme.onAction : Theme.ink
            label.font = Theme.font(.subheadline, weight: index == Self.chatIndex ? .semibold : .medium)
            label.accessibilityTraits = selected ? [.button, .selected] : .button
        }
        chat.accessibilityLabel = ["聊天，现在是\(chatTitle)", unread].compactMap { $0 }.joined(separator: "，")
        chat.accessibilityTraits = selectedIndex == Self.chatIndex ? [.button, .selected] : .button
    }
}

/// 聊天段。长按走 UIControl 自带的菜单：从这一段弹出来，不把它抬起来。
private final class ChatSegment: UIControl {
    var menu: (() -> UIMenu?)?

    override func contextMenuInteraction(
        _ interaction: UIContextMenuInteraction,
        configurationForMenuAtLocation location: CGPoint
    ) -> UIContextMenuConfiguration? {
        guard let menu = menu?() else { return nil }
        return UIContextMenuConfiguration(actionProvider: { _ in menu })
    }

    override func contextMenuInteraction(
        _ interaction: UIContextMenuInteraction,
        willDisplayMenuFor configuration: UIContextMenuConfiguration,
        animator: (any UIContextMenuInteractionAnimating)?
    ) {
        super.contextMenuInteraction(interaction, willDisplayMenuFor: configuration, animator: animator)
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }
}
