import UIKit

/// 主页：一眼看到 Pupu 手上的事。现在有「项目」和「电脑」两块面板；
/// 「正在做」等云端报上电脑在做什么再加。底下的输入栏发的话进聊天。
final class HomeViewController: UIViewController {
    /// 主页上最多列这么多个项目，其余的在项目 sheet 里。
    private static let projectLimit = 5

    private let scroll = UIScrollView()
    private let stack = UIStackView()
    private let composer = ComposerView()
    private let openProject: (Project) -> Void
    private let openAllProjects: () -> Void
    private let openSettings: () -> Void
    private let send: (String) -> Void
    private var token: StoreToken?

    init(
        openProject: @escaping (Project) -> Void,
        openAllProjects: @escaping () -> Void,
        openSettings: @escaping () -> Void,
        send: @escaping (String) -> Void
    ) {
        self.openProject = openProject
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

        composer.placeholder = "给 Pupu 发消息"
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

    private func projectRows(_ store: Store) -> [UIView] {
        var rows: [UIView] = store.projects.prefix(Self.projectLimit).map { project in
            row(
                title: project.name,
                detail: project.goal.isEmpty ? nil : project.goal,
                trailing: Ago.text(project.updatedAt),
                dot: nil,
                label: "\(project.name)，\(Ago.text(project.updatedAt))"
            ) { [weak self] in self?.openProject(project) }
        }
        if store.projects.count > Self.projectLimit {
            rows.append(allProjectsRow(count: store.projects.count))
        }
        return rows
    }

    /// 面板末行「全部 N 个项目」，高 44，点开项目 sheet。
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
                trailing: nil,
                dot: computer.online ? Theme.online : Theme.offline,
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

    private func row(
        title: String,
        detail: String?,
        trailing: String?,
        dot: UIColor?,
        label: String,
        tap: @escaping () -> Void
    ) -> UIView {
        let surface = SurfaceView(.strong, radius: Theme.Radius.row)
        let name = UILabel(text: title, style: .headline)
        let text = UIStackView(arrangedSubviews: [name])
        text.axis = .vertical
        text.spacing = 2
        if let detail { text.addArrangedSubview(UILabel(text: detail, style: .subheadline, color: Theme.inkMuted)) }

        var items: [UIView] = []
        if let dot {
            let mark = UIView()
            mark.backgroundColor = dot
            mark.layer.cornerRadius = 4
            mark.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([mark.widthAnchor.constraint(equalToConstant: 8), mark.heightAnchor.constraint(equalToConstant: 8)])
            items.append(mark)
        }
        items.append(text)
        if let trailing {
            let time = UILabel(text: trailing, style: .caption, color: Theme.inkMuted)
            time.setContentHuggingPriority(.required, for: .horizontal)
            time.setContentCompressionResistancePriority(.required, for: .horizontal)
            items.append(time)
        }
        let line = UIStackView(arrangedSubviews: items)
        line.spacing = Theme.Space.s3
        line.alignment = .center
        surface.contentView.addSubview(line)
        line.pin(to: surface.contentView, insets: UIEdgeInsets(top: Theme.Space.s3, left: Theme.Space.s4, bottom: Theme.Space.s3, right: Theme.Space.s4))

        let button = UIButton(primaryAction: UIAction { _ in tap() })
        surface.addSubview(button)
        button.pin(to: surface)
        button.accessibilityLabel = label
        return surface
    }
}
