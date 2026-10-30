import UIKit

/// 主界面：顶栏的三段切换（主页、聊天、项目），右边设置，项目页左边是项目切换。
/// 等你批准的请示挂在顶栏下方，哪一页都在。
final class ShellViewController: UIViewController {
    private enum Section: Int {
        case home, chat, projects
    }

    private static let lastProjectKey = "pupu.last-project"

    private let segments = SectionSwitch(titles: ["主页", "聊天", "项目"], selected: Section.chat.rawValue)
    private let container = UIView()
    private let approvals = ApprovalStackView()
    private var section: Section = .chat
    private var storeToken: StoreToken?

    private lazy var home = HomeViewController(
        openProject: { [weak self] project in self?.open(project) },
        openSettings: { [weak self] in self?.openSettings() }
    )
    private lazy var chat = ChatViewController(
        session: "1",
        placeholder: "给 Pupu 发消息",
        projectTags: true,
        openProject: { [weak self] id in
            if let project = Store.shared.project(id: id) { self?.open(project) }
        }
    )
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
        navigationItem.titleView = segments

        let settings = UIBarButtonItem(title: "我", primaryAction: UIAction { [weak self] _ in self?.openSettings() })
        settings.accessibilityLabel = "设置"
        navigationItem.rightBarButtonItem = settings

        container.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(container)
        container.pin(to: view)

        approvals.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(approvals)
        NSLayoutConstraint.activate([
            approvals.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: Theme.Space.s2),
            approvals.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: Theme.Space.s4),
            approvals.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -Theme.Space.s4)
        ])

        storeToken = Store.shared.observe { [weak self] in self?.storeChanged() }
        Store.shared.startPolling()
        show(.chat)
    }

    private func storeChanged() {
        approvals.update(Store.shared.approvals)
        if section == .projects { showProjects() }
    }

    private func show(_ next: Section) {
        section = next
        segments.select(next.rawValue, animated: true)
        switch next {
        case .home:
            navigationItem.leftBarButtonItem = nil
            display(home)
        case .chat:
            navigationItem.leftBarButtonItem = nil
            display(chat)
        case .projects:
            let switcher = UIBarButtonItem(
                image: UIImage(systemName: "line.3.horizontal"),
                primaryAction: UIAction { [weak self] _ in self?.openSwitcher() }
            )
            switcher.accessibilityLabel = "切换项目"
            navigationItem.leftBarButtonItem = switcher
            showProjects()
        }
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
        UserDefaults.standard.set(project.id, forKey: Self.lastProjectKey)
        if projectChat?.session != project.session {
            projectChat = ChatViewController(
                session: project.session,
                placeholder: "在「\(project.name)」里说",
                projectTags: false,
                emptyProject: project,
                openProject: { _ in }
            )
        }
        if let projectChat { display(projectChat) }
    }

    private func display(_ next: UIViewController) {
        guard shown !== next else { return }
        let previous = shown
        addChild(next)
        container.addSubview(next.view)
        next.view.pin(to: container)
        next.view.alpha = 0
        UIView.animate(withDuration: UIAccessibility.isReduceMotionEnabled ? 0.15 : 0.2) {
            next.view.alpha = 1
            previous?.view.alpha = 0
        } completion: { _ in
            previous?.willMove(toParent: nil)
            previous?.view.removeFromSuperview()
            previous?.removeFromParent()
            previous?.view.alpha = 1
        }
        next.didMove(toParent: self)
        shown = next
        setContentScrollView(next.contentScrollView(for: .top), for: .top)
    }

    private func open(_ project: Project) {
        UserDefaults.standard.set(project.id, forKey: Self.lastProjectKey)
        show(.projects)
    }

    private func openSwitcher() {
        let current = UserDefaults.standard.string(forKey: Self.lastProjectKey)
        let switcher = ProjectSwitcherViewController(
            current: current,
            open: { [weak self] project in self?.open(project) },
            create: { [weak self] in self?.createProject() }
        )
        let navigation = UINavigationController(rootViewController: switcher)
        if let sheet = navigation.sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.prefersGrabberVisible = true
        }
        present(navigation, animated: true)
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
        let host = presentedViewController ?? self
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
                    Store.shared.refresh()
                    self?.dismiss(animated: true)
                    self?.open(project)
                } catch {
                    self?.showError(error.localizedDescription)
                }
            }
        })
        host.present(alert, animated: true)
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
