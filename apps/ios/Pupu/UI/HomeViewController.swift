import UIKit

/// 主页：一眼看到 Pupu 手上的事。最上面「正在做」，下面是「项目」和「电脑」。
/// 底下的输入栏发的话进中间一段当前那条聊天。
final class HomeViewController: UIViewController {
    /// 主页上最多列这么多个项目，其余的在整页项目列表里。
    private static let projectLimit = 5

    private let scroll = UIScrollView()
    private let stack = UIStackView()
    private let composer = ComposerView()
    private let openProject: (Project) -> Void
    private let openChat: () -> Void
    private let openAllProjects: () -> Void
    private let openSettings: () -> Void
    private let send: (String) -> Void
    private var token: StoreToken?

    var placeholder: String {
        get { composer.placeholder }
        set { composer.placeholder = newValue }
    }

    /// 正在收回屏幕控制的电脑。收回的请求在路上时按钮转圈，重画面板也不丢。
    private var takingBack: Set<String> = []
    /// 上次收回失败的电脑和原因，显示在那一行的第二行。
    private var takebackErrors: [String: String] = [:]

    init(
        openProject: @escaping (Project) -> Void,
        openChat: @escaping () -> Void,
        openAllProjects: @escaping () -> Void,
        openSettings: @escaping () -> Void,
        send: @escaping (String) -> Void
    ) {
        self.openProject = openProject
        self.openChat = openChat
        self.openAllProjects = openAllProjects
        self.openSettings = openSettings
        self.send = send
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        scroll.alwaysBounceVertical = true
        scroll.keyboardDismissMode = .interactive
        scroll.topEdgeEffect.style = .soft
        view.addSubview(scroll)
        scroll.pin(to: view)

        stack.axis = .vertical
        stack.spacing = Theme.Space.s3
        stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(stack)
        let content = scroll.contentLayoutGuide
        let frame = scroll.frameLayoutGuide
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: Theme.Space.s2),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -Theme.Space.s8),
            stack.centerXAnchor.constraint(equalTo: frame.centerXAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: Theme.Size.columnMax),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: frame.leadingAnchor, constant: Theme.Space.s4),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: frame.trailingAnchor, constant: -Theme.Space.s4)
        ])
        let fill = stack.widthAnchor.constraint(equalTo: frame.widthAnchor, constant: -2 * Theme.Space.s4)
        fill.priority = .defaultHigh
        fill.isActive = true

        composer.connected = true
        composer.onSend = { [weak self] text in
            let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let self, !value.isEmpty else { return }
            self.composer.clear()
            self.composer.textView.resignFirstResponder()
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            self.send(value)
        }
        composer.onResize = { [weak self] in
            guard let self, self.view.window != nil else { return }
            UIView.animate(springDuration: 0.25, bounce: 0) { self.view.layoutIfNeeded() }
        }
        composer.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(composer)
        NSLayoutConstraint.activate([
            composer.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: Theme.Space.s4),
            composer.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -Theme.Space.s4),
            composer.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor, constant: -Theme.Space.s3)
        ])
        let edge = UIScrollEdgeElementContainerInteraction()
        edge.scrollView = scroll
        edge.edge = .bottom
        composer.addInteraction(edge)

        token = Store.shared.observe { [weak self] in self?.render() }
        render()
    }

    override func contentScrollView(for edge: NSDirectionalRectEdge) -> UIScrollView? { scroll }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // 输入栏浮在面板上面：滚动区底部留出输入栏（和键盘）占的高度。
        let covered = view.bounds.height - composer.frame.minY + Theme.Space.s3
        let inset = max(0, covered - view.safeAreaInsets.bottom)
        if abs(scroll.contentInset.bottom - inset) > 0.5 {
            scroll.contentInset.bottom = inset
            scroll.verticalScrollIndicatorInsets.bottom = inset
        }
    }

    private func render() {
        for view in stack.arrangedSubviews { view.removeFromSuperview() }
        let store = Store.shared
        stack.addArrangedSubview(panel(icon: "waveform.path.ecg", title: "正在做", rows: activityRows(store), empty:
            store.loaded ? "Pupu 手上没有在跑的事。" : "加载中…"))
        stack.addArrangedSubview(panel(icon: "folder", title: "项目", rows: projectRows(store), empty:
            store.loaded ? "还没有项目。在聊天里说要做的事，Pupu 会问你要不要建一个。" : "加载中…"))
        stack.addArrangedSubview(panel(icon: "desktopcomputer", title: "电脑", rows: computerRows(store), empty:
            store.loaded ? "还没有授权的电脑。在电脑上配对桥之后，这里会显示它在不在线。" : "加载中…"))
        if let error = store.error {
            let note = SurfaceView(.strong, radius: Theme.Radius.row)
            let label = UILabel(text: "连不上 Pupu：\(error)", style: .subheadline, color: Theme.dangerInk, lines: 0)
            note.contentView.addSubview(label)
            label.pin(to: note.contentView, insets: UIEdgeInsets(top: Theme.Space.s2_5, left: Theme.Space.s4, bottom: Theme.Space.s2_5, right: Theme.Space.s4))
            stack.insertArrangedSubview(note, at: 0)
        }
    }

    /// 「正在做」列哪些电脑：在做事的、停着等批的，还有闲着但屏幕控制没收回的。
    private func activityRows(_ store: Store) -> [UIView] {
        store.activity.compactMap { activity in
            switch activity.currentState {
            case .working, .waiting: break
            case .idle where activity.screen: break
            default: return nil
            }
            return activityRow(activity)
        }
    }

    /// 「正在做」的一行：在做什么，第二行是哪台电脑、哪个项目、做了多久。点开去那个项目，主对话里的去聊天。
    /// 屏幕控制还在时右边带「收回」。
    private func activityRow(_ activity: ComputerActivity) -> UIView {
        let state = activity.currentState
        let mark: UIView
        if state == .working {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.startAnimating()
            mark = spinner
        } else {
            mark = dot(state == .waiting ? Theme.warning : Theme.online)
        }
        // 转圈和圆点放进同样宽的格子，几行的字对齐。
        let leading = UIView()
        leading.addSubview(mark)
        mark.translatesAutoresizingMaskIntoConstraints = false
        leading.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            leading.widthAnchor.constraint(equalToConstant: 20),
            leading.heightAnchor.constraint(equalToConstant: 20),
            mark.centerXAnchor.constraint(equalTo: leading.centerXAnchor),
            mark.centerYAnchor.constraint(equalTo: leading.centerYAnchor)
        ])
        let title = activity.doing ?? "闲着，屏幕控制还开着"
        let error = takebackErrors[activity.computerId]
        let detail = error ?? [activity.computerName, activity.project?.name, activity.since.map { Ago.text($0) }]
            .compactMap { $0 }
            .joined(separator: " · ")
        var trailing: [UIView] = []
        if state == .waiting { trailing.append(WaitingMark()) }
        var takeback: UIButton?
        if activity.screen {
            let button = UIButton.glass(title: "收回")
            button.configuration?.buttonSize = .small
            button.configuration?.showsActivityIndicator = takingBack.contains(activity.computerId)
            button.isEnabled = !takingBack.contains(activity.computerId)
            button.setContentHuggingPriority(.required, for: .horizontal)
            button.setContentCompressionResistancePriority(.required, for: .horizontal)
            button.addAction(UIAction { [weak self] _ in self?.takeback(activity.computerId) }, for: .touchUpInside)
            button.accessibilityLabel = "收回「\(activity.computerName)」的屏幕控制"
            takeback = button
        }
        let project = activity.project.flatMap { Store.shared.project(id: $0.id) }
        return row(
            title: title,
            detail: detail,
            detailColor: error == nil ? Theme.inkMuted : Theme.dangerInk,
            leading: leading,
            trailing: trailing,
            accessory: takeback,
            label: "\(title)，\(detail)\(state == .waiting ? "，等你批准" : "")"
        ) { [weak self] in
            if let project { self?.openProject(project) } else { self?.openChat() }
        }
    }

    private func takeback(_ computerId: String) {
        guard let api = Store.shared.api, !takingBack.contains(computerId) else { return }
        takingBack.insert(computerId)
        takebackErrors[computerId] = nil
        render()
        Task {
            do {
                try await api.takeback(computer: computerId)
            } catch {
                takebackErrors[computerId] = "没收回：\(error.localizedDescription)"
            }
            takingBack.remove(computerId)
            render()
            Store.shared.refresh()
        }
    }

    private func projectRows(_ store: Store) -> [UIView] {
        // 停在哪些项目里等你批。一台电脑只带得出最早那条请示的项目。
        let waiting = Set(store.activity.compactMap { $0.currentState == .waiting ? $0.project?.id : nil })
        var rows: [UIView] = store.projects.prefix(Self.projectLimit).map { project in
            let isWaiting = waiting.contains(project.id)
            let when = Ago.text(project.updatedAt)
            return row(
                title: project.name,
                detail: project.summary,
                trailing: [isWaiting ? WaitingMark() : caption(when)],
                label: "\(project.name)，\(isWaiting ? "等你批准" : when)"
            ) { [weak self] in self?.openProject(project) }
        }
        if store.projects.count > Self.projectLimit {
            rows.append(allProjectsRow(count: store.projects.count))
        }
        return rows
    }

    /// 面板末行「全部 N 个项目」，高 44，点开整页项目列表。
    private func allProjectsRow(count: Int) -> UIView {
        let title = UILabel(text: "全部 \(count) 个项目", style: .subheadline)
        title.font = Theme.font(.subheadline, weight: .medium)
        let chevron = UIImageView(image: UIImage(systemName: "chevron.right"))
        chevron.tintColor = Theme.inkMuted
        chevron.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .subheadline)
        chevron.setContentHuggingPriority(.required, for: .horizontal)
        let line = UIStackView(arrangedSubviews: [title, chevron])
        line.alignment = .center
        line.spacing = Theme.Space.s2
        let container = UIView()
        container.addSubview(line)
        line.pin(to: container, insets: UIEdgeInsets(top: 0, left: Theme.Space.s4, bottom: 0, right: Theme.Space.s4))
        container.heightAnchor.constraint(greaterThanOrEqualToConstant: Theme.Size.control).isActive = true
        let button = UIButton(primaryAction: UIAction { [weak self] _ in self?.openAllProjects() })
        container.addSubview(button)
        button.pin(to: container)
        button.accessibilityLabel = "全部 \(count) 个项目"
        return container
    }

    private func computerRows(_ store: Store) -> [UIView] {
        store.computers.map { computer in
            row(
                title: computer.name,
                detail: computer.label,
                leading: dot(computer.online ? Theme.online : Theme.offline),
                label: "\(computer.name)，\(computer.label)"
            ) { [weak self] in self?.openSettings() }
        }
    }

    private func panel(icon: String, title: String, rows: [UIView], empty: String) -> UIView {
        let panel = SurfaceView(.glass, radius: Theme.Radius.panel, lifted: true)
        let image = UIImageView(image: UIImage(systemName: icon))
        image.tintColor = Theme.ink
        image.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .headline)
        image.setContentHuggingPriority(.required, for: .horizontal)
        image.setContentCompressionResistancePriority(.required, for: .horizontal)
        let heading = UIStackView(arrangedSubviews: [image, UILabel(text: title, style: .headline)])
        heading.spacing = Theme.Space.s2
        heading.alignment = .center
        heading.accessibilityTraits = .header

        let list = UIStackView(arrangedSubviews: rows.isEmpty
            ? [UILabel(text: empty, style: .subheadline, lines: 0)]
            : rows)
        list.axis = .vertical
        list.spacing = Theme.Space.s2

        let stack = UIStackView(arrangedSubviews: [heading, list])
        stack.axis = .vertical
        stack.spacing = Theme.Space.s3
        panel.contentView.addSubview(stack)
        stack.pin(to: panel.contentView, insets: UIEdgeInsets(top: Theme.Space.s4, left: Theme.Space.s4, bottom: Theme.Space.s4, right: Theme.Space.s4))
        return panel
    }

    /// 面板里的一行：左边的状态点或转圈、名字和第二行、右边的时间或标记。
    /// accessory 是行里另一个能点的按钮（「收回」），整行的点按区域让开它。
    private func row(
        title: String,
        detail: String?,
        detailColor: UIColor = Theme.inkMuted,
        leading: UIView? = nil,
        trailing: [UIView] = [],
        accessory: UIView? = nil,
        label: String,
        tap: @escaping () -> Void
    ) -> UIView {
        let surface = SurfaceView(.strong, radius: Theme.Radius.row)
        let name = UILabel(text: title, style: .headline)
        let text = UIStackView(arrangedSubviews: [name])
        text.axis = .vertical
        text.spacing = 2
        if let detail { text.addArrangedSubview(UILabel(text: detail, style: .subheadline, color: detailColor)) }
        // 放不下时字先截断，右边的时间、标记和按钮保持完整。
        for label in text.arrangedSubviews {
            label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        }

        let items = [leading].compactMap { $0 } + [text] + trailing + [accessory].compactMap { $0 }
        let line = UIStackView(arrangedSubviews: items)
        line.spacing = Theme.Space.s3
        line.alignment = .center
        surface.contentView.addSubview(line)
        line.pin(to: surface.contentView, insets: UIEdgeInsets(top: Theme.Space.s3, left: Theme.Space.s4, bottom: Theme.Space.s3, right: Theme.Space.s4))

        let button = UIButton(primaryAction: UIAction { _ in tap() })
        surface.addSubview(button)
        button.accessibilityLabel = label
        if let accessory {
            button.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                button.leadingAnchor.constraint(equalTo: surface.leadingAnchor),
                button.topAnchor.constraint(equalTo: surface.topAnchor),
                button.bottomAnchor.constraint(equalTo: surface.bottomAnchor),
                button.trailingAnchor.constraint(equalTo: accessory.leadingAnchor, constant: -Theme.Space.s1)
            ])
        } else {
            button.pin(to: surface)
        }
        return surface
    }

    private func dot(_ color: UIColor) -> UIView {
        let mark = UIView()
        mark.backgroundColor = color
        mark.layer.cornerRadius = 4
        mark.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([mark.widthAnchor.constraint(equalToConstant: 8), mark.heightAnchor.constraint(equalToConstant: 8)])
        return mark
    }

    private func caption(_ text: String) -> UILabel {
        let label = UILabel(text: text, style: .caption, color: Theme.inkMuted)
        label.setContentHuggingPriority(.required, for: .horizontal)
        label.setContentCompressionResistancePriority(.required, for: .horizontal)
        return label
    }
}
