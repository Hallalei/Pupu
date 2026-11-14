import UIKit

// 空间的几个界面，照规范 SpaceSwitcher、SpaceSettings、SubSession：切换 sheet、空间设置 sheet、子会话页。
// 接口见云端 server.ts 的 /api/spaces。和网页 Spaces.tsx 一起改。

/// 成员的头像叠在一起（规范 Avatar「叠在一起」）：22，后一个压前一个 7，每个外描 2pt 所在的底色，最多 3 个，再多写「+N」。
final class SpaceAvatarStack: UIStackView {
    private let size: CGFloat
    private let ring: UIColor
    private let fill: UIColor

    /// ring：外描的颜色，取头像下面的底色。fill：没换头像的首字垫的圆，要和 ring 分得开。
    init(size: CGFloat = Theme.Size.avatarSmall, ring: UIColor, fill: UIColor = Theme.surfaceInset) {
        self.size = size
        self.ring = ring
        self.fill = fill
        super.init(frame: .zero)
        spacing = -7
        alignment = .center
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
        isAccessibilityElement = false
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (stack: SpaceAvatarStack, _: UITraitCollection) in
            for view in stack.arrangedSubviews where view is UIImageView {
                view.layer.borderColor = stack.ring.resolvedColor(with: stack.traitCollection).cgColor
            }
        }
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
                pixelArt: Avatars.isPixelArt(member.avatar),
                fill: fill
            )
            let view = UIImageView(image: image)
            view.layer.cornerRadius = size / 2
            view.layer.borderWidth = 2
            view.layer.borderColor = ring.resolvedColor(with: traitCollection).cgColor
            view.clipsToBounds = true
            view.widthAnchor.constraint(equalToConstant: size).isActive = true
            view.heightAnchor.constraint(equalToConstant: size).isActive = true
            addArrangedSubview(view)
        }
        if members.count > 3 {
            let more = UILabel(text: "+\(members.count - 3)", style: .caption, color: Theme.inkMuted)
            addArrangedSubview(more)
            setCustomSpacing(Theme.Space.s1, after: arrangedSubviews[arrangedSubviews.count - 2])
        }
        isHidden = members.isEmpty
    }
}

/// 空间行右边的成员：全组织看得到的是楼，别的是成员头像叠。
private func membersMark(_ project: Project, ring: UIColor, fill: UIColor) -> UIView {
    if project.isEveryone || project.isOpen {
        let icon = UIImageView(image: UIImage(systemName: "building.2", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17)))
        icon.tintColor = Theme.inkMuted
        icon.isAccessibilityElement = false
        icon.setContentHuggingPriority(.required, for: .horizontal)
        return icon
    }
    let stack = SpaceAvatarStack(ring: ring, fill: fill)
    stack.show(project.memberIds)
    return stack
}

/// 子会话状态的小圆点：等批是 warning，在做是 action，做完是 online，还没开始是 offline。旁边一定写字。
func childDot(_ status: SpaceChild.Status, size: CGFloat = 8) -> UIView {
    let dot = UIView()
    dot.backgroundColor = switch status {
    case .waiting: Theme.warning
    case .working: Theme.action
    case .done: Theme.online
    case .idle: Theme.offline
    }
    dot.layer.cornerRadius = size / 2
    dot.translatesAutoresizingMaskIntoConstraints = false
    dot.widthAnchor.constraint(equalToConstant: size).isActive = true
    dot.heightAnchor.constraint(equalToConstant: size).isActive = true
    return dot
}

/// sheet 里的一组：`surface-inset` 底、`radius-row`，行之间 1pt `line`。
private final class SheetGroup: UIView {
    init(_ rows: [UIView], separatorInset: CGFloat = 48) {
        super.init(frame: .zero)
        backgroundColor = Theme.surfaceInset
        layer.cornerRadius = Theme.Radius.row
        layer.cornerCurve = .continuous
        clipsToBounds = true
        let stack = UIStackView()
        stack.axis = .vertical
        addSubview(stack)
        stack.pin(to: self)
        for (index, row) in rows.enumerated() {
            if index > 0, !(row is SheetSubRow) {
                let holder = UIView()
                let line = UIView()
                line.backgroundColor = Theme.line
                holder.addSubview(line)
                line.translatesAutoresizingMaskIntoConstraints = false
                NSLayoutConstraint.activate([
                    holder.heightAnchor.constraint(equalToConstant: 1),
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

/// sheet 里的一行：左边图标，中间名字，右边标记。能点的按下时铺一层 `line`。
private class SheetRow: UIControl {
    private let action: (() -> Void)?

    init(leading: UIView?, title: String, style: Theme.Text = .body, weight: UIFont.Weight? = nil, detail: String? = nil, trailing: [UIView] = [], height: CGFloat = 52, insetLeading: CGFloat = Theme.Space.s4, spacing: CGFloat = Theme.Space.s3, action: (() -> Void)?) {
        self.action = action
        super.init(frame: .zero)
        let name = UILabel(text: title, style: style)
        if let weight { name.font = Theme.font(style, weight: weight) }
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
        let row = UIStackView()
        row.spacing = spacing
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
        didSet { backgroundColor = isHighlighted && action != nil ? Theme.line : .clear }
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

/// 挂在空间下面的子会话：缩进，高 40，状态圆点 + 名字 + 状态词。前面不画分隔线。
private final class SheetSubRow: SheetRow {}

/// 当前的那一行打勾（16），别的留出同样宽，名字对齐。
private func currentMark(_ on: Bool) -> UIView {
    let check = UIImageView(image: UIImage(systemName: "checkmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .semibold)))
    check.tintColor = Theme.ink
    check.contentMode = .center
    check.alpha = on ? 1 : 0
    check.isAccessibilityElement = false
    check.widthAnchor.constraint(equalToConstant: 16).isActive = true
    return check
}

/// 未读：6 的墨色圆点，跟着加粗的名字。
private func unreadDot() -> UIView {
    let dot = UIView()
    dot.backgroundColor = Theme.ink
    dot.layer.cornerRadius = 3
    dot.isAccessibilityElement = false
    dot.translatesAutoresizingMaskIntoConstraints = false
    dot.widthAnchor.constraint(equalToConstant: 6).isActive = true
    dot.heightAnchor.constraint(equalToConstant: 6).isActive = true
    return dot
}

/// sheet 的内容：竖着一列，左右 14，组和组之间 14。
private func sheetPage(in view: UIView, keyboardDismiss: Bool = false) -> UIStackView {
    view.backgroundColor = Theme.surfaceSheet
    let scroll = UIScrollView()
    scroll.alwaysBounceVertical = true
    if keyboardDismiss { scroll.keyboardDismissMode = .interactive }
    view.addSubview(scroll)
    scroll.pin(to: view)
    let page = UIStackView()
    page.axis = .vertical
    page.spacing = 14
    page.translatesAutoresizingMaskIntoConstraints = false
    scroll.addSubview(page)
    NSLayoutConstraint.activate([
        page.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: Theme.Space.s5),
        page.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -Theme.Space.s6),
        page.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: 14),
        page.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -14)
    ])
    return page
}

/// 切换 sheet（规范 SpaceSwitcher）：「我的 Pupu」和「Artifacts」一组；「空间」和「新空间」，全员在第一个，
/// 每个空间下面挂着正在做和等你批准的子会话；最底下是自己，点开设置。
final class SpaceSwitcherViewController: UIViewController {
    private let current: String?
    /// 现在在 Artifacts。
    private let docs: Bool
    /// 没有私聊时不列「我的 Pupu」：那条就是全员，在空间里。
    private let showsPupu: Bool
    private let pupuUnread: Bool
    private let everyoneUnread: Bool
    private let openPupu: () -> Void
    private let openDocs: () -> Void
    private let open: (Project) -> Void
    private let openChild: (Project, SpaceChild) -> Void
    private let create: () -> Void
    private let openSettings: () -> Void
    private var content: UIStackView!
    private var token: StoreToken?

    /// current：现在在的空间，在「我的 Pupu」和 Artifacts 时是 nil；docs：现在在 Artifacts。
    init(current: String?, docs: Bool = false, showsPupu: Bool = true, pupuUnread: Bool, everyoneUnread: Bool, openPupu: @escaping () -> Void, openDocs: @escaping () -> Void, open: @escaping (Project) -> Void, openChild: @escaping (Project, SpaceChild) -> Void, create: @escaping () -> Void, openSettings: @escaping () -> Void) {
        self.current = current
        self.docs = docs
        self.showsPupu = showsPupu
        self.pupuUnread = pupuUnread
        self.everyoneUnread = everyoneUnread
        self.openPupu = openPupu
        self.openDocs = openDocs
        self.open = open
        self.openChild = openChild
        self.create = create
        self.openSettings = openSettings
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        content = sheetPage(in: view)
        token = Store.shared.observe { [weak self] in self?.render() }
        render()
    }

    /// 上次画出来的内容。Store 一有动静就会叫，内容没变不重画：重画会把手指正按着的那一行换掉，点不动。
    private var shown: Int?

    private func render() {
        let pupu = Avatars.shared.pupu()
        let me = Store.shared.members.first(where: \.current)
        var key = Hasher()
        key.combine(Store.shared.spaces)
        key.combine(pupu.image != nil)
        key.combine(me)
        key.combine(Avatars.shared.image(me?.avatar) != nil)
        let shownNow = key.finalize()
        guard shownNow != shown else { return }
        shown = shownNow
        content.arrangedSubviews.forEach { $0.removeFromSuperview() }

        let avatar = UIImageView(image: Avatars.round(pupu.image, letter: "P", size: 30, pixelArt: pupu.pixelArt))
        let pupuRow = SheetRow(
            leading: avatar,
            title: "我的 Pupu",
            style: .headline,
            trailing: (pupuUnread ? [unreadDot()] : []) + [currentMark(current == nil && !docs)]
        ) { [weak self] in self?.finish { $0.openPupu() } }
        if current == nil && !docs { pupuRow.accessibilityValue = "当前" } else if pupuUnread { pupuRow.accessibilityValue = "有新消息" }
        let docsIcon = UIImageView(image: UIImage(systemName: "doc.text", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18)))
        docsIcon.tintColor = Theme.inkMuted
        docsIcon.contentMode = .center
        docsIcon.widthAnchor.constraint(equalToConstant: 30).isActive = true
        let docsRow = SheetRow(leading: docsIcon, title: "Artifacts", trailing: [currentMark(docs)]) { [weak self] in
            self?.finish { $0.openDocs() }
        }
        content.addArrangedSubview(SheetGroup(showsPupu ? [pupuRow, docsRow] : [docsRow], separatorInset: 62))

        var config = UIButton.Configuration.plain()
        config.title = "新空间"
        config.image = UIImage(systemName: "plus", withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .semibold))
        config.imagePadding = Theme.Space.s1
        config.contentInsets = .zero
        config.baseForegroundColor = Theme.ink
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = Theme.font(.subheadline, weight: .semibold)
            return attributes
        }
        let button = UIButton(configuration: config)
        button.heightAnchor.constraint(equalToConstant: Theme.Size.control).isActive = true
        button.addAction(UIAction { [weak self] _ in self?.finish { $0.create() } }, for: .primaryActionTriggered)
        let header = UIStackView(arrangedSubviews: [UILabel(text: "空间", style: .footnote, color: Theme.inkMuted), UIView(), button])
        header.alignment = .center
        header.isLayoutMarginsRelativeArrangement = true
        header.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 0, leading: Theme.Space.s1, bottom: 0, trailing: Theme.Space.s1)
        content.addArrangedSubview(header)
        content.setCustomSpacing(0, after: header)

        var rows: [UIView] = []
        for project in Store.shared.spaces {
            let selected = project.id == current
            let fresh = project.isEveryone && everyoneUnread
            let mark = SpaceMarkView()
            mark.show(project)
            var trailing: [UIView] = fresh ? [unreadDot()] : []
            trailing.append(membersMark(project, ring: Theme.surfaceInset, fill: Theme.surface))
            trailing.append(currentMark(selected))
            let row = SheetRow(leading: mark, title: project.name, weight: selected || fresh ? .semibold : nil, trailing: trailing) { [weak self] in
                self?.finish { $0.open(project) }
            }
            if selected { row.accessibilityValue = "当前" } else if fresh { row.accessibilityValue = "有新消息" }
            rows.append(row)
            for child in project.spaceChildren where child.status == .working || child.status == .waiting {
                let status = UILabel(text: child.status.label, style: .footnote, color: Theme.inkMuted)
                let sub = SheetSubRow(leading: childDot(child.status), title: child.title, style: .subheadline, trailing: [status], height: 40, insetLeading: 48, spacing: 10) { [weak self] in
                    self?.finish { $0.openChild(project, child) }
                }
                sub.accessibilityLabel = "\(child.title)，\(child.status.label)"
                rows.append(sub)
            }
        }
        if !rows.isEmpty { content.addArrangedSubview(SheetGroup(rows)) }

        let name = me?.displayName ?? "设置"
        let mine = UIImageView(image: Avatars.round(
            Avatars.shared.image(me?.avatar),
            letter: Avatars.letter(me?.displayName ?? "我"),
            size: 30,
            pixelArt: Avatars.isPixelArt(me?.avatar),
            fill: Theme.surface
        ))
        let chevron = UIImageView(image: UIImage(systemName: "chevron.right", withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .semibold)))
        chevron.tintColor = Theme.inkFaint
        let settings = SheetRow(leading: mine, title: name, trailing: [chevron]) { [weak self] in self?.finish { $0.openSettings() } }
        settings.accessibilityLabel = "设置"
        content.addArrangedSubview(SheetGroup([settings]))
    }

    /// 先收起 sheet 再做，接下来要弹的（新空间的对话框、子会话页、设置）不会被 sheet 挡住。
    private func finish(_ then: @escaping (SpaceSwitcherViewController) -> Void) {
        UISelectionFeedbackGenerator().selectionChanged()
        dismiss(animated: true) { then(self) }
    }
}

/// 空间设置（规范 SpaceSettings）：大号标记和名字、色板、图标、找人、成员、谁看得到、只派活。
/// 颜色和图标是空间的主人改，全员是组织的创建者；拉人、移人、改范围只有主人；别人只看名单。全员没有成员和范围。
final class SpaceSettingsViewController: UIViewController, UITextFieldDelegate {
    private let projectId: String
    private var page: UIStackView!
    private let mark = SpaceMarkView(large: true)
    private let titleLabel = UILabel(style: .title)
    private let swatches = UIStackView()
    private var swatchViews: [(color: Theme.SpaceColor, view: SwatchControl)] = []
    private let iconStrip = FadeTrailingView()
    private var iconViews: [(icon: Theme.SpaceIcon, view: SwatchControl)] = []
    private let search = FieldView()
    /// 成员、谁看得到、只派活：跟着数据重建。上面几块不重建，图标滑到哪、打到一半的字都留着。
    private let dynamic = UIStackView()
    private let failureLabel = UILabel(style: .subheadline, color: Theme.dangerInk, lines: 0)
    /// 点了颜色、图标马上换上，不等云端回来；云端回来一样了就不用再记。
    private var pickedColor: Theme.SpaceColor?
    private var pickedIcon: Theme.SpaceIcon?
    private var busy = false
    private var failure: String?
    private var token: StoreToken?

    init(projectId: String) {
        self.projectId = projectId
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        page = sheetPage(in: view, keyboardDismiss: true)

        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.accessibilityTraits = .header
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let close = UIButton.round(image: "xmark", label: "关闭")
        close.addAction(UIAction { [weak self] _ in self?.dismiss(animated: true) }, for: .primaryActionTriggered)
        let header = UIStackView(arrangedSubviews: [mark, titleLabel, close])
        header.spacing = 10
        header.alignment = .center
        page.addArrangedSubview(header)

        for color in Theme.SpaceColor.allCases {
            let swatch = SwatchControl(side: 30, edge: true)
            swatch.backgroundColor = color.swatch
            swatch.accessibilityLabel = color.name
            swatch.addAction(UIAction { [weak self] _ in self?.pick(color: color) }, for: .primaryActionTriggered)
            swatches.addArrangedSubview(swatch)
            swatchViews.append((color, swatch))
        }
        swatches.distribution = .equalSpacing
        swatches.isLayoutMarginsRelativeArrangement = true
        swatches.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 6, leading: Theme.Space.s2, bottom: 6, trailing: Theme.Space.s2)
        swatches.accessibilityLabel = "空间颜色"
        page.addArrangedSubview(swatches)

        for icon in Theme.SpaceIcon.allCases {
            let button = SwatchControl(side: 36, edge: false)
            button.image.image = icon.image
            button.accessibilityLabel = icon.name
            button.addAction(UIAction { [weak self] _ in self?.pick(icon: icon) }, for: .primaryActionTriggered)
            iconStrip.row.addArrangedSubview(button)
            iconViews.append((icon, button))
        }
        iconStrip.accessibilityLabel = "空间图标"
        page.addArrangedSubview(iconStrip)

        search.placeholder = "组织里的人"
        search.clearButtonMode = .whileEditing
        search.returnKeyType = .done
        search.accessibilityLabel = "找人"
        search.delegate = self
        let glass = UIImageView(image: UIImage(systemName: "magnifyingglass", withConfiguration: UIImage.SymbolConfiguration(pointSize: 15)))
        glass.tintColor = Theme.inkMuted
        glass.contentMode = .center
        glass.frame = CGRect(x: Theme.Space.s3, y: 0, width: 16, height: Theme.Size.control)
        let holder = UIView(frame: CGRect(x: 0, y: 0, width: 28, height: Theme.Size.control))
        holder.addSubview(glass)
        search.leftView = holder
        search.leftViewMode = .always
        search.addAction(UIAction { [weak self] _ in self?.render() }, for: .editingChanged)
        page.addArrangedSubview(search)

        dynamic.axis = .vertical
        dynamic.spacing = 14
        page.addArrangedSubview(dynamic)
        failureLabel.isHidden = true
        page.addArrangedSubview(failureLabel)

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
        let mine = project.isEveryone ? project.mayManage == true : project.isOwner(me)
        let storedColor = Theme.SpaceColor(id: project.color)
        let storedIcon = project.icon.flatMap(Theme.SpaceIcon.init(rawValue:))
        if pickedColor == storedColor { pickedColor = nil }
        if pickedIcon == storedIcon { pickedIcon = nil }
        let color = pickedColor ?? storedColor
        let icon = pickedIcon ?? storedIcon

        titleLabel.text = project.name
        mark.show(color: color.rawValue, icon: icon?.rawValue, name: project.name)
        showLookPickers(mine)
        for item in swatchViews {
            item.view.on = item.color == color
            item.view.isEnabled = !busy
        }
        for item in iconViews {
            let on = item.icon == icon
            item.view.on = on
            item.view.backgroundColor = on ? color.mark : Theme.surfaceInset
            item.view.image.tintColor = on ? Theme.onMark : Theme.ink
            item.view.isEnabled = !busy
        }
        let searching = mine && !project.isEveryone
        if search.isHidden == searching { search.isHidden = !searching }
        failureLabel.text = failure
        if failureLabel.isHidden == (failure != nil) { failureLabel.isHidden = failure == nil }

        var key = Hasher()
        key.combine(project)
        key.combine(Store.shared.members)
        key.combine(search.text)
        key.combine(busy)
        let shownNow = key.finalize()
        guard shownNow != shown else { return }
        shown = shownNow
        dynamic.arrangedSubviews.forEach { $0.removeFromSuperview() }
        if !project.isEveryone { dynamic.addArrangedSubview(membersGroup(project, mine: mine)) }
        if mine && !project.isEveryone { levelGroup(project).forEach(dynamic.addArrangedSubview) }
        if mine {
            let detail = project.isEveryone ? "Pupu 不自己动手，事情交给各个空间去做" : "Pupu 不自己动手，事情交给子会话去做"
            dynamic.addArrangedSubview(modeGroup(project, detail: detail))
        }
    }

    /// 色板和图标只给能改的人看。
    private func showLookPickers(_ visible: Bool) {
        if swatches.isHidden == visible { swatches.isHidden = !visible }
        if iconStrip.isHidden == visible { iconStrip.isHidden = !visible }
    }

    /// 成员：头像 32、名字；建的人写「建的人」，主人看别人有「移出」，搜到的人有「邀请」。
    private func membersGroup(_ project: Project, mine: Bool) -> UIView {
        let query = (search.text ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        let inSpace = Set(project.memberIds)
        let people = Store.shared.members
            .filter { mine || inSpace.contains($0.id) }
            .filter { query.isEmpty || $0.displayName.lowercased().contains(query) || $0.email.lowercased().contains(query) }
            .sorted { a, b in
                let owner = (a.id == project.ownerId ? 1 : 0, b.id == project.ownerId ? 1 : 0)
                if owner.0 != owner.1 { return owner.0 > owner.1 }
                return (inSpace.contains(a.id) ? 1 : 0) > (inSpace.contains(b.id) ? 1 : 0)
            }
        var rows: [UIView] = []
        for member in people {
            let avatar = UIImageView(image: Avatars.round(
                Avatars.shared.image(member.avatar),
                letter: Avatars.letter(member.displayName),
                size: 32,
                pixelArt: Avatars.isPixelArt(member.avatar),
                fill: Theme.surface
            ))
            var trailing: [UIView] = []
            if member.id == project.ownerId {
                trailing.append(UILabel(text: "建的人", style: .subheadline, color: Theme.inkMuted))
            } else if mine, inSpace.contains(member.id) {
                trailing.append(chip("移出", prominent: false) { [weak self] in self?.change(["kind": "remove", "memberId": member.id]) })
            } else if mine {
                trailing.append(chip("邀请", prominent: true) { [weak self] in self?.change(["kind": "add", "memberId": member.id]) })
            }
            rows.append(SheetRow(leading: avatar, title: member.displayName, trailing: trailing, action: nil))
        }
        if rows.isEmpty {
            rows.append(SheetRow(leading: nil, title: query.isEmpty ? "还没有成员" : "组织里没有这个人", action: nil))
        }
        return SheetGroup(rows, separatorInset: 60)
    }

    /// 谁看得到：三选一，系统单选的样子，选中的是 `ink`。
    private func levelGroup(_ project: Project) -> [UIView] {
        let label = UILabel(text: "谁看得到", style: .footnote, color: Theme.inkMuted)
        let holder = UIView()
        holder.addSubview(label)
        label.pin(to: holder, insets: UIEdgeInsets(top: 0, left: Theme.Space.s1, bottom: 0, right: 0))
        let level = project.level ?? "L2"
        let options: [(String, String, String)] = [
            ("L3", "只有成员", "成员在自己的 Pupu 里也问得到"),
            ("L2", "全组织", "组织里谁都能进来看"),
            ("L4", "机密", "只在这个空间里说，Pupu 不往外带")
        ]
        let radios = options.map { value, title, detail -> UIView in
            let on = value == level || (value == "L2" && level == "L1")
            let radio = UIImageView(image: UIImage(systemName: on ? "largecircle.fill.circle" : "circle", withConfiguration: UIImage.SymbolConfiguration(pointSize: 20)))
            radio.tintColor = on ? Theme.ink : Theme.inkFaint
            let row = SheetRow(leading: radio, title: title, detail: detail, height: 56) { [weak self] in
                guard !on else { return }
                self?.change(["kind": "level", "level": value])
            }
            row.accessibilityTraits = on ? [.button, .selected] : .button
            row.isEnabled = !busy
            return row
        }
        let group = SheetGroup(radios)
        group.accessibilityLabel = "谁看得到"
        // 组标题和组之间近一点。
        let column = UIStackView(arrangedSubviews: [holder, group])
        column.axis = .vertical
        column.spacing = Theme.Space.s2
        return [column]
    }

    /// 只派活：默认关，开了 Pupu 只把事派出去。
    private func modeGroup(_ project: Project, detail: String) -> UIView {
        let toggle = SwitchView()
        toggle.isOn = project.delegateOnly
        toggle.isEnabled = !busy
        toggle.accessibilityLabel = "只派活"
        toggle.accessibilityHint = detail
        toggle.addAction(UIAction { [weak self, weak toggle] _ in
            guard let toggle else { return }
            self?.change(["kind": "mode", "mode": toggle.isOn ? "coordinator" : "direct"])
        }, for: .valueChanged)
        let row = SheetRow(leading: nil, title: "只派活", detail: detail, trailing: [toggle], height: 64, action: nil)
        // VoiceOver 直接落在开关上。
        row.isAccessibilityElement = false
        return SheetGroup([row])
    }

    /// 行里的按钮：高 32，左右 14，`subheadline` 600。「邀请」是主操作（一屏可以有几个，这里例外），「移出」是轻按钮。
    private func chip(_ title: String, prominent: Bool, action: @escaping () -> Void) -> UIButton {
        var config = prominent ? UIButton.Configuration.filled() : UIButton.Configuration.plain()
        config.title = title
        config.cornerStyle = .capsule
        config.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 14, bottom: 0, trailing: 14)
        let fill = prominent ? Theme.action : UIColor.clear
        let ink = prominent ? Theme.onAction : Theme.inkMuted
        config.paint(fill: fill, ink: ink, style: .subheadline)
        let button = UIButton(configuration: config)
        button.configurationUpdateHandler = { button in
            let on = button.isEnabled
            button.configuration?.paint(
                fill: prominent ? (on ? Theme.action : Theme.actionOff) : (button.isHighlighted ? Theme.line : .clear),
                ink: prominent ? (on ? Theme.onAction : Theme.inkMuted) : Theme.inkMuted,
                pressed: prominent && button.isHighlighted,
                style: .subheadline
            )
        }
        button.isEnabled = !busy
        button.heightAnchor.constraint(equalToConstant: 32).isActive = true
        button.addAction(UIAction { _ in action() }, for: .primaryActionTriggered)
        return button
    }

    private func pick(color: Theme.SpaceColor) {
        guard !busy else { return }
        pickedColor = color
        change(["kind": "color", "color": color.rawValue])
    }

    private func pick(icon: Theme.SpaceIcon) {
        guard !busy else { return }
        pickedIcon = icon
        change(["kind": "icon", "icon": icon.rawValue])
    }

    private func change(_ body: [String: String]) {
        guard !busy, let api = Store.shared.api else { return }
        busy = true
        failure = nil
        UISelectionFeedbackGenerator().selectionChanged()
        render()
        Task {
            do {
                try await api.changeSpace(projectId, body)
            } catch {
                failure = error.localizedDescription
                pickedColor = nil
                pickedIcon = nil
            }
            busy = false
            // 没做成时开关已经拨过去了：按现在的数据重画一次。
            shown = nil
            render()
            Store.shared.refresh()
        }
    }
}

/// 色板和图标的圆：选中的外面隔 2 再描 2 的 `ink`（中间露出 sheet 底）；色板没选中时往里描一圈很淡的边。
private final class SwatchControl: TapControl {
    let image = UIImageView()
    private let ring = CAShapeLayer()
    private let edge: Bool

    init(side: CGFloat, edge: Bool) {
        self.edge = edge
        super.init(frame: .zero)
        layer.cornerRadius = side / 2
        ring.fillColor = nil
        ring.lineWidth = 2
        ring.isHidden = true
        layer.addSublayer(ring)
        image.contentMode = .scaleToFill
        image.layer.magnificationFilter = .nearest
        image.isUserInteractionEnabled = false
        image.translatesAutoresizingMaskIntoConstraints = false
        addSubview(image)
        translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: side),
            heightAnchor.constraint(equalToConstant: side),
            image.widthAnchor.constraint(equalToConstant: 16),
            image.heightAnchor.constraint(equalToConstant: 16),
            image.centerXAnchor.constraint(equalTo: centerXAnchor),
            image.centerYAnchor.constraint(equalTo: centerYAnchor)
        ])
        isAccessibilityElement = true
        updateColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: SwatchControl, _: UITraitCollection) in
            view.updateColors()
        }
    }

    required init?(coder: NSCoder) { fatalError() }

    var on = false {
        didSet {
            guard on != oldValue else { return }
            updateColors()
        }
    }

    private func updateColors() {
        ring.isHidden = !on
        ring.strokeColor = Theme.ink.resolvedColor(with: traitCollection).cgColor
        layer.borderWidth = edge && !on ? 1 : 0
        layer.borderColor = UIColor(white: 0, alpha: 0x0f / 255).cgColor
        accessibilityTraits = on ? [.button, .selected] : .button
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        ring.frame = bounds
        ring.path = UIBezierPath(ovalIn: bounds.insetBy(dx: -3, dy: -3)).cgPath
    }

    /// 色板 30、图标 36，点按区补到 44。
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        let grow = max(0, (Theme.Size.control - bounds.width) / 2)
        return bounds.insetBy(dx: -grow, dy: -grow).contains(point)
    }
}

/// 横着滑的一行图标，右边淡出。末尾留出淡出的那一段，滑到头最后一个也看得清。
private final class FadeTrailingView: UIView {
    let row = UIStackView()
    private let scroll = UIScrollView()
    private let fade = CAGradientLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        scroll.showsHorizontalScrollIndicator = false
        scroll.alwaysBounceHorizontal = true
        addSubview(scroll)
        scroll.pin(to: self)
        row.spacing = 10
        row.isLayoutMarginsRelativeArrangement = true
        row.directionalLayoutMargins = NSDirectionalEdgeInsets(top: Theme.Space.s1, leading: Theme.Space.s2, bottom: Theme.Space.s1, trailing: 56)
        row.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            row.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            row.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            row.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor)
        ])
        fade.colors = [UIColor.black.cgColor, UIColor.black.cgColor, UIColor.clear.cgColor]
        fade.locations = [0, 0.8, 1]
        fade.startPoint = CGPoint(x: 0, y: 0.5)
        fade.endPoint = CGPoint(x: 1, y: 0.5)
        layer.mask = fade
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        fade.frame = bounds
    }
}

/// 子会话页（规范 SubSession）：主会话派出去的一件事，整页推进去。窗框还是这个空间的颜色，上面一张会话卡。
/// 顶栏左边返回，中间名字和状态；第一条是「从「空间」派来」，人可以接着说。
final class ChildSessionViewController: UIViewController {
    private let projectId: String
    private let session: String
    private let chat: ChatViewController
    private let card = CardView()
    private let back: BarButton
    private let titleView = ChildTitleView()
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
        back = BarButton(image: "chevron.left", label: "回到「\(project.name)」")
        super.init(nibName: nil, bundle: nil)
        navigationItem.hidesBackButton = true
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Store.shared.project(id: projectId)?.frameColor ?? Theme.canvas
        let appearance = UINavigationBarAppearance()
        appearance.configureWithTransparentBackground()
        navigationItem.standardAppearance = appearance
        navigationItem.scrollEdgeAppearance = appearance
        navigationItem.compactAppearance = appearance
        navigationItem.leftBarButtonItem = back.barItem()
        navigationItem.titleView = titleView
        back.addAction(UIAction { [weak self] _ in self?.navigationController?.popViewController(animated: true) }, for: .primaryActionTriggered)

        card.placeAsSession(in: view)
        addChild(chat)
        card.contentView.addSubview(chat.view)
        chat.view.pin(to: card.contentView)
        chat.didMove(toParent: self)
        token = Store.shared.observe { [weak self] in self?.update() }
        update()
    }

    private func update() {
        guard let project = Store.shared.project(id: projectId), let child = project.child(session: session) else {
            // 看不到这个空间了（被移出、空间收窄）：回到上一页。
            if Store.shared.loaded, Store.shared.project(id: projectId) == nil { navigationController?.popViewController(animated: true) }
            return
        }
        titleView.show(child)
        view.backgroundColor = project.frameColor
    }
}
