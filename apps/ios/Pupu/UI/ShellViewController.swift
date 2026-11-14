import UIKit

/// 主界面（规范 README 的三层）：窗框是当前空间的 `frame-*`（「我的 Pupu」是 `canvas`），上面一张会话卡，
/// 顶栏直接画在窗框上：左边切换按钮打开 SpaceSwitcher，中间是在哪，右边成员胶囊打开空间设置。
/// 会话卡最上面是状态条（「我的 Pupu」和全员里）和等你批准的请示（哪儿都有），出现时把对话往下挤，不盖住。
/// 电脑不在主界面上：列表、配对、远程控制都在设置里，Pupu 用电脑时对话里出一张电脑卡。设置从切换 sheet 最底下进。
/// Artifacts 也是一个地方（规范 Docs）：窗框 `canvas`，卡片里是资料列表和正文页。
/// 一个主界面只属于一个身份：换了 Pupu 或者重新配对，RootViewController 整个换一个新的。
final class ShellViewController: UIViewController, UIGestureRecognizerDelegate {
    /// 在哪：自己的 Pupu（私聊），或者某个空间。
    private enum Place: Equatable {
        case pupu
        case space(String)
        /// Artifacts：组织层和看得到的空间里的资料、skill 和页面。
        case docs
    }

    /// 每条聊天看到过的 lastAt，按身份记：`[身份: [session: lastAt]]`，只留现在这个身份的。
    /// 用云端的时间比，手机时钟不准也不会亮错。
    private static let seenKey = "pupu.chat-seen"

    private let identity: Identity
    private var place = Place.pupu
    private let card = CardView()
    /// 卡片最上面那一叠：状态条、审批卡。都没有时整块收起。
    private let top = UIStackView()
    private let container = UIView()
    private lazy var approvals = ApprovalStackView(relayout: { [weak self] in self?.relayout() })
    private lazy var strip = StatusStripView(
        open: { [weak self] activity in self?.openActivity(activity) },
        relayout: { [weak self] in self?.relayout(animated: false) }
    )
    private let switchButton = BarButton(image: "line.3.horizontal", label: "切换")
    private let placeTitle = PlaceTitleView()
    private let members = MembersCapsule()
    private lazy var membersItem = members.barItem()
    /// 窗框现在是哪个颜色：变了才动画换。
    private var frameKey: String?
    private var storeToken: StoreToken?
    private var avatarToken: NSObjectProtocol?

    /// 「我的 Pupu」那条聊天，留着，切回来不用等快照。
    private var ownChatView: ChatViewController?
    private var spaceChatView: ChatViewController?
    /// 在 Artifacts 时卡片里的那个导航；离开就放掉，下次进来重新拉。
    private var docsView: DocsNavigationController?
    private let loading = LoadingViewController()
    private var shown: UIViewController?

    init(identity: Identity) {
        self.identity = identity
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.canvas

        let appearance = UINavigationBarAppearance()
        appearance.configureWithTransparentBackground()
        navigationItem.standardAppearance = appearance
        navigationItem.scrollEdgeAppearance = appearance
        navigationItem.compactAppearance = appearance
        navigationItem.leftBarButtonItem = switchButton.barItem()
        navigationItem.titleView = placeTitle
        switchButton.addAction(UIAction { [weak self] _ in self?.openSwitcher() }, for: .primaryActionTriggered)
        members.onTap = { [weak self] in self?.openSpaceSettings() }
        // 子会话的返回是自己画的圆按钮，系统的侧滑返回要自己放行。
        navigationController?.interactivePopGestureRecognizer?.delegate = self
        avatarToken = NotificationCenter.default.addObserver(forName: Avatars.loaded, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.updateHeader() }
        }

        card.placeAsSession(in: view)
        top.axis = .vertical
        top.spacing = Theme.Space.s3
        top.isLayoutMarginsRelativeArrangement = true
        top.directionalLayoutMargins = NSDirectionalEdgeInsets(top: Theme.Space.s3, leading: Theme.Space.s4, bottom: 0, trailing: Theme.Space.s4)
        top.addArrangedSubview(strip)
        top.addArrangedSubview(approvals)
        top.isHidden = true
        let column = UIStackView(arrangedSubviews: [top, container])
        column.axis = .vertical
        card.contentView.addSubview(column)
        column.pin(to: card.contentView)

        storeToken = Store.shared.observe { [weak self] in self?.render() }
        Store.shared.startPolling()
        render()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // iPad 和横屏：状态条和审批卡跟对话列一样居中，最宽 column-max。
        let side = max(Theme.Space.s4, (card.bounds.width - Theme.Size.columnMax) / 2 + Theme.Space.s4)
        if abs(top.directionalLayoutMargins.leading - side) > 0.5 {
            top.directionalLayoutMargins.leading = side
            top.directionalLayoutMargins.trailing = side
        }
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        (navigationController?.viewControllers.count ?? 0) > 1
    }

    // MARK: 现在在哪

    private var currentProject: Project? {
        guard case .space(let id) = place else { return nil }
        return Store.shared.project(id: id)
    }

    /// 正在看全员空间。
    private var inEveryone: Bool { place == .space(Project.everyoneId) }

    /// 没有成员身份的手机（老组织的样子）没有私聊，「我的 Pupu」那条就是全员：顶栏、窗框、切换列表都照全员画，
    /// 和输入栏的「在「全员」里说」对得上。拉到状态之前不知道有没有私聊，先照「我的 Pupu」。
    private var ownSpace: Project? {
        guard Store.shared.synced, Store.shared.chats.private == nil else { return nil }
        return Store.shared.project(id: Project.everyoneId)
    }

    private func go(_ next: Place) {
        place = next
        if next != .docs { docsView = nil }
        render()
    }

    /// 全员就是自己那条时，打开全员回到那条，不另开一份。
    private func open(_ project: Project) {
        go(project.isEveryone && ownSpace != nil ? .pupu : .space(project.id))
    }

    private func render() {
        // 看着的空间没了（被移出、空间收窄）：回到自己的 Pupu。
        if case .space = place, currentProject == nil, Store.shared.loaded { place = .pupu }
        updateFrame()
        updateHeader()
        approvals.update(Store.shared.approvals)
        strip.update(place == .pupu || inEveryone ? doingRows : [])
        if let project = currentProject {
            display(spaceChat(project))
        } else if place == .docs {
            display(docs)
        } else {
            // 还不知道有没有私聊：先别开会话，免得落到全员那条，发出去全组织都看得到。
            display(Store.shared.synced ? ownChat : loading)
        }
        updateUnread()
    }

    /// 状态条列的电脑。停在审批上的，审批卡就在正下方，同一件事不写两遍；屏幕控制开着的留着，「收回」在状态条上。
    private var doingRows: [ComputerActivity] {
        let approvals = Store.shared.approvals
        return ComputerActivity.busy(Store.shared.activity).filter { row in
            row.screen || row.currentState != .waiting || !approvals.contains { $0.computerId == row.computerId }
        }
    }

    /// 换空间时窗框 0.3 秒换色（uikit.md「窗框」）。
    private func updateFrame() {
        let project = currentProject ?? (place == .pupu ? ownSpace : nil)
        let key = project.map { Theme.SpaceColor(id: $0.color).rawValue } ?? "canvas"
        guard key != frameKey else { return }
        let first = frameKey == nil
        frameKey = key
        let color = project?.frameColor ?? Theme.canvas
        guard !first, view.window != nil, !UIAccessibility.isReduceMotionEnabled else {
            view.backgroundColor = color
            return
        }
        UIView.animate(withDuration: 0.3) { self.view.backgroundColor = color }
    }

    private func updateHeader() {
        if place == .docs {
            placeTitle.showDocs()
            if navigationItem.rightBarButtonItem != nil { navigationItem.setRightBarButton(nil, animated: true) }
        } else if let project = currentProject ?? (place == .pupu ? ownSpace : nil) {
            placeTitle.show(project)
            let tappable = project.isEveryone ? project.mayManage == true : project.ownerId != nil
            let item = members.show(project, tappable: tappable) ? membersItem : nil
            if navigationItem.rightBarButtonItem !== item { navigationItem.setRightBarButton(item, animated: true) }
        } else {
            placeTitle.showPupu()
            if navigationItem.rightBarButtonItem != nil { navigationItem.setRightBarButton(nil, animated: true) }
        }
        let unread = ownUnread || everyoneUnread
        switchButton.unread = unread
        switchButton.accessibilityLabel = unread ? "切换，有新消息" : "切换"
    }

    /// 卡片里的状态条或审批卡出现、收起：下面的对话跟着挤开或者合上。
    private func relayout(animated: Bool = true) {
        let hidden = strip.isHidden && approvals.isHidden
        let change = {
            if self.top.isHidden != hidden { self.top.isHidden = hidden }
            self.view.layoutIfNeeded()
        }
        guard animated, view.window != nil, !UIAccessibility.isReduceMotionEnabled else {
            change()
            return
        }
        UIView.animate(springDuration: 0.3, bounce: 0) { change() }
    }

    // MARK: 聊天

    private var docs: DocsNavigationController {
        if let docsView { return docsView }
        let docs = DocsNavigationController(identity: identity)
        docsView = docs
        return docs
    }

    private var ownChat: ChatViewController {
        let chats = Store.shared.chats
        let session = chats.own.session
        if let existing = ownChatView, existing.session == session { return existing }
        // 老组织没有私聊：自己的那条就是全员，占位和空聊天都照全员空间写。
        let mine = chats.private != nil
        let everyone = Store.shared.project(id: Project.everyoneId)
        let chat = ChatViewController(
            identity: identity,
            session: session,
            placeholder: mine ? ChatCopy.privateHint : ChatCopy.spaceHint(everyone?.name ?? "全员"),
            projectTags: true,
            opening: mine ? .intro(ChatCopy.privateIntro) : everyone.map { .project($0) } ?? .intro(""),
            openProject: { [weak self] id in
                if let project = Store.shared.project(id: id) { self?.open(project) }
            }
        )
        ownChatView = chat
        return chat
    }

    private func spaceChat(_ project: Project) -> ChatViewController {
        if let existing = spaceChatView, existing.session == project.session { return existing }
        let chat = ChatViewController(
            identity: identity,
            session: project.session,
            placeholder: ChatCopy.spaceHint(project.name),
            projectTags: project.isEveryone,
            opening: .project(project),
            openProject: { [weak self] id in
                if let project = Store.shared.project(id: id) { self?.open(project) }
            }
        )
        let id = project.id
        chat.onOpenChild = { [weak self] session in
            guard let project = Store.shared.project(id: id), let child = project.child(session: session) else { return }
            self?.openChild(child, in: project)
        }
        spaceChatView = chat
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

    /// 没在看「我的 Pupu」，它又有新回复。
    private var ownUnread: Bool { place != .pupu && isUnread(Store.shared.chats.own) }

    /// 没在看全员，它又有新消息。没有私聊时全员就是自己的那条，不另算。
    private var everyoneUnread: Bool {
        let chats = Store.shared.chats
        return chats.private != nil && !inEveryone && isUnread(chats.main)
    }

    /// 看着的那条记下看到哪了。
    private func updateUnread() {
        let chats = Store.shared.chats
        let showing: Chats.Chat? = place == .pupu ? chats.own : inEveryone && chats.private != nil ? chats.main : nil
        if let showing, let lastAt = showing.lastAt, seen[showing.session] != lastAt {
            seen[showing.session] = lastAt
            updateHeader()
        }
    }

    private func display(_ next: UIViewController) {
        guard shown !== next else { return }
        let previous = shown
        shown = next
        addChild(next)
        container.addSubview(next.view)
        next.view.pin(to: container)
        next.didMove(toParent: self)
        next.view.alpha = 0
        UIView.animate(withDuration: 0.2) {
            next.view.alpha = 1
            previous?.view.alpha = 0
        } completion: { _ in
            guard let previous, previous !== self.shown else { return }
            previous.willMove(toParent: nil)
            previous.view.removeFromSuperview()
            previous.removeFromParent()
            previous.view.alpha = 1
        }
    }

    // MARK: 打开别的

    /// 切换 sheet：「我的 Pupu」和 Artifacts，所有空间和它们正在做的子会话，最底下是设置。
    private func openSwitcher() {
        view.endEditing(true)
        let own = ownSpace
        let switcher = SpaceSwitcherViewController(
            current: currentProject?.id ?? (place == .pupu ? own?.id : nil),
            docs: place == .docs,
            showsPupu: own == nil,
            pupuUnread: ownUnread,
            everyoneUnread: own == nil ? everyoneUnread : ownUnread,
            openPupu: { [weak self] in self?.go(.pupu) },
            openDocs: { [weak self] in self?.openDocs() },
            open: { [weak self] project in self?.open(project) },
            openChild: { [weak self] project, child in
                self?.open(project)
                self?.openChild(child, in: project)
            },
            create: { [weak self] in self?.createProject() },
            openSettings: { [weak self] in self?.openSettings() }
        )
        present(sheet(switcher), animated: true)
    }

    /// Artifacts：主界面里的一个地方。已经在这里时回到列表、重新拉一遍。
    private func openDocs() {
        view.endEditing(true)
        if place == .docs {
            docsView?.reload()
        } else {
            go(.docs)
        }
    }

    /// 成员胶囊：空间设置。全员只有组织创建者打得开；老项目没有主人，不弹。
    private func openSpaceSettings() {
        guard let project = currentProject ?? (place == .pupu ? ownSpace : nil) else { return }
        guard project.isEveryone ? project.mayManage == true : project.ownerId != nil else { return }
        present(sheet(SpaceSettingsViewController(projectId: project.id)), animated: true)
    }

    private func openChild(_ child: SpaceChild, in project: Project) {
        view.endEditing(true)
        navigationController?.pushViewController(ChildSessionViewController(identity: identity, project: project, child: child), animated: true)
    }

    /// 「正在做」里点了一行：带空间的去空间；对话里有这台电脑的卡就滚过去；都没有就打开设置里这台电脑。
    private func openActivity(_ activity: ComputerActivity) {
        if let ref = activity.project, let project = Store.shared.project(id: ref.id) {
            open(project)
            return
        }
        let chat = place == .pupu ? (Store.shared.synced ? ownChat : nil) : inEveryone ? spaceChatView : nil
        if !(chat?.showComputerCard(activity.computerId) ?? false) {
            openSettings(page: .computer(activity.computerId))
        }
    }

    private func openSettings(page: SettingsViewController.Page? = nil) {
        let navigation = SheetNavigationController(rootViewController: SettingsViewController())
        if let page { navigation.pushViewController(SettingsViewController(page: page), animated: false) }
        present(sheet(navigation), animated: true)
    }

    /// 整页 sheet（规范 SpaceSwitcher、SettingsSheet）：顶上把手，上角 `radius-sheet-top`。
    private func sheet(_ controller: UIViewController) -> UIViewController {
        if let sheet = controller.sheetPresentationController {
            sheet.detents = [.large()]
            sheet.prefersGrabberVisible = true
            sheet.preferredCornerRadius = Theme.Radius.sheetTop
        }
        return controller
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

/// 第一次拉到状态之前，会话卡里先转圈。
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
