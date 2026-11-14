import UIKit

// 规范 SpaceHeader 在手机上的几块：顶栏左边的圆按钮、中间「在哪」、右边成员胶囊、子会话的两行标题。
// 都直接画在窗框上，实色，不用玻璃；放进导航栏时 `hidesSharedBackground`，系统不再套一层玻璃。
// 和网页 Spaces.tsx 的 SwitchButton、BackButton、PlaceTitle、MembersCapsule、ChildTitle 一起改。

/// 顶栏左边的圆按钮：`selected` 底加 `shadow-selected`。切换（≡）和返回（‹）都是它。
/// 看得见的圆是 40（规范 SpaceHeader），点按区补到 44（tokens 的 `control`）。
final class BarButton: TapControl {
    static let side: CGFloat = 40

    private let icon = UIImageView()
    private let dot = UIView()

    init(image: String, label: String) {
        super.init(frame: .zero)
        backgroundColor = Theme.selected
        layer.cornerRadius = Self.side / 2
        applyShadow(.selected)
        icon.image = UIImage(systemName: image, withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .medium))
        icon.tintColor = Theme.ink
        icon.isUserInteractionEnabled = false
        icon.translatesAutoresizingMaskIntoConstraints = false
        addSubview(icon)
        // 别处有新消息：右上角 6 的墨色小点。
        dot.backgroundColor = Theme.ink
        dot.layer.cornerRadius = 3
        dot.isHidden = true
        dot.isUserInteractionEnabled = false
        dot.translatesAutoresizingMaskIntoConstraints = false
        addSubview(dot)
        translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: Self.side),
            heightAnchor.constraint(equalToConstant: Self.side),
            icon.centerXAnchor.constraint(equalTo: centerXAnchor),
            icon.centerYAnchor.constraint(equalTo: centerYAnchor),
            dot.widthAnchor.constraint(equalToConstant: 6),
            dot.heightAnchor.constraint(equalToConstant: 6),
            dot.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            dot.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6)
        ])
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityLabel = label
    }

    required init?(coder: NSCoder) { fatalError() }

    var unread: Bool {
        get { !dot.isHidden }
        set { dot.isHidden = !newValue }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layer.shadowPath = UIBezierPath(ovalIn: bounds).cgPath
    }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.6 : 1 }
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        bounds.insetBy(dx: -2, dy: -2).contains(point)
    }

    /// 放进导航栏的样子：系统不再套玻璃。
    func barItem() -> UIBarButtonItem {
        let item = UIBarButtonItem(customView: self)
        item.hidesSharedBackground = true
        return item
    }
}

/// 顶栏中间：空间标记方块加名字（`headline`）；「我的 Pupu」是 Pupu 的头像（26）加名字；
/// Artifacts 是 `doc.text`（16，`ink-muted`，放在标记那么大的格子里）加名字。合成一个元素读。
final class PlaceTitleView: UIView {
    private let mark = SpaceMarkView()
    private let avatar = UIImageView()
    private let docs = UIImageView(image: UIImage(systemName: "doc.text", withConfiguration: UIImage.SymbolConfiguration(pointSize: 16)))
    private let name = UILabel(style: .headline)

    override init(frame: CGRect) {
        super.init(frame: frame)
        avatar.layer.cornerRadius = 13
        avatar.clipsToBounds = true
        avatar.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            avatar.widthAnchor.constraint(equalToConstant: 26),
            avatar.heightAnchor.constraint(equalToConstant: 26)
        ])
        docs.tintColor = Theme.inkMuted
        docs.contentMode = .center
        docs.isHidden = true
        docs.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            docs.widthAnchor.constraint(equalToConstant: Theme.Size.mark),
            docs.heightAnchor.constraint(equalToConstant: Theme.Size.mark)
        ])
        name.lineBreakMode = .byTruncatingTail
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let row = UIStackView(arrangedSubviews: [mark, avatar, docs, name])
        row.spacing = Theme.Space.s2
        row.alignment = .center
        addSubview(row)
        row.pin(to: self)
        isAccessibilityElement = true
        accessibilityTraits = .header
    }

    required init?(coder: NSCoder) { fatalError() }

    func show(_ project: Project) {
        mark.show(project)
        mark.isHidden = false
        avatar.isHidden = true
        docs.isHidden = true
        name.text = project.name
        accessibilityLabel = project.name
    }

    func showPupu() {
        let pupu = Avatars.shared.pupu()
        avatar.image = Avatars.round(pupu.image, letter: "P", size: 26, pixelArt: pupu.pixelArt)
        avatar.isHidden = false
        mark.isHidden = true
        docs.isHidden = true
        name.text = "我的 Pupu"
        accessibilityLabel = "我的 Pupu"
    }

    func showDocs() {
        docs.isHidden = false
        mark.isHidden = true
        avatar.isHidden = true
        name.text = "Artifacts"
        accessibilityLabel = "Artifacts"
    }
}

/// 顶栏右边的成员胶囊：高 40，`selected` 底加 `shadow-selected`，点开空间设置。
/// 全组织看得到的空间画楼，别的画成员头像叠（22，描一圈 `selected`）。没什么可设的时候只是一块标识，不能点。
final class MembersCapsule: TapControl {
    private let building = UIImageView(image: UIImage(systemName: "building.2", withConfiguration: UIImage.SymbolConfiguration(pointSize: 16)))
    private let avatars = SpaceAvatarStack(size: Theme.Size.avatarSmall, ring: Theme.selected)
    var onTap: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = Theme.selected
        layer.cornerRadius = BarButton.side / 2
        applyShadow(.selected)
        building.tintColor = Theme.inkMuted
        let row = UIStackView(arrangedSubviews: [building, avatars])
        row.alignment = .center
        row.isUserInteractionEnabled = false
        addSubview(row)
        row.pin(to: self, insets: UIEdgeInsets(top: 0, left: 9, bottom: 0, right: 9))
        translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: BarButton.side),
            widthAnchor.constraint(greaterThanOrEqualToConstant: BarButton.side)
        ])
        addAction(UIAction { [weak self] _ in self?.onTap?() }, for: .primaryActionTriggered)
        isAccessibilityElement = true
    }

    required init?(coder: NSCoder) { fatalError() }

    /// 返回这个空间有没有可画的：老项目没有成员名单，顶栏右边就空着。
    func show(_ project: Project, tappable: Bool) -> Bool {
        let open = project.isEveryone || project.isOpen
        building.isHidden = !open
        avatars.show(open ? [] : project.memberIds)
        let count = open ? "全组织" : "成员 \(project.memberIds.count) 人"
        accessibilityLabel = tappable ? "\(count)，空间设置" : count
        accessibilityTraits = tappable ? .button : .image
        isUserInteractionEnabled = tappable
        return open || !avatars.isHidden
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layer.shadowPath = UIBezierPath(roundedRect: bounds, cornerRadius: bounds.height / 2).cgPath
    }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.6 : 1 }
    }

    func barItem() -> UIBarButtonItem {
        let item = UIBarButtonItem(customView: self)
        item.hidesSharedBackground = true
        return item
    }
}

/// 子会话的顶栏标题：名字（`headline`），下面状态圆点加状态词和时间（`footnote`，`ink-muted`）。
/// 跟在返回后面靠左，右边空着：宽度撑满导航栏让出来的地方。
final class ChildTitleView: UIView {
    private let name = UILabel(style: .headline)
    private let status = UILabel(style: .footnote, color: Theme.inkMuted)
    private let dotHolder = UIView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        name.lineBreakMode = .byTruncatingTail
        status.lineBreakMode = .byTruncatingTail
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        status.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let line = UIStackView(arrangedSubviews: [dotHolder, status])
        line.spacing = 6
        line.alignment = .center
        let column = UIStackView(arrangedSubviews: [name, line])
        column.axis = .vertical
        column.alignment = .leading
        column.spacing = 1
        addSubview(column)
        column.pin(to: self)
        isAccessibilityElement = true
        accessibilityTraits = .header
    }

    required init?(coder: NSCoder) { fatalError() }

    override var intrinsicContentSize: CGSize {
        CGSize(width: UIView.layoutFittingExpandedSize.width, height: UIView.noIntrinsicMetric)
    }

    func show(_ child: SpaceChild) {
        name.text = child.title
        status.text = "\(child.status.label) · \(Ago.text(child.reportedAt ?? child.createdAt))"
        dotHolder.subviews.forEach { $0.removeFromSuperview() }
        let dot = childDot(child.status)
        dotHolder.addSubview(dot)
        dot.pin(to: dotHolder)
        accessibilityLabel = "\(child.title)，\(status.text ?? "")"
    }
}
