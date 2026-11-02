import UIKit

/// 主界面：顶栏的三段切换（主页、聊天、项目），右边设置。
/// 顶栏下方从上往下：等你批准的请示（哪一页都在）、项目页的项目名胶囊（点开切换项目）。
/// 这两样出现时把页面内容往下挤，不盖住对话。
final class ShellViewController: UIViewController {
    private enum Section: Int {
        case home, chat, projects
    }

    private static let lastProjectKey = "pupu.last-project"

    private let segments = SectionSwitch(titles: ["主页", "聊天", "项目"], selected: Section.chat.rawValue)
    private let container = UIView()
    private let approvals = ApprovalStackView()
    private let pill = ProjectPill()
    private let pillRow = PassThroughView()
    private let top = PassThroughStackView()
    /// 顶栏下方那一叠占的高度，加给当前页面的安全区。
    private var topInset: CGFloat = 0
    private var section: Section = .chat
    private var storeToken: StoreToken?

    private lazy var home = HomeViewController(
        openProject: { [weak self] project in self?.open(project) },
        openAllProjects: { [weak self] in self?.openSwitcher() },
        openSettings: { [weak self] in self?.openSettings() },
        send: { [weak self] text in self?.sendFromHome(text) }
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

        pill.addAction(UIAction { [weak self] _ in self?.openSwitcher() }, for: .touchUpInside)
        pill.translatesAutoresizingMaskIntoConstraints = false
        pillRow.addSubview(pill)
        NSLayoutConstraint.activate([
            pill.topAnchor.constraint(equalTo: pillRow.topAnchor),
            pill.bottomAnchor.constraint(equalTo: pillRow.bottomAnchor),
            pill.centerXAnchor.constraint(equalTo: pillRow.centerXAnchor),
            pill.widthAnchor.constraint(lessThanOrEqualTo: pillRow.widthAnchor, multiplier: Theme.Size.bubbleMax)
        ])
        approvals.isHidden = true
        pillRow.isHidden = true
        top.axis = .vertical
        top.spacing = Theme.Space.s3
        top.addArrangedSubview(approvals)
        top.addArrangedSubview(pillRow)
        top.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(top)
        NSLayoutConstraint.activate([
            top.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: Theme.Space.s2),
            top.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: Theme.Space.s4),
            top.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -Theme.Space.s4)
        ])

        storeToken = Store.shared.observe { [weak self] in self?.storeChanged() }
        Store.shared.startPolling()
        show(.chat)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let height = top.arrangedSubviews.contains { !$0.isHidden } ? top.bounds.height + Theme.Space.s3 : 0
        guard abs(height - topInset) > 0.5 else { return }
        topInset = height
        shown?.additionalSafeAreaInsets.top = height
    }

    private func storeChanged() {
        approvals.update(Store.shared.approvals)
        approvals.isHidden = Store.shared.approvals.isEmpty
        if section == .projects { showProjects() }
    }

    private func show(_ next: Section) {
        section = next
        segments.select(next.rawValue, animated: true)
        switch next {
        case .home:
            pillRow.isHidden = true
            display(home)
        case .chat:
            pillRow.isHidden = true
            display(chat)
        case .projects:
            showProjects()
        }
    }

    /// 「项目」直接打开上次的项目；没记住就打开最近活动的那个。
    private func showProjects() {
        let projects = Store.shared.projects
        let last = UserDefaults.standard.string(forKey: Self.lastProjectKey)
        guard let project = projects.first(where: { $0.id == last }) ?? projects.first else {
            pillRow.isHidden = true
            noProject.loaded = Store.shared.loaded
            display(noProject)
            return
        }
        pill.name = project.name
        pillRow.isHidden = false
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
        next.additionalSafeAreaInsets.top = topInset
        previous?.additionalSafeAreaInsets.top = 0
        shown = next
        setContentScrollView(next.contentScrollView(for: .top), for: .top)
    }

    /// 主页输入栏发的话：切到聊天，由聊天连上以后发出去。
    private func sendFromHome(_ text: String) {
        show(.chat)
        chat.deliver(text)
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

/// 项目页顶栏下方的胶囊：folder、项目名、chevron.down，高 36，点开项目切换的 sheet。
final class ProjectPill: UIControl {
    private let glass = GlassView(interactive: true)
    private let label = UILabel(style: .subheadline)

    var name = "" {
        didSet {
            label.text = name
            accessibilityLabel = "当前项目「\(name)」"
        }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        glass.isUserInteractionEnabled = false
        addSubview(glass)
        glass.pin(to: self)
        label.font = Theme.font(.subheadline, weight: .semibold)
        label.lineBreakMode = .byTruncatingTail
        let folder = UIImageView(image: UIImage(systemName: "folder"))
        let chevron = UIImageView(image: UIImage(systemName: "chevron.down"))
        for icon in [folder, chevron] {
            icon.tintColor = Theme.ink
            icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .subheadline, scale: .small)
            icon.setContentHuggingPriority(.required, for: .horizontal)
            icon.setContentCompressionResistancePriority(.required, for: .horizontal)
        }
        let line = UIStackView(arrangedSubviews: [folder, label, chevron])
        line.spacing = 6
        line.alignment = .center
        line.isUserInteractionEnabled = false
        addSubview(line)
        line.pin(to: self, insets: UIEdgeInsets(top: 0, left: 14, bottom: 0, right: Theme.Space.s3))
        heightAnchor.constraint(greaterThanOrEqualToConstant: Theme.Size.controlSmall).isActive = true
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityHint = "切换项目"
    }

    required init?(coder: NSCoder) { fatalError() }

    /// 画的是 36 高，点的范围补到 44。
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        bounds.insetBy(dx: 0, dy: -(Theme.Size.control - bounds.height) / 2).contains(point)
    }
}

/// 自己不接点击、只让子视图接的容器：顶栏下方那一叠的空白处，点到的是下面的内容。
final class PassThroughView: UIView {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        return hit === self ? nil : hit
    }
}

final class PassThroughStackView: UIStackView {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        return hit === self ? nil : hit
    }
}
