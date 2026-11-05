import UIKit

/// 主界面：顶栏的两段切换（聊天、项目），右边设置，项目页左边打开整页项目列表。
/// 顶栏下方是等你批准的请示（哪一页都在）和聊天段的「正在做」，出现时把页面内容往下挤，不盖住对话。
/// 项目名胶囊盖在内容上，不挤内容。
final class ShellViewController: UIViewController {
    private enum Section: Int {
        case chat, projects
    }

    private static let lastProjectKey = "pupu.last-project"
    /// 每条聊天看到过的 lastAt，按 session 记。用云端的时间比，手机时钟不准也不会亮错。
    private static let seenKey = "pupu.chat-seen"

    private let segments = SectionSwitch(titles: [Lane.main.title, "项目"], selected: Section.chat.rawValue)
    private let container = UIView()
    private let approvals = ApprovalStackView()
    private let pill = ProjectPill()
    private let top = PassThroughStackView()
    private var pillTop: NSLayoutConstraint!
    /// 顶栏下方那一叠占的高度，加给当前页面的安全区。
    private var topInset: CGFloat = 0
    private var section: Section = .chat
    private var lane: Lane = .main
    private var switcherOpen = false
    /// 项目对话滚到了最新的消息：胶囊淡出。
    private var atLatest = false
    private var storeToken: StoreToken?

    private lazy var doing = DoingView(
        openProject: { [weak self] project in self?.open(project) },
        relayout: { [weak self] in
            self?.view.setNeedsLayout()
            self?.view.layoutIfNeeded()
        }
    )
    private lazy var switcher = ProjectSwitcher(
        open: { [weak self] project in
            UISelectionFeedbackGenerator().selectionChanged()
            self?.open(project)
        },
        create: { [weak self] in self?.createProject() }
    )
    private lazy var projectList = UIBarButtonItem(
        image: UIImage(systemName: "line.3.horizontal"),
        primaryAction: UIAction { [weak self] _ in
            guard let self else { return }
            self.setSwitcher(open: !self.switcherOpen)
        }
    )
    /// 两条聊天都留着，切回来不用等快照。
    private var laneChats: [Lane: ChatViewController] = [:]
    private var projectChat: ChatViewController?
    private lazy var noProject = NoProjectViewController(create: { [weak self] in self?.createProject() })
    private var shown: UIViewController?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear

        let appearance = UINavigationBarAppearance()
        appearance.configureWithTransparentBackground()
        navigationItem.standardAppearance = appearance
        navigationItem.scrollEdgeAppearance = appearance
        navigationItem.compactAppearance = appearance

        segments.addAction(UIAction { [weak self] _ in
            guard let self, let next = Section(rawValue: self.segments.selectedIndex) else { return }
            UISelectionFeedbackGenerator().selectionChanged()
            self.show(next)
        }, for: .valueChanged)
        segments.chatMenu = { [weak self] in self?.laneMenu() }
        navigationItem.titleView = segments

        let settings = UIBarButtonItem(title: "我", primaryAction: UIAction { [weak self] _ in self?.openSettings() })
        settings.accessibilityLabel = "设置"
        navigationItem.rightBarButtonItem = settings
        projectList.accessibilityLabel = "全部项目"

        container.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(container)
        container.pin(to: view)

        switcher.alpha = 0
        switcher.isHidden = true
        view.addSubview(switcher)
        switcher.pin(to: view)

        approvals.isHidden = true
        top.axis = .vertical
        top.spacing = Theme.Space.s2
        top.addArrangedSubview(approvals)
        top.addArrangedSubview(doing)
        top.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(top)
        pill.alpha = 0
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

        setLane(.main)
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
        switcher.topInset = height
    }

    private func storeChanged() {
        approvals.update(Store.shared.approvals)
        approvals.isHidden = Store.shared.approvals.isEmpty
        pillTop.constant = approvals.isHidden ? 0 : Theme.Space.s2
        if Store.shared.chats[lane] == nil { setLane(.main) }
        render()
    }

    private func show(_ next: Section) {
        section = next
        segments.select(next.rawValue, animated: true)
        navigationItem.setLeftBarButton(next == .projects ? projectList : nil, animated: true)
        if next == .projects {
            atLatest = false
        } else {
            setSwitcher(open: false)
        }
        render()
    }

    private func render() {
        doing.update(section == .chat ? ComputerActivity.busy(Store.shared.activity) : [])
        switch section {
        case .chat: display(laneChat)
        case .projects: showProjects()
        }
        updatePill()
        updateUnread()
    }

    private func setLane(_ next: Lane) {
        lane = next
        segments.chatTitle = next.title
    }

    /// 长按聊天段的菜单。没有私聊时不弹。
    private func laneMenu() -> UIMenu? {
        guard Store.shared.chats.private != nil else { return nil }
        return UIMenu(children: Lane.allCases.map { item in
            UIAction(
                title: item.title,
                image: UIImage(named: "pupu-avatar")?.withRenderingMode(.alwaysOriginal),
                state: item == lane ? .on : .off
            ) { [weak self] _ in
                UISelectionFeedbackGenerator().selectionChanged()
                self?.setLane(item)
                self?.show(.chat)
            }
        })
    }

    private var laneChat: ChatViewController {
        let chats = Store.shared.chats
        let session = (chats[lane] ?? chats.main).session
        if let existing = laneChats[lane], existing.session == session { return existing }
        let chat = ChatViewController(
            session: session,
            placeholder: lane.placeholder,
            projectTags: true,
            opening: .intro(lane.intro),
            openProject: { [weak self] id in
                if let project = Store.shared.project(id: id) { self?.open(project) }
            }
        )
        laneChats[lane] = chat
        return chat
    }

    /// 看着的这条记下看到哪了，另一条比记下的新就亮圆点。
    private func updateUnread() {
        let chats = Store.shared.chats
        var seen = UserDefaults.standard.dictionary(forKey: Self.seenKey) as? [String: Double] ?? [:]
        if section == .chat, let current = chats[lane], let lastAt = current.lastAt, seen[current.session] != lastAt {
            seen[current.session] = lastAt
            UserDefaults.standard.set(seen, forKey: Self.seenKey)
        }
        let other = chats[lane.other]
        let unread = other.flatMap { chat in chat.lastAt.map { $0 > seen[chat.session] ?? 0 } } ?? false
        let label = unread ? "\(lane.other.title)有新消息" : nil
        if segments.unread != label { segments.unread = label }
    }

    /// 「项目」直接打开上次的项目；没记住就打开最近活动的那个。
    private func showProjects() {
        let projects = Store.shared.projects
        let last = UserDefaults.standard.string(forKey: Self.lastProjectKey)
        guard let project = projects.first(where: { $0.id == last }) ?? projects.first else {
            noProject.loaded = Store.shared.loaded
            display(noProject)
            return
        }
        pill.name = project.name
        switcher.current = project.id
        UserDefaults.standard.set(project.id, forKey: Self.lastProjectKey)
        if projectChat?.session != project.session {
            let chat = ChatViewController(
                session: project.session,
                placeholder: "在「\(project.name)」里说",
                projectTags: false,
                opening: .project(project),
                openProject: { _ in }
            )
            chat.onScroll = { [weak self] atLatest in
                self?.atLatest = atLatest
                self?.updatePill()
            }
            projectChat = chat
        }
        if let projectChat { display(projectChat) }
    }

    /// 只在项目页、有当前项目时出现。切到项目后显示，滚到最新时淡出，往回翻时再出现。
    private func updatePill() {
        let alpha: CGFloat = section == .projects && shown === projectChat && !switcherOpen && !atLatest ? 1 : 0
        guard pill.alpha != alpha else { return }
        UIView.animate(withDuration: 0.2) { self.pill.alpha = alpha }
    }

    /// 打开时对话和输入栏淡出，列表淡入；收起时反过来。
    private func setSwitcher(open: Bool) {
        guard switcherOpen != open else { return }
        switcherOpen = open
        if open {
            view.endEditing(true)
            switcher.isHidden = false
        }
        UIView.animate(withDuration: 0.2) {
            self.switcher.alpha = open ? 1 : 0
            self.shown?.view.alpha = open ? 0 : 1
        } completion: { _ in
            if !self.switcherOpen { self.switcher.isHidden = true }
        }
        updatePill()
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
        let style: UIUserInterfaceStyle = lane == .private && next === laneChats[.private] ? .dark : .unspecified
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
            next.view.alpha = self.switcherOpen ? 0 : 1
            previous?.view.alpha = 0
        } completion: { _ in
            remove()
        }
    }

    private func open(_ project: Project) {
        UserDefaults.standard.set(project.id, forKey: Self.lastProjectKey)
        setSwitcher(open: false)
        show(.projects)
    }

    private func openSettings() {
        let navigation = UINavigationController(rootViewController: SettingsViewController())
        if let sheet = navigation.sheetPresentationController {
            sheet.detents = [.large()]
            sheet.prefersGrabberVisible = true
        }
        present(navigation, animated: true)
    }

    private func createProject() {
        let alert = UIAlertController(title: "新项目", message: "项目是一件要持续推进的事。", preferredStyle: .alert)
        alert.addTextField { field in
            field.placeholder = "名字，比如 登录页改版"
            field.returnKeyType = .next
        }
        alert.addTextField { field in
            field.placeholder = "目标，可以不填"
            field.returnKeyType = .done
        }
        alert.addAction(UIAlertAction(title: "取消", style: .cancel))
        alert.addAction(UIAlertAction(title: "建项目", style: .default) { [weak self, weak alert] _ in
            let name = alert?.textFields?[0].text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let goal = alert?.textFields?[1].text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !name.isEmpty, let api = Store.shared.api else { return }
            Task {
                do {
                    let project = try await api.createProject(name: name, goal: goal)
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
        let button = UIButton.glass(title: "新项目", image: "plus")
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
            ? "还没有项目。在聊天里说要做的事，Pupu 会问你要不要建一个；也可以自己建。"
            : "加载中…"
    }
}

/// 项目页顶栏下方的小胶囊，只写项目名，不接点击。
final class ProjectPill: UIView {
    static let height: CGFloat = 28

    private let label = UILabel(style: .footnote)

    var name = "" {
        didSet { label.text = name }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        let glass = GlassView()
        addSubview(glass)
        glass.pin(to: self)
        label.lineBreakMode = .byTruncatingTail
        addSubview(label)
        label.pin(to: self, insets: UIEdgeInsets(top: 0, left: Theme.Space.s3, bottom: 0, right: Theme.Space.s3))
        heightAnchor.constraint(equalToConstant: Self.height).isActive = true
    }

    required init?(coder: NSCoder) { fatalError() }
}

/// 自己不接点击、只让子视图接的容器：顶栏下方那一叠的空白处，点到的是下面的内容。
final class PassThroughStackView: UIStackView {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        return hit === self ? nil : hit
    }
}
