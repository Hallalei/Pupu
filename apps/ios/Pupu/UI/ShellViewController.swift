import UIKit

/// 主界面：顶栏的两段切换（「我的 Pupu」私聊、项目），右边设置，项目页左边 ≡ 打开切换空间的 sheet，全员在里面第一个。
/// 电脑不在主界面上：列表、配对、远程控制都在设置里，Pupu 用电脑时对话里出一张电脑任务卡。
/// 顶栏下方是等你批准的请示（哪一页都在）和聊天段的「正在做」，出现时把页面内容往下挤，不盖住对话。
/// 空间名胶囊盖在内容上，不挤内容；胶囊上有成员头像，建的人还有「邀请」，点了打开邀请 sheet。
/// 一个主界面只属于一个身份：换了 Pupu 或者重新配对，RootViewController 整个换一个新的。
final class ShellViewController: UIViewController {
    private let settingsButton = UIBarButtonItem()
    private var avatarToken: NSObjectProtocol?
    private enum Section: Int {
        case chat, projects
    }

    /// 上次打开的项目，按身份记：`[身份: 项目 id]`，只留现在这个身份的。
    private static let lastProjectKey = "pupu.last-project"
    /// 每条聊天看到过的 lastAt，按身份记：`[身份: [session: lastAt]]`，只留现在这个身份的。
    /// 用云端的时间比，手机时钟不准也不会亮错。
    private static let seenKey = "pupu.chat-seen"

    private let identity: Identity
    private let segments = SectionSwitch(titles: ["Pupu", "项目"], selected: Section.chat.rawValue)
    private let container = UIView()
    private lazy var approvals = ApprovalStackView(relayout: { [weak self] in self?.relayoutTop() })
    private let pill = ProjectPill()
    private let top = PassThroughStackView()
    private var pillTop: NSLayoutConstraint!
    /// 顶栏下方那一叠占的高度，加给当前页面的安全区。
    private var topInset: CGFloat = 0
    /// 项目对话滚到了最新的消息：胶囊淡出。
    private var atLatest = false
    private var storeToken: StoreToken?

    private lazy var doing = DoingView(
        open: { [weak self] activity in self?.openActivity(activity) },
        relayout: { [weak self] in
            self?.view.setNeedsLayout()
            self?.view.layoutIfNeeded()
        }
    )
    private lazy var projectList = UIBarButtonItem(
        image: UIImage(systemName: "line.3.horizontal"),
        primaryAction: UIAction { [weak self] _ in self?.openSwitcher() }
    )
    /// 现在打开的空间。
    private var currentProject: String?
    /// 「我的 Pupu」那条聊天，留着，切回来不用等快照。
    private var ownChatView: ChatViewController?
    private var projectChat: ChatViewController?
    private lazy var noProject = NoProjectViewController(create: { [weak self] in self?.createProject() })
    private let loading = LoadingViewController()
    private var shown: UIViewController?

    init(identity: Identity) {
        self.identity = identity
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError() }

    /// 选中的那一段就是现在的页面，不另存一份。
    private var section: Section {
        Section(rawValue: segments.selectedIndex) ?? .chat
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear

        let appearance = UINavigationBarAppearance()
        appearance.configureWithTransparentBackground()
        navigationItem.standardAppearance = appearance
        navigationItem.scrollEdgeAppearance = appearance
        navigationItem.compactAppearance = appearance

        segments.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            UISelectionFeedbackGenerator().selectionChanged()
            self.show(self.section)
        }, for: .valueChanged)
        navigationItem.titleView = segments

        settingsButton.primaryAction = UIAction(title: "我") { [weak self] _ in self?.openSettings() }
        settingsButton.accessibilityLabel = "设置"
        navigationItem.rightBarButtonItem = settingsButton
        avatarToken = NotificationCenter.default.addObserver(forName: Avatars.loaded, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.updateMe() }
        }
        projectList.accessibilityLabel = "切换空间"

        container.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(container)
        container.pin(to: view)

        top.axis = .vertical
        top.spacing = Theme.Space.s2
        top.addArrangedSubview(approvals)
        top.addArrangedSubview(doing)
        top.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(top)
        pill.alpha = 0
        pill.onTap = { [weak self] in self?.openInvite() }
        pill.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(pill)
        pillTop = pill.topAnchor.constraint(equalTo: top.bottomAnchor)
        NSLayoutConstraint.activate([
            top.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: Theme.Space.s2),
            top.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: Theme.Space.s4),
            top.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -Theme.Space.s4),
            pillTop,
            pill.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            pill.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, multiplier: Theme.Size.bubbleMax)
        ])

        storeToken = Store.shared.observe { [weak self] in self?.storeChanged() }
        Store.shared.startPolling()
        show(.chat)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let height = top.arrangedSubviews.allSatisfy(\.isHidden) ? 0 : top.bounds.height + Theme.Space.s3
        guard abs(height - topInset) > 0.5 else { return }
        topInset = height
        shown?.additionalSafeAreaInsets.top = height
    }

    /// 右上角的「我」：换过头像的显示头像。
    private func updateMe() {
        let pupu = Avatars.shared.pupu()
        segments.setAvatar(pupu.image, pixelArt: pupu.pixelArt)
        let path = Store.shared.members.first(where: \.current)?.avatar
        guard let image = Avatars.shared.image(path) else {
            settingsButton.image = nil
            settingsButton.title = "我"
            return
        }
        settingsButton.title = nil
        settingsButton.image = Avatars.round(image, letter: "我", size: 30, pixelArt: Avatars.isPixelArt(path))
            .withRenderingMode(.alwaysOriginal)
    }

    private func storeChanged() {
        updateMe()
        approvals.update(Store.shared.approvals)
        render()
    }

    /// 审批卡出现或收起：胶囊跟着让开，页面的安全区在 viewDidLayoutSubviews 里跟着改。
    private func relayoutTop() {
        pillTop.constant = approvals.isHidden ? 0 : Theme.Space.s2
        view.setNeedsLayout()
        view.layoutIfNeeded()
    }

    private func show(_ next: Section) {
        segments.select(next.rawValue, animated: true)
        navigationItem.setLeftBarButton(next == .projects ? projectList : nil, animated: true)
        if next == .projects { atLatest = false }
        render()
    }

    private func render() {
        doing.update(Store.shared.activity, shown: section == .chat || inEveryone)
        switch section {
        // 还不知道有没有私聊：先别开会话，免得落到全员那条，发出去全组织都看得到。
        case .chat: display(Store.shared.synced ? ownChat : loading)
        case .projects: showProjects()
        }
        updatePill()
        updateUnread()
    }

    /// 正在看全员空间。
    private var inEveryone: Bool { section == .projects && currentProject == Project.everyoneId }

    private var ownChat: ChatViewController {
        let chats = Store.shared.chats
        let session = chats.own.session
        if let existing = ownChatView, existing.session == session { return existing }
        let mine = chats.private != nil
        let chat = ChatViewController(
            identity: identity,
            session: session,
            placeholder: mine ? ChatCopy.privateHint : ChatCopy.everyoneHint,
            projectTags: true,
            opening: .intro(mine ? ChatCopy.privateIntro : ChatCopy.everyoneIntro),
            openProject: { [weak self] id in
                if let project = Store.shared.project(id: id) { self?.open(project) }
            }
        )
        ownChatView = chat
        return chat
    }

    private var seen: [String: Double] {
        get { (UserDefaults.standard.dictionary(forKey: Self.seenKey)?[identity.key] as? [String: Double]) ?? [:] }
        set { UserDefaults.standard.set([identity.key: newValue], forKey: Self.seenKey) }
    }

    /// 这条聊天有没有没看过的回复。
    private func isUnread(_ chat: Chats.Chat) -> Bool {
        chat.lastAt.map { $0 > seen[chat.session] ?? 0 } ?? false
    }

    /// 看着的那条记下看到哪了；「我的 Pupu」没在看、又有新回复，聊天段亮圆点。全员的圆点在切换空间的 sheet 里。
    private func updateUnread() {
        let chats = Store.shared.chats
        let showing: Chats.Chat? = section == .chat ? chats.own : inEveryone && chats.private != nil ? chats.main : nil
        if let showing, let lastAt = showing.lastAt, seen[showing.session] != lastAt {
            seen[showing.session] = lastAt
        }
        let label = section != .chat && isUnread(chats.own) ? "有新消息" : nil
        if segments.unread != label { segments.unread = label }
    }

    /// 「项目」直接打开上次的空间；没记住就打开最近活动的那个，一个都没有时是全员。
    private func showProjects() {
        let spaces = Store.shared.spaces
        guard let project = spaces.first(where: { $0.id == lastProject }) ?? Store.shared.projects.first ?? spaces.first else {
            noProject.loaded = Store.shared.loaded
            display(noProject)
            return
        }
        pill.show(project, me: Store.shared.members.first(where: \.current)?.id)
        currentProject = project.id
        lastProject = project.id
        if projectChat?.session != project.session {
            let everyone = project.isEveryone
            let chat = ChatViewController(
                identity: identity,
                session: project.session,
                placeholder: everyone ? ChatCopy.everyoneHint : "在「\(project.name)」里说",
                projectTags: everyone,
                opening: everyone ? .intro(ChatCopy.everyoneIntro) : .project(project),
                openProject: { [weak self] id in
                    if let project = Store.shared.project(id: id) { self?.open(project) }
                }
            )
            chat.onScroll = { [weak self] atLatest in
                self?.atLatest = atLatest
                self?.updatePill()
            }
            chat.onOpenChild = { [weak self] session in
                guard let project = Store.shared.project(id: project.id), let child = project.child(session: session) else { return }
                self?.openChild(child, in: project)
            }
            projectChat = chat
        }
        if let projectChat { display(projectChat) }
    }

    /// 只在项目页、有当前项目时出现。有主人的空间一直在（成员和邀请在上面）；
    /// 老项目只写名字，切到项目后显示，滚到最新时淡出，往回翻时再出现。
    private func updatePill() {
        let alpha: CGFloat = section == .projects && shown === projectChat && (pill.managed || !atLatest) ? 1 : 0
        guard pill.alpha != alpha else { return }
        UIView.animate(withDuration: 0.2) { self.pill.alpha = alpha }
    }

    /// ≡：切换空间的 sheet。第一行回到自己的 Pupu（私聊）。
    private func openSwitcher() {
        view.endEditing(true)
        let chats = Store.shared.chats
        let switcher = SpaceSwitcherViewController(
            current: currentProject,
            everyoneUnread: chats.private != nil && !inEveryone && isUnread(chats.main),
            openPupu: { [weak self] in self?.show(.chat) },
            openDocs: { [weak self] in self?.openDocs() },
            open: { [weak self] project in self?.open(project) },
            openChild: { [weak self] project, child in
                self?.open(project)
                self?.openChild(child, in: project)
            },
            create: { [weak self] in self?.createProject() }
        )
        if let sheet = switcher.sheetPresentationController {
            sheet.detents = [.large()]
            sheet.prefersGrabberVisible = true
            sheet.preferredCornerRadius = Theme.Radius.panel
        }
        present(switcher, animated: true)
    }

    /// 资料：组织层和看得到的空间里的。整页 sheet，里面可以推进去读一份。
    private func openDocs() {
        view.endEditing(true)
        let docs = DocsViewController(identity: identity)
        docs.navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .close, primaryAction: UIAction { [weak docs] _ in docs?.dismiss(animated: true) })
        let nav = UINavigationController(rootViewController: docs)
        nav.navigationBar.prefersLargeTitles = true
        if let sheet = nav.sheetPresentationController {
            sheet.detents = [.large()]
            sheet.prefersGrabberVisible = true
            sheet.preferredCornerRadius = Theme.Radius.panel
        }
        present(nav, animated: true)
    }

    /// 空间名胶囊：成员和邀请；全员是设置（只有组织创建者打得开）。老项目没有主人，不弹。
    private func openInvite() {
        guard let id = currentProject, let project = Store.shared.project(id: id) else { return }
        guard project.isEveryone ? project.mayManage == true : project.ownerId != nil else { return }
        let invite = InviteSheetViewController(projectId: project.id)
        if let sheet = invite.sheetPresentationController {
            sheet.detents = [.large()]
            sheet.prefersGrabberVisible = true
            sheet.preferredCornerRadius = Theme.Radius.panel
        }
        present(invite, animated: true)
    }

    private func openChild(_ child: SpaceChild, in project: Project) {
        view.endEditing(true)
        navigationController?.pushViewController(ChildSessionViewController(identity: identity, project: project, child: child), animated: true)
    }

    private func display(_ next: UIViewController) {
        guard shown !== next else { return }
        let previous = shown
        let swap = {
            self.addChild(next)
            self.container.addSubview(next.view)
            next.view.pin(to: self.container)
            next.didMove(toParent: self)
        }
        let remove = {
            guard let previous, previous !== self.shown else { return }
            previous.willMove(toParent: nil)
            previous.view.removeFromSuperview()
            previous.removeFromParent()
            previous.view.alpha = 1
        }
        next.additionalSafeAreaInsets.top = topInset
        previous?.additionalSafeAreaInsets.top = 0
        shown = next
        setContentScrollView(next.contentScrollView(for: .top), for: .top)

        // 深色是私聊的记号。天空和导航栏都在这个控制器外面，要从最外层改才盖得到。
        let style: UIUserInterfaceStyle = Store.shared.chats.private != nil && next === ownChatView ? .dark : .unspecified
        if let root = navigationController?.parent, root.overrideUserInterfaceStyle != style {
            UIView.transition(with: root.view, duration: 0.2, options: .transitionCrossDissolve) {
                root.overrideUserInterfaceStyle = style
                swap()
                remove()
            }
            return
        }
        swap()
        next.view.alpha = 0
        UIView.animate(withDuration: 0.2) {
            next.view.alpha = 1
            previous?.view.alpha = 0
        } completion: { _ in
            remove()
        }
    }

    private var lastProject: String? {
        get { UserDefaults.standard.dictionary(forKey: Self.lastProjectKey)?[identity.key] as? String }
        set { UserDefaults.standard.set(newValue.map { [identity.key: $0] }, forKey: Self.lastProjectKey) }
    }

    private func open(_ project: Project) {
        lastProject = project.id
        show(.projects)
    }

    /// 「正在做」里点了一行：带项目的去项目；聊天里有这台电脑的任务卡就滚过去；都没有就打开设置里这台电脑。
    private func openActivity(_ activity: ComputerActivity) {
        if let ref = activity.project, let project = Store.shared.project(id: ref.id) {
            open(project)
        } else if !((section == .chat ? (Store.shared.synced ? ownChat : nil) : inEveryone ? projectChat : nil)?.showComputerCard(activity.computerId) ?? false) {
            openSettings(page: .computer(activity.computerId))
        }
    }

    private func openSettings(page: SettingsViewController.Page? = nil) {
        let root = SettingsViewController()
        let navigation = UINavigationController(rootViewController: root)
        if let page { navigation.pushViewController(SettingsViewController(page: page), animated: false) }
        if let sheet = navigation.sheetPresentationController {
            sheet.detents = [.large()]
            sheet.prefersGrabberVisible = true
        }
        present(navigation, animated: true)
    }

    private func createProject() {
        let alert = UIAlertController(title: "新空间", message: "一件要持续推进的事。先只有你和 Pupu，可以再邀请同事。", preferredStyle: .alert)
        alert.addTextField { field in
            field.placeholder = "名字，比如 登录页改版"
            field.returnKeyType = .next
        }
        alert.addTextField { field in
            field.placeholder = "目标，可以不填"
            field.returnKeyType = .done
        }
        alert.addAction(UIAlertAction(title: "取消", style: .cancel))
        alert.addAction(UIAlertAction(title: "建立", style: .default) { [weak self, weak alert] _ in
            let name = alert?.textFields?[0].text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let goal = alert?.textFields?[1].text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !name.isEmpty, let api = Store.shared.api else { return }
            Task {
                do {
                    let project = try await api.createSpace(name: name, goal: goal)
                    Store.shared.added(project)
                    Store.shared.refresh()
                    self?.open(project)
                } catch {
                    self?.showError(error.localizedDescription)
                }
            }
        })
        present(alert, animated: true)
    }

    private func showError(_ text: String) {
        let alert = UIAlertController(title: "没做成", message: text, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default))
        (presentedViewController ?? self).present(alert, animated: true)
    }
}

/// 第一次拉到状态之前，聊天段先转圈。
final class LoadingViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let spinner = UIActivityIndicatorView(style: .medium)
        spinner.startAnimating()
        spinner.accessibilityLabel = "加载中"
        spinner.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(spinner)
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor)
        ])
    }
}

/// 还没有项目时，「项目」页的样子。
final class NoProjectViewController: UIViewController {
    private let label = UILabel(style: .message, color: Theme.inkSky, lines: 0)
    private let create: () -> Void

    var loaded = false {
        didSet { update() }
    }

    init(create: @escaping () -> Void) {
        self.create = create
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        label.textAlignment = .center
        let button = UIButton.glass(title: "新空间", image: "plus")
        button.configuration?.imagePadding = Theme.Space.s2
        button.addAction(UIAction { [weak self] _ in self?.create() }, for: .primaryActionTriggered)
        let stack = UIStackView(arrangedSubviews: [label, button])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = Theme.Space.s5
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: Theme.Space.s6),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -Theme.Space.s6)
        ])
        update()
    }

    private func update() {
        label.text = loaded
            ? "还没有空间。在聊天里说要做的事，Pupu 会问你要不要建一个；也可以自己建。"
            : "加载中…"
    }
}

/// 项目页顶栏下方的小胶囊：空间名，L3、L4 带成员头像，建的人还有「邀请」。有主人的空间点了打开邀请 sheet；老项目只写名字，不接点击。
final class ProjectPill: UIControl {
    static let height: CGFloat = 28

    private let label = UILabel(style: .footnote)
    private let avatars = SpaceAvatarStack(size: 20)
    private let building = UIImageView(image: UIImage(systemName: "building.2"))
    private let invite = UILabel(text: "邀请", style: .footnote)
    var onTap: (() -> Void)?
    /// 有主人的空间：成员和邀请在胶囊上，胶囊一直显示。
    private(set) var managed = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        let glass = GlassView()
        glass.isUserInteractionEnabled = false
        addSubview(glass)
        glass.pin(to: self)
        label.lineBreakMode = .byTruncatingTail
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        invite.font = Theme.font(.footnote, weight: .semibold)
        building.tintColor = Theme.ink
        building.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .footnote)
        let row = UIStackView(arrangedSubviews: [label, building, avatars, invite])
        row.spacing = Theme.Space.s2
        row.alignment = .center
        row.isUserInteractionEnabled = false
        addSubview(row)
        row.pin(to: self, insets: UIEdgeInsets(top: 0, left: Theme.Space.s3, bottom: 0, right: Theme.Space.s3))
        heightAnchor.constraint(equalToConstant: Self.height).isActive = true
        addAction(UIAction { [weak self] _ in self?.onTap?() }, for: .touchUpInside)
        isAccessibilityElement = true
    }

    required init?(coder: NSCoder) { fatalError() }

    func show(_ project: Project, me: String?) {
        label.text = project.name
        if project.isEveryone {
            // 全员：名字加楼，组织创建者点了打开设置。
            managed = true
            let settings = project.mayManage == true
            isUserInteractionEnabled = settings
            building.isHidden = false
            avatars.show([])
            invite.isHidden = true
            accessibilityLabel = project.name
            accessibilityTraits = settings ? .button : .staticText
            accessibilityHint = settings ? "设置" : nil
            return
        }
        managed = project.ownerId != nil
        isUserInteractionEnabled = managed
        building.isHidden = !(managed && project.isOpen)
        if managed && !project.isOpen { avatars.show(project.memberIds) } else { avatars.show([]) }
        let owner = project.isOwner(me)
        invite.isHidden = !owner
        accessibilityLabel = project.name
        accessibilityTraits = managed ? .button : .staticText
        accessibilityHint = managed ? (owner ? "邀请和成员" : "看成员") : nil
    }
}

/// 自己不接点击、只让子视图接的容器：顶栏下方那一叠的空白处，点到的是下面的内容。
final class PassThroughStackView: UIStackView {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        return hit === self ? nil : hit
    }
}
