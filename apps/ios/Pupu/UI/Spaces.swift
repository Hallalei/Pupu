import UIKit

// 协作版的空间界面，照原型画板 PhoneSwitch、PhoneInvite、PhoneTask（claude.ai 上的「Pupu 协作版原型」）：
// 切换 sheet、邀请 sheet、子会话页。接口见云端 server.ts 的 /api/spaces。

/// 空间成员的头像叠在一起，最多三个。
final class SpaceAvatarStack: UIStackView {
    private let size: CGFloat

    init(size: CGFloat = 24) {
        self.size = size
        super.init(frame: .zero)
        spacing = -7
        alignment = .center
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
        isAccessibilityElement = false
    }

    required init(coder: NSCoder) { fatalError() }

    /// `ids` 是成员 id，按名单里的先后画；名单里查不到的不画。
    func show(_ ids: [String]) {
        arrangedSubviews.forEach { $0.removeFromSuperview() }
        let members = Store.shared.members.filter { ids.contains($0.id) }
        for member in members.prefix(3) {
            let image = Avatars.round(
                Avatars.shared.image(member.avatar),
                letter: Avatars.letter(member.displayName),
                size: size,
                pixelArt: Avatars.isPixelArt(member.avatar)
            )
            let view = UIImageView(image: image)
            view.layer.cornerRadius = size / 2
            view.layer.borderWidth = 2
            view.layer.borderColor = UIColor.white.withAlphaComponent(0.82).cgColor
            view.clipsToBounds = true
            view.widthAnchor.constraint(equalToConstant: size).isActive = true
            view.heightAnchor.constraint(equalToConstant: size).isActive = true
            addArrangedSubview(view)
        }
        isHidden = members.isEmpty
    }
}

/// 空间行右边的标记：L3、L4 是成员头像，全组织是楼的图标。
private func spaceMark(_ project: Project, size: CGFloat = 24) -> UIView {
    if project.isOpen {
        let icon = UIImageView(image: UIImage(systemName: "building.2"))
        icon.tintColor = Theme.ink
        icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .body)
        icon.isAccessibilityElement = true
        icon.accessibilityLabel = "全组织"
        icon.setContentHuggingPriority(.required, for: .horizontal)
        return icon
    }
    let stack = SpaceAvatarStack(size: size)
    stack.show(project.memberIds)
    return stack
}

/// 子会话状态的小圆点：等批是琥珀，在做是墨色，做完是绿。
func childDot(_ status: SpaceChild.Status, size: CGFloat = 8) -> UIView {
    let dot = UIView()
    dot.backgroundColor = switch status {
    case .waiting: Theme.warning
    case .working: Theme.ink
    case .done: Theme.online
    case .idle: Theme.inkMuted
    }
    dot.layer.cornerRadius = size / 2
    dot.translatesAutoresizingMaskIntoConstraints = false
    dot.widthAnchor.constraint(equalToConstant: size).isActive = true
    dot.heightAnchor.constraint(equalToConstant: size).isActive = true
    return dot
}

/// sheet 里的一组：圆角浅底，行之间有细线。
private final class SheetGroup: UIView {
    let stack = UIStackView()

    init(_ rows: [UIView], separatorInset: CGFloat = 52) {
        super.init(frame: .zero)
        backgroundColor = .secondarySystemGroupedBackground
        layer.cornerRadius = Theme.Radius.row
        layer.cornerCurve = .continuous
        clipsToBounds = true
        stack.axis = .vertical
        addSubview(stack)
        stack.pin(to: self)
        for (index, row) in rows.enumerated() {
            if index > 0, !(row is SheetSubRow) {
                let line = UIView()
                line.backgroundColor = .separator
                let holder = UIView()
                holder.addSubview(line)
                line.translatesAutoresizingMaskIntoConstraints = false
                NSLayoutConstraint.activate([
                    holder.heightAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale),
                    line.topAnchor.constraint(equalTo: holder.topAnchor),
                    line.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
                    line.leadingAnchor.constraint(equalTo: holder.leadingAnchor, constant: separatorInset),
                    line.trailingAnchor.constraint(equalTo: holder.trailingAnchor)
                ])
                stack.addArrangedSubview(holder)
            }
            stack.addArrangedSubview(row)
        }
    }

    required init?(coder: NSCoder) { fatalError() }
}

/// sheet 里能点的一行：左边图标，中间名字，右边标记。按下时变暗。
private class SheetRow: UIControl {
    let row = UIStackView()
    private let action: (() -> Void)?

    init(leading: UIView?, title: String, weight: UIFont.Weight = .regular, detail: String? = nil, trailing: [UIView] = [], height: CGFloat = 52, insetLeading: CGFloat = Theme.Space.s4, action: (() -> Void)?) {
        self.action = action
        super.init(frame: .zero)
        let name = UILabel(text: title, style: .body)
        name.font = Theme.font(.body, weight: weight)
        name.lineBreakMode = .byTruncatingTail
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        var text: UIView = name
        if let detail {
            let sub = UILabel(text: detail, style: .subheadline, color: Theme.inkMuted, lines: 0)
            let words = UIStackView(arrangedSubviews: [name, sub])
            words.axis = .vertical
            words.spacing = 2
            text = words
        }
        text.setContentHuggingPriority(.defaultLow, for: .horizontal)
        row.spacing = Theme.Space.s3
        row.alignment = .center
        for view in [leading].compactMap({ $0 }) + trailing {
            view.setContentHuggingPriority(.required, for: .horizontal)
            view.setContentCompressionResistancePriority(.required, for: .horizontal)
        }
        if let leading { row.addArrangedSubview(leading) }
        row.addArrangedSubview(text)
        for view in trailing { row.addArrangedSubview(view) }
        addSubview(row)
        row.pin(to: self, insets: UIEdgeInsets(top: Theme.Space.s2, left: insetLeading, bottom: Theme.Space.s2, right: Theme.Space.s4))
        heightAnchor.constraint(greaterThanOrEqualToConstant: height).isActive = true
        isAccessibilityElement = true
        accessibilityTraits = action == nil ? .staticText : .button
        accessibilityLabel = [title, detail].compactMap { $0 }.joined(separator: "，")
        if action != nil { addAction(UIAction { [weak self] _ in self?.action?() }, for: .touchUpInside) }
    }

    required init?(coder: NSCoder) { fatalError() }

    override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted && action != nil ? Theme.scrim : .clear }
    }

    /// 行里的控件（邀请、移出、开关）自己接；别处都算点这一行。开关点到的是它里面的子视图，往上找到控件本身。
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard let hit = super.hitTest(point, with: event) else { return nil }
        var view: UIView? = hit
        while let current = view, current !== self {
            if current is UIControl { return hit }
            view = current.superview
        }
        return self
    }
}

/// 当前空间下面的子会话：缩进，点 + 名字 + 状态字。
private final class SheetSubRow: SheetRow {}

/// 切换空间的 sheet：「我的 Pupu」和「资料」，「空间」和「新空间」，下面全员在第一个，再是每个空间一行，当前空间展开它的子会话。
final class SpaceSwitcherViewController: UIViewController {
    private let current: String?
    private let everyoneUnread: Bool
    private let openPupu: () -> Void
    private let openDocs: () -> Void
    private let open: (Project) -> Void
    private let openChild: (Project, SpaceChild) -> Void
    private let create: () -> Void
    private let content = UIStackView()
    private var token: StoreToken?

    init(current: String?, everyoneUnread: Bool, openPupu: @escaping () -> Void, openDocs: @escaping () -> Void, open: @escaping (Project) -> Void, openChild: @escaping (Project, SpaceChild) -> Void, create: @escaping () -> Void) {
        self.current = current
        self.everyoneUnread = everyoneUnread
        self.openPupu = openPupu
        self.openDocs = openDocs
        self.open = open
        self.openChild = openChild
        self.create = create
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemGroupedBackground
        let scroll = UIScrollView()
        scroll.alwaysBounceVertical = true
        view.addSubview(scroll)
        scroll.pin(to: view)
        content.axis = .vertical
        content.spacing = Theme.Space.s4
        content.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(content)
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: Theme.Space.s6),
            content.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -Theme.Space.s6),
            content.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: Theme.Space.s4),
            content.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -Theme.Space.s4)
        ])
        token = Store.shared.observe { [weak self] in self?.render() }
        render()
    }

    /// 上次画出来的内容。Store 一有动静就会叫，内容没变不重画：重画会把手指正按着的那一行换掉，点不动。
    private var shown: Int?

    private func render() {
        let waiting = ComputerActivity.waitingProjects(Store.shared.activity)
        let pupu = Avatars.shared.pupu()
        var key = Hasher()
        key.combine(Store.shared.spaces)
        key.combine(Set(waiting))
        key.combine(pupu.image != nil)
        let shownNow = key.finalize()
        guard shownNow != shown else { return }
        shown = shownNow
        content.arrangedSubviews.forEach { $0.removeFromSuperview() }
        let avatar = UIImageView(image: Avatars.round(pupu.image, letter: "P", size: 28, pixelArt: pupu.pixelArt))
        let docsIcon = UIImageView(image: UIImage(systemName: "doc.text"))
        docsIcon.tintColor = Theme.ink
        docsIcon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .body)
        docsIcon.contentMode = .center
        docsIcon.widthAnchor.constraint(equalToConstant: 28).isActive = true
        content.addArrangedSubview(SheetGroup([
            SheetRow(leading: avatar, title: "我的 Pupu", weight: .semibold) { [weak self] in self?.finish { $0.openPupu() } },
            SheetRow(leading: docsIcon, title: "资料") { [weak self] in self?.finish { $0.openDocs() } }
        ]))

        let label = UILabel(text: "空间", style: .footnote, color: Theme.inkMuted)
        label.font = Theme.font(.footnote, weight: .medium)
        var config = UIButton.Configuration.plain()
        config.title = "新空间"
        config.image = UIImage(systemName: "plus")
        config.imagePadding = Theme.Space.s1
        config.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(textStyle: .footnote, scale: .medium)
        config.baseForegroundColor = Theme.ink
        config.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 0, bottom: 6, trailing: 0)
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = Theme.font(.subheadline, weight: .semibold)
            return attributes
        }
        let button = UIButton(configuration: config)
        button.addAction(UIAction { [weak self] _ in self?.finish { $0.create() } }, for: .primaryActionTriggered)
        let header = UIStackView(arrangedSubviews: [label, UIView(), button])
        header.alignment = .center
        header.isLayoutMarginsRelativeArrangement = true
        header.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 0, leading: Theme.Space.s1, bottom: 0, trailing: Theme.Space.s1)
        content.addArrangedSubview(header)
        content.setCustomSpacing(Theme.Space.s1, after: header)

        var rows: [UIView] = []
        for project in Store.shared.spaces {
            let selected = project.id == current
            let icon = UIImageView(image: UIImage(systemName: project.isEveryone ? "building.2" : "folder"))
            icon.tintColor = Theme.ink
            icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .body)
            icon.setContentHuggingPriority(.required, for: .horizontal)
            var trailing: [UIView] = []
            if project.isEveryone && everyoneUnread {
                let dot = UIView()
                dot.backgroundColor = Theme.danger
                dot.layer.cornerRadius = 4
                dot.isAccessibilityElement = false
                dot.widthAnchor.constraint(equalToConstant: 8).isActive = true
                dot.heightAnchor.constraint(equalToConstant: 8).isActive = true
                trailing.append(dot)
            }
            if waiting.contains(project.id) { trailing.append(WaitingMark()) }
            if !project.isEveryone { trailing.append(spaceMark(project)) }
            let check = UIImageView(image: UIImage(systemName: "checkmark"))
            check.tintColor = Theme.ink
            check.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .footnote, scale: .medium)
            check.alpha = selected ? 1 : 0
            check.isAccessibilityElement = false
            check.setContentHuggingPriority(.required, for: .horizontal)
            trailing.append(check)
            let row = SheetRow(leading: icon, title: project.name, weight: selected ? .semibold : .regular, trailing: trailing) { [weak self] in
                self?.finish { $0.open(project) }
            }
            if selected { row.accessibilityValue = "当前" } else if project.isEveryone && everyoneUnread { row.accessibilityValue = "有新消息" }
            rows.append(row)
            guard selected else { continue }
            for child in project.spaceChildren.reversed() {
                let status = UILabel(text: child.status.label, style: .footnote, color: Theme.inkMuted)
                status.setContentHuggingPriority(.required, for: .horizontal)
                let sub = SheetSubRow(leading: childDot(child.status), title: child.title, trailing: [status], height: 40, insetLeading: 52) { [weak self] in
                    self?.finish { $0.openChild(project, child) }
                }
                sub.accessibilityLabel = "\(child.title)，\(child.status.label)"
                rows.append(sub)
            }
        }
        if !rows.isEmpty { content.addArrangedSubview(SheetGroup(rows)) }
    }

    /// 先收起 sheet 再做，接下来要弹的（新空间的对话框、子会话页）不会被 sheet 挡住。
    private func finish(_ then: @escaping (SpaceSwitcherViewController) -> Void) {
        UISelectionFeedbackGenerator().selectionChanged()
        dismiss(animated: true) { then(self) }
    }
}

/// 邀请 sheet：成员名单、找组织里的人、谁看得到、只派活。只有建的人能邀请、移出、改密级、切只派活；别人只看名单。
/// 全员空间也用它当设置：只有「只派活」一项，组织创建者才打得开。
final class InviteSheetViewController: UIViewController, UITextFieldDelegate {
    private let projectId: String
    private let content = UIStackView()
    private let search = UITextField()
    private let titleLabel = UILabel(style: .title)
    private var token: StoreToken?
    private var busy = false

    init(projectId: String) {
        self.projectId = projectId
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemGroupedBackground
        titleLabel.font = Theme.font(.title, weight: .semibold)
        titleLabel.accessibilityTraits = .header
        var close = UIButton.Configuration.gray()
        close.image = UIImage(systemName: "xmark")
        close.cornerStyle = .capsule
        close.baseForegroundColor = Theme.ink
        close.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(textStyle: .footnote, scale: .medium)
        let closeButton = UIButton(configuration: close)
        closeButton.accessibilityLabel = "关闭"
        closeButton.addAction(UIAction { [weak self] _ in self?.dismiss(animated: true) }, for: .primaryActionTriggered)
        closeButton.widthAnchor.constraint(equalToConstant: Theme.Size.controlSmall).isActive = true
        closeButton.heightAnchor.constraint(equalToConstant: Theme.Size.controlSmall).isActive = true
        let header = UIStackView(arrangedSubviews: [titleLabel, UIView(), closeButton])
        header.alignment = .center

        let scroll = UIScrollView()
        scroll.alwaysBounceVertical = true
        scroll.keyboardDismissMode = .interactive
        view.addSubview(scroll)
        scroll.pin(to: view)
        let page = UIStackView(arrangedSubviews: [header, content])
        page.axis = .vertical
        page.spacing = Theme.Space.s4
        page.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(page)
        NSLayoutConstraint.activate([
            page.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: Theme.Space.s6),
            page.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -Theme.Space.s6),
            page.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: Theme.Space.s4),
            page.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -Theme.Space.s4)
        ])
        content.axis = .vertical
        content.spacing = Theme.Space.s4

        search.placeholder = "组织里的人"
        search.font = Theme.font(.body)
        search.adjustsFontForContentSizeCategory = true
        search.clearButtonMode = .whileEditing
        search.returnKeyType = .done
        search.accessibilityLabel = "找人"
        search.delegate = self
        search.addAction(UIAction { [weak self] _ in self?.render() }, for: .editingChanged)

        token = Store.shared.observe { [weak self] in self?.render() }
        render()
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        textField.resignFirstResponder()
        return true
    }

    /// 上次画出来的内容，没变不重画，免得按着的按钮被换掉。
    private var shown: Int?
    private var project: Project? { Store.shared.project(id: projectId) }
    private var me: String? { Store.shared.members.first(where: \.current)?.id }

    private func render() {
        guard let project else {
            dismiss(animated: true)
            return
        }
        var key = Hasher()
        key.combine(project)
        key.combine(Store.shared.members)
        key.combine(search.text)
        let shownNow = key.finalize()
        guard shownNow != shown else { return }
        shown = shownNow
        titleLabel.text = project.name
        // 搜索框不能跟着重建，不然打字时键盘会收起来。
        content.arrangedSubviews.forEach { if $0 !== search.superview?.superview { $0.removeFromSuperview() } }
        if project.isEveryone {
            if project.mayManage == true { content.addArrangedSubview(modeGroup(project, detail: "Pupu 不自己动手，事情交给各个空间去做")) }
            return
        }
        let owner = project.isOwner(me)
        if owner { content.insertArrangedSubview(searchBox(), at: 0) }

        let query = (search.text ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        let members = Store.shared.members
        let inSpace = members.filter { project.memberIds.contains($0.id) }
        let others = owner ? members.filter { !project.memberIds.contains($0.id) } : []
        let listed = (inSpace + others).filter { member in
            query.isEmpty || member.displayName.lowercased().contains(query) || member.email.lowercased().contains(query)
        }
        var rows: [UIView] = []
        for member in listed {
            let avatar = UIImageView(image: Avatars.round(
                Avatars.shared.image(member.avatar),
                letter: Avatars.letter(member.displayName),
                size: Theme.Size.avatar,
                pixelArt: Avatars.isPixelArt(member.avatar)
            ))
            var trailing: [UIView] = []
            if member.id == project.ownerId {
                trailing.append(UILabel(text: "建的人", style: .subheadline, color: Theme.inkMuted))
            } else if owner, project.memberIds.contains(member.id) {
                trailing.append(chip("移出", prominent: false) { [weak self] in self?.change(["kind": "remove", "memberId": member.id]) })
            } else if owner {
                trailing.append(chip("邀请", prominent: true) { [weak self] in self?.change(["kind": "add", "memberId": member.id]) })
            }
            rows.append(SheetRow(leading: avatar, title: member.displayName, trailing: trailing, height: 56, action: nil))
        }
        if rows.isEmpty {
            rows.append(SheetRow(leading: nil, title: query.isEmpty ? "还没有成员" : "组织里没有这个人", action: nil))
        }
        content.addArrangedSubview(SheetGroup(rows, separatorInset: 60))

        guard owner else { return }
        let label = UILabel(text: "谁看得到", style: .footnote, color: Theme.inkMuted)
        label.font = Theme.font(.footnote, weight: .medium)
        let holder = UIView()
        holder.addSubview(label)
        label.pin(to: holder, insets: UIEdgeInsets(top: 0, left: Theme.Space.s1, bottom: 0, right: 0))
        content.addArrangedSubview(holder)
        content.setCustomSpacing(Theme.Space.s1, after: holder)
        let level = project.level ?? "L2"
        let options: [(String, String, String)] = [
            ("L3", "只有成员", "成员在自己的 Pupu 里也问得到"),
            ("L2", "全组织", "组织里谁都能进来看"),
            ("L4", "机密", "只在这个空间里说，Pupu 不往外带")
        ]
        let radios = options.map { value, title, detail -> UIView in
            let on = value == level || (value == "L2" && level == "L1")
            let mark = UIImageView(image: UIImage(systemName: on ? "largecircle.fill.circle" : "circle"))
            mark.tintColor = on ? Theme.ink : Theme.inkMuted
            mark.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .title3)
            mark.setContentHuggingPriority(.required, for: .horizontal)
            let row = SheetRow(leading: mark, title: title, detail: detail, height: 56) { [weak self] in
                guard !on else { return }
                self?.change(["kind": "level", "level": value])
            }
            row.accessibilityTraits = on ? [.button, .selected] : .button
            return row
        }
        let group = SheetGroup(radios, separatorInset: 48)
        group.accessibilityLabel = "谁看得到"
        content.addArrangedSubview(group)
        content.addArrangedSubview(modeGroup(project, detail: "Pupu 不自己动手，事情交给子会话去做"))
    }

    /// 只派活：默认关，开了 Pupu 只把事派给子会话。
    private func modeGroup(_ project: Project, detail: String) -> UIView {
        let toggle = UISwitch()
        toggle.isOn = project.delegateOnly
        toggle.onTintColor = Theme.action
        toggle.accessibilityLabel = "只派活"
        toggle.addAction(UIAction { [weak self, weak toggle] _ in
            guard let toggle else { return }
            self?.change(["kind": "mode", "mode": toggle.isOn ? "coordinator" : "direct"])
        }, for: .valueChanged)
        toggle.accessibilityHint = detail
        let row = SheetRow(leading: nil, title: "只派活", detail: detail, trailing: [toggle], height: 64, action: nil)
        // VoiceOver 直接落在开关上。
        row.isAccessibilityElement = false
        return SheetGroup([row])
    }

    private func searchBox() -> UIView {
        if let box = search.superview?.superview { return box }
        let glass = UIImageView(image: UIImage(systemName: "magnifyingglass"))
        glass.tintColor = Theme.inkMuted
        glass.setContentHuggingPriority(.required, for: .horizontal)
        let row = UIStackView(arrangedSubviews: [glass, search])
        row.spacing = Theme.Space.s2
        row.alignment = .center
        let box = UIView()
        box.backgroundColor = .secondarySystemGroupedBackground
        box.layer.cornerRadius = Theme.Radius.tag
        box.layer.cornerCurve = .continuous
        box.addSubview(row)
        row.pin(to: box, insets: UIEdgeInsets(top: 0, left: Theme.Space.s3, bottom: 0, right: Theme.Space.s2))
        box.heightAnchor.constraint(equalToConstant: Theme.Size.control).isActive = true
        return box
    }

    private func chip(_ title: String, prominent: Bool, action: @escaping () -> Void) -> UIButton {
        var config = prominent ? UIButton.Configuration.filled() : UIButton.Configuration.plain()
        config.title = title
        config.cornerStyle = .capsule
        config.baseBackgroundColor = Theme.action
        config.baseForegroundColor = prominent ? Theme.onAction : Theme.inkMuted
        config.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 14, bottom: 6, trailing: 14)
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = Theme.font(.subheadline, weight: .semibold)
            return attributes
        }
        let button = UIButton(configuration: config)
        button.setContentHuggingPriority(.required, for: .horizontal)
        button.addAction(UIAction { _ in action() }, for: .primaryActionTriggered)
        return button
    }

    private func change(_ body: [String: String]) {
        guard !busy, let api = Store.shared.api else { return }
        busy = true
        UISelectionFeedbackGenerator().selectionChanged()
        Task {
            do {
                try await api.changeSpace(projectId, body)
            } catch {
                let alert = UIAlertController(title: "没做成", message: error.localizedDescription, preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "好", style: .default))
                present(alert, animated: true)
            }
            busy = false
            // 没做成时开关已经拨过去了：按现在的数据重画一次。
            shown = nil
            render()
            Store.shared.refresh()
        }
    }
}

/// 子会话页：主会话派出去的一件事。顶上是名字和状态，第一条是「从「空间」派来」，人可以接着说。
final class ChildSessionViewController: UIViewController {
    private let projectId: String
    private let session: String
    private let chat: ChatViewController
    private let name = UILabel(style: .headline)
    private let status = UILabel(style: .footnote, color: Theme.inkSkyMuted)
    private let dotHolder = UIView()
    private var token: StoreToken?

    init(identity: Identity, project: Project, child: SpaceChild) {
        projectId = project.id
        session = child.session
        chat = ChatViewController(
            identity: identity,
            session: child.session,
            placeholder: "接着说这件事",
            projectTags: false,
            opening: .child,
            openProject: { _ in }
        )
        chat.handoffHeading = "从「\(project.name)」派来"
        super.init(nibName: nil, bundle: nil)
        navigationItem.backButtonDisplayMode = .minimal
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        let appearance = UINavigationBarAppearance()
        appearance.configureWithTransparentBackground()
        navigationItem.standardAppearance = appearance
        navigationItem.scrollEdgeAppearance = appearance
        navigationItem.compactAppearance = appearance

        name.textColor = Theme.inkSky
        name.font = Theme.font(.headline, weight: .semibold)
        name.lineBreakMode = .byTruncatingTail
        let line = UIStackView(arrangedSubviews: [dotHolder, status])
        line.spacing = 6
        line.alignment = .center
        let title = UIStackView(arrangedSubviews: [name, line])
        title.axis = .vertical
        title.alignment = .leading
        title.spacing = 2
        title.isAccessibilityElement = true
        title.accessibilityTraits = .header
        navigationItem.titleView = title

        addChild(chat)
        view.addSubview(chat.view)
        chat.view.pin(to: view)
        chat.didMove(toParent: self)
        setContentScrollView(chat.contentScrollView(for: .top), for: .top)
        token = Store.shared.observe { [weak self] in self?.update() }
        update()
    }

    private func update() {
        guard let project = Store.shared.project(id: projectId), let child = project.child(session: session) else {
            // 看不到这个空间了（被移出、空间收窄）：回到上一页。
            if Store.shared.loaded, Store.shared.project(id: projectId) == nil { navigationController?.popViewController(animated: true) }
            return
        }
        name.text = child.title
        let when = child.reportedAt.map { " · \(Ago.text($0))" } ?? ""
        status.text = child.status.label + (child.status == .done ? when : "")
        dotHolder.subviews.forEach { $0.removeFromSuperview() }
        let dot = childDot(child.status)
        dotHolder.addSubview(dot)
        dot.pin(to: dotHolder)
        navigationItem.titleView?.accessibilityLabel = "\(child.title)，\(status.text ?? "")"
    }
}
