import UIKit

/// 一个会话的对话页：聊天和每个项目都用它。
/// 列表从上往下排；在底部时跟着新内容走，用户往上翻了就不打扰。
/// 这几处的做法参考了 Signal-iOS 的 ConversationViewController（只看思路，没有搬代码）：
/// 输入栏是贴着 keyboardLayoutGuide 的普通子视图，列表的底部留白跟着输入栏的位置改。
final class ChatViewController: UIViewController, UICollectionViewDelegate, UIGestureRecognizerDelegate {
    /// 空会话的样子。聊天：Pupu 先介绍自己，再给三个开场建议。项目：一张写着项目名和目标的卡片。
    enum Opening {
        case intro(String)
        case project(Project)
    }

    let session: String
    /// 用户滚动时告诉外面到没到最新的消息。
    var onScroll: ((Bool) -> Void)?
    private let placeholder: String
    private let projectTags: Bool
    private let opening: Opening
    private let openProject: (String) -> Void
    private let identity: Identity

    private static let starters = ["我想做一个新功能，帮我理一理", "帮我规划一下这周要做的事", "我现在有哪些项目？"]
    /// 离底部这么近就算在底部，新内容来了跟着滚。
    private static let stickDistance: CGFloat = 80
    /// 右滑过这么远松手就是回复。
    private static let swipeDistance: CGFloat = 60

    private var socket: SessionSocket?
    private var state = SessionView()
    private var loaded = false
    /// 输入栏里那条发出去了、Pupu 还没收下。这期间输入栏锁着，字和引用都留着；被拒了就解锁。
    private var sending = false {
        didSet { composer.sending = sending }
    }
    private var toggled = Set<String>()
    /// 每台电脑上 Pupu 浏览器最新的一帧（这个会话里的）。
    private var frames: [String: BrowserFrame] = [:]
    /// 每张浏览器卡片最后看到的画面：做完了还留着，重开页面就没了。
    private var cardFrames: [String: UIImage] = [:]
    /// 打开了「计划」的卡片。
    private var planOpen = Set<String>()
    private weak var large: BrowserLargeViewController?
    private var largeId: String?
    private var rowsByID: [String: ChatRow] = [:]
    private var rowIDs: [String] = []

    private var collectionView: UICollectionView!
    private var source: UICollectionViewDiffableDataSource<Int, String>!
    private let composer = ComposerView()
    private let statusLabel = UILabel(style: .footnote, color: Theme.inkSkyMuted, lines: 0)
    private let quotePreview = QuotePreview()
    private let bottom = UIStackView()
    private let overlay = UIVisualEffectView(effect: nil)
    private let scrim = UIView()
    private let empty = UIStackView()
    private let flow = FlowView()
    private let spinner = UIActivityIndicatorView(style: .medium)
    /// 往上翻了才出现：右下角的玻璃圆按钮，点了回到最新的消息。
    private let jump = UIButton(configuration: .glass())

    private var quote: String?
    private var stick = true {
        didSet { if stick != oldValue { updateJump() } }
    }
    private var renderScheduled = false
    private var width: CGFloat = 0
    private var storeToken: StoreToken?
    private var swipe: (cell: ChatCell, id: String, armed: Bool)?
    private var markingSeen = false

    init(
        identity: Identity,
        session: String,
        placeholder: String,
        projectTags: Bool,
        opening: Opening,
        openProject: @escaping (String) -> Void
    ) {
        self.identity = identity
        self.session = session
        self.placeholder = placeholder
        self.projectTags = projectTags
        self.opening = opening
        self.openProject = openProject
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError() }

    isolated deinit {
        socket?.stop()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        // iOS 26 上 keyboardLayoutGuide 第一次读得太晚会报成 34pt，先碰一下（Signal 的 ConversationInputToolbar 记了这个坑）。
        _ = view.keyboardLayoutGuide
        setUpList()
        setUpEmpty()
        setUpOverlay()
        setUpBottom()
        setUpJump()
        storeToken = Store.shared.observe { [weak self] in self?.scheduleRender() }
        registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) { (controller: ChatViewController, _: UITraitCollection) in
            Markdown.reset()
            controller.reconfigureAll()
        }
        connect()
        render()
    }

    override func contentScrollView(for edge: NSDirectionalRectEdge) -> UIScrollView? { collectionView }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        if view.bounds.width != width {
            width = view.bounds.width
            flow.preferredWidth = width - Theme.Space.s6 * 2
            reconfigureAll()
        }
        // 输入栏浮在列表上面：列表底部留出输入栏（和键盘）占的高度。
        let covered = view.bounds.height - bottom.frame.minY
        let inset = max(0, covered - view.safeAreaInsets.bottom)
        if abs(collectionView.contentInset.bottom - inset) > 0.5 {
            collectionView.contentInset.bottom = inset
            collectionView.verticalScrollIndicatorInsets.bottom = inset
            if stick { scrollToBottom() }
        }
    }

    // MARK: - 布局

    private func setUpList() {
        let size = NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: .estimated(60))
        let group = NSCollectionLayoutGroup.vertical(layoutSize: size, subitems: [NSCollectionLayoutItem(layoutSize: size)])
        let section = NSCollectionLayoutSection(group: group)
        // 项目对话的第一条让开项目名胶囊：对话短到滚不动时，它不能一直盖着字。
        var clearance: CGFloat = 0
        if case .project = opening { clearance = ProjectPill.height + Theme.Space.s2 }
        section.contentInsets = NSDirectionalEdgeInsets(
            top: Theme.Space.s2 + clearance,
            leading: Theme.Space.s4,
            bottom: Theme.Space.s4,
            trailing: Theme.Space.s4
        )
        collectionView = UICollectionView(frame: .zero, collectionViewLayout: UICollectionViewCompositionalLayout(section: section))
        collectionView.backgroundColor = .clear
        collectionView.alwaysBounceVertical = true
        collectionView.keyboardDismissMode = .interactive
        collectionView.topEdgeEffect.style = .soft
        collectionView.delegate = self
        view.addSubview(collectionView)
        collectionView.pin(to: view)

        let users = registration(UserCell.self)
        let others = registration(OtherCell.self)
        let assistants = registration(AssistantCell.self)
        let typing = registration(TypingCell.self)
        let tags = registration(TagCell.self)
        let tools = registration(ToolCell.self)
        let notices = registration(NoticeCell.self)
        let errors = registration(ErrorCell.self)
        let reports = registration(ReportCell.self)
        let browsers = registration(BrowserCardCell.self)
        source = UICollectionViewDiffableDataSource(collectionView: collectionView) { [weak self] view, path, id in
            switch self?.rowsByID[id]?.kind {
            case .user: return view.dequeueConfiguredReusableCell(using: users, for: path, item: id)
            case .other: return view.dequeueConfiguredReusableCell(using: others, for: path, item: id)
            case .assistant: return view.dequeueConfiguredReusableCell(using: assistants, for: path, item: id)
            case .typing: return view.dequeueConfiguredReusableCell(using: typing, for: path, item: id)
            case .projectTag: return view.dequeueConfiguredReusableCell(using: tags, for: path, item: id)
            case .tool, .toolGroup: return view.dequeueConfiguredReusableCell(using: tools, for: path, item: id)
            case .notice, .handoff: return view.dequeueConfiguredReusableCell(using: notices, for: path, item: id)
            case .report: return view.dequeueConfiguredReusableCell(using: reports, for: path, item: id)
            case .browser: return view.dequeueConfiguredReusableCell(using: browsers, for: path, item: id)
            case .error, nil: return view.dequeueConfiguredReusableCell(using: errors, for: path, item: id)
            }
        }

        // 滚动手势等右滑手势先判断：明显向右的横滑才是回复，其余照常滚动。
        let pan = UIPanGestureRecognizer(target: self, action: #selector(swiped))
        pan.delegate = self
        collectionView.addGestureRecognizer(pan)
        collectionView.panGestureRecognizer.require(toFail: pan)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        markSeen()
    }

    private func registration<Cell: ChatCell>(_ type: Cell.Type) -> UICollectionView.CellRegistration<Cell, String> {
        UICollectionView.CellRegistration<Cell, String> { [weak self] cell, _, id in
            guard let self, let row = self.rowsByID[id] else { return }
            self.configure(cell, row: row)
        }
    }

    private func setUpEmpty() {
        empty.axis = .vertical
        empty.alignment = .center
        empty.spacing = Theme.Space.s5
        empty.translatesAutoresizingMaskIntoConstraints = false
        switch opening {
        case .project(let project):
            let card = SurfaceView(.strong, radius: Theme.Radius.panel, lifted: true)
            let name = UILabel(text: project.name, style: .headline, lines: 0)
            let goal = UILabel(
                text: project.goal.isBlank ? "还没写目标。在下面说说这个项目要做成什么样。" : project.goal,
                style: .subheadline,
                color: Theme.inkMuted,
                lines: 0
            )
            let stack = UIStackView(arrangedSubviews: [name, goal])
            stack.axis = .vertical
            stack.spacing = Theme.Space.s1
            card.contentView.addSubview(stack)
            stack.pin(to: card.contentView, insets: UIEdgeInsets(top: Theme.Space.s4, left: Theme.Space.s4, bottom: Theme.Space.s4, right: Theme.Space.s4))
            empty.addArrangedSubview(card)
            card.widthAnchor.constraint(equalTo: empty.widthAnchor).isActive = true
        case .intro(let text):
            let greeting = UILabel(text: "我是 Pupu", style: .greeting, color: Theme.inkSky)
            greeting.accessibilityTraits = .header
            let intro = UILabel(style: .message, color: Theme.inkSky, lines: 0)
            let attributes = Theme.messageAttributes(color: Theme.inkSky)
            let paragraph = Theme.messageParagraph()
            paragraph.alignment = .center
            var centered = attributes
            centered[.paragraphStyle] = paragraph
            intro.attributedText = NSAttributedString(
                string: text,
                attributes: centered
            )
            let words = UIStackView(arrangedSubviews: [greeting, intro])
            words.axis = .vertical
            words.alignment = .center
            words.spacing = Theme.Space.s2
            flow.setItems(Self.starters.map(starterButton))
            empty.addArrangedSubview(words)
            empty.addArrangedSubview(flow)
        }
        empty.isHidden = true
        view.addSubview(empty)
    }

    private func starterButton(_ text: String) -> UIButton {
        var config = UIButton.Configuration.plain()
        config.title = text
        config.baseForegroundColor = Theme.ink
        config.cornerStyle = .capsule
        config.contentInsets = NSDirectionalEdgeInsets(top: 7, leading: Theme.Space.s3, bottom: 7, trailing: Theme.Space.s3)
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = Theme.font(.subheadline)
            return attributes
        }
        var background = UIBackgroundConfiguration.clear()
        background.backgroundColor = Theme.surfaceGlass
        background.visualEffect = UIBlurEffect(style: .systemUltraThinMaterial)
        background.strokeColor = Theme.lineGlass
        background.strokeWidth = 1
        config.background = background
        let button = UIButton(configuration: config)
        button.addAction(UIAction { [weak self] _ in
            guard let self, !self.sending else { return }
            self.composer.fill(text)
            self.send()
        }, for: .primaryActionTriggered)
        return button
    }

    /// 引用回复时把对话压一层并模糊，点空白处取消。
    private func setUpOverlay() {
        scrim.backgroundColor = Theme.scrim
        overlay.contentView.addSubview(scrim)
        scrim.pin(to: overlay.contentView)
        overlay.isHidden = true
        overlay.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(cancelQuote)))
        overlay.isAccessibilityElement = true
        overlay.accessibilityLabel = "取消回复"
        overlay.accessibilityTraits = .button
        view.addSubview(overlay)
        overlay.pin(to: view)
    }

    private func setUpBottom() {
        composer.placeholder = placeholder
        composer.onSend = { [weak self] in self?.send() }
        composer.onStop = { [weak self] in self?.socket?.abort() }
        composer.onResize = { [weak self] in
            guard let self, self.view.window != nil else { return }
            UIView.animate(springDuration: 0.25, bounce: 0) { self.view.layoutIfNeeded() }
        }
        quotePreview.onCancel = { [weak self] in self?.cancelQuote() }
        quotePreview.isHidden = true
        statusLabel.textAlignment = .center
        statusLabel.isHidden = true
        spinner.color = Theme.inkSky
        spinner.hidesWhenStopped = true
        spinner.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(spinner)

        bottom.axis = .vertical
        bottom.spacing = Theme.Space.s2
        bottom.addArrangedSubview(quotePreview)
        bottom.addArrangedSubview(statusLabel)
        bottom.addArrangedSubview(composer)
        bottom.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(bottom)

        // 列表滚到输入栏后面时，系统在这一段画底部的滚动边缘效果。
        let edge = UIScrollEdgeElementContainerInteraction()
        edge.scrollView = collectionView
        edge.edge = .bottom
        bottom.addInteraction(edge)

        let middle = UILayoutGuide()
        view.addLayoutGuide(middle)
        NSLayoutConstraint.activate([
            bottom.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: Theme.Space.s4),
            bottom.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -Theme.Space.s4),
            bottom.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor, constant: -Theme.Space.s3),
            middle.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            middle.bottomAnchor.constraint(equalTo: bottom.topAnchor),
            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: middle.centerYAnchor),
            empty.centerYAnchor.constraint(equalTo: middle.centerYAnchor),
            empty.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: Theme.Space.s6),
            empty.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -Theme.Space.s6)
        ])
    }

    // MARK: - 连接

    private func connect() {
        let socket = SessionSocket(endpoint: identity.endpoint, session: session)
        socket.onOpenChanged = { [weak self] _ in self?.scheduleRender() }
        socket.onEvents = { [weak self] events in self?.receive(events) }
        socket.onChanged = { Store.shared.refresh() }
        socket.onActivity = { [identity] in Store.shared.apply(activity: $0, for: identity) }
        socket.onBrowserFrame = { [weak self] frame in self?.receive(frame) }
        socket.onError = { [weak self] message in
            self?.state.error = message
            self?.scheduleRender()
        }
        socket.start()
        self.socket = socket
    }

    private func receive(_ events: [JSON]) {
        state = Reducer.reduce(state, events: events)
        if !loaded, events.contains(where: { $0["type"]?.string == "snapshot" }) {
            loaded = true
            stick = true
        }
        scheduleRender()
    }

    /// 新的一帧画面：只重画浏览器卡片，放大的画面也跟着换。
    private func receive(_ frame: BrowserFrame) {
        frames[frame.computerId] = frame
        let ids = rowIDs.filter { id in
            if case .browser = rowsByID[id]?.kind { return true }
            return false
        }
        if !ids.isEmpty {
            var snapshot = source.snapshot()
            snapshot.reconfigureItems(ids)
            source.apply(snapshot, animatingDifferences: false)
        }
        if let largeId, let large, case .browser(let task) = rowsByID[largeId]?.kind {
            large.update(task: task, frame: frameFor(task))
        }
    }

    /// 卡片上该放哪一帧。正在做的卡片跟着最新的帧；最后一张卡做完得快、第一帧晚到，也收下。
    private func frameFor(_ task: BrowserTask) -> UIImage? {
        let last = rowIDs.last { id in
            if case .browser = rowsByID[id]?.kind { return true }
            return false
        }
        if task.active || (task.id == last && cardFrames[task.id] == nil) {
            let live = task.computerId.flatMap { frames[$0] } ?? (frames.count == 1 ? frames.values.first : nil)
            if let live { cardFrames[task.id] = live.image }
        }
        return cardFrames[task.id]
    }

    /// 流式输出时一秒几十个事件，攒一攒，最多 30 帧一画。
    private func scheduleRender() {
        guard !renderScheduled else { return }
        renderScheduled = true
        Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(33))
            guard let self else { return }
            self.renderScheduled = false
            self.render()
        }
    }

    // MARK: - 画列表

    private func render(animated: Bool = false) {
        let store = Store.shared
        let context = ChatContext(
            projectTags: projectTags,
            projects: store.projects,
            computers: store.computers,
            approvals: store.approvals,
            members: store.members,
            reports: store.reportCards(in: session),
            toggled: toggled
        )
        let rows = ChatRows.build(state, context: context)
        let previous = rowsByID
        rowsByID = Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let ids = rows.map(\.id)

        var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
        snapshot.appendSections([0])
        snapshot.appendItems(ids)
        var reconfigure: [String] = []
        var reload: [String] = []
        for row in rows {
            guard let old = previous[row.id], old != row else { continue }
            if Self.cellType(old.kind) == Self.cellType(row.kind) { reconfigure.append(row.id) } else { reload.append(row.id) }
        }
        snapshot.reconfigureItems(reconfigure)
        snapshot.reloadItems(reload)

        let follow = stick
        let first = rowIDs.isEmpty
        rowIDs = ids
        source.apply(snapshot, animatingDifferences: animated && !first) { [weak self] in
            if follow { self?.scrollToBottom() }
        }

        empty.isHidden = !(loaded && ids.isEmpty)
        if loaded { spinner.stopAnimating() } else { spinner.startAnimating() }
        composer.running = state.running
        composer.connected = socket?.isOpen == true
        updateStatus()
        markSeen()
    }

    /// 人在项目里：这个项目报回聊天的结果都算看过，在这里时新报回来的也是。
    private func markSeen() {
        let store = Store.shared
        guard !markingSeen, view.window != nil,
              let project = store.projects.first(where: { $0.session == session }),
              store.reports.contains(where: { $0.projectId == project.id && !$0.seen }),
              let api = store.api
        else { return }
        markingSeen = true
        Task {
            try? await api.markSeen(project: project.id)
            markingSeen = false
            Store.shared.refresh()
        }
    }

    private static func cellType(_ kind: ChatRow.Kind) -> Int {
        switch kind {
        case .user: 0
        case .assistant: 1
        case .typing: 2
        case .projectTag: 3
        case .tool, .toolGroup: 4
        case .notice, .handoff: 5
        case .error: 6
        case .report: 7
        case .other: 8
        case .browser: 9
        }
    }

    private var bubbleWidth: CGFloat {
        let available = (width > 0 ? width : view.bounds.width) - Theme.Space.s4 * 2
        return floor(available * Theme.Size.bubbleMax)
    }

    private func configure(_ cell: ChatCell, row: ChatRow) {
        cell.gap = row.gap
        let width = bubbleWidth
        let id = row.id
        switch row.kind {
        case .user(let body, let quote):
            guard let cell = cell as? UserCell else { return }
            cell.configure(body: body, quote: quote, width: width)
            cell.onQuote = { [weak self] in self?.jump(toQuote: quote ?? "", from: id) }
        case .other(let body, let quote, let sender, let avatar):
            guard let cell = cell as? OtherCell else { return }
            cell.configure(body: body, quote: quote, sender: sender, avatar: avatar, width: width)
            cell.onQuote = { [weak self] in self?.jump(toQuote: quote ?? "", from: id) }
        case .assistant(let text):
            guard let cell = cell as? AssistantCell else { return }
            cell.configure(text: text, width: width)
            cell.onLink = { url in UIApplication.shared.open(url) }
        case .typing(let retrying):
            (cell as? TypingCell)?.configure(retrying: retrying)
        case .projectTag(let name, let projectId):
            guard let cell = cell as? TagCell else { return }
            cell.configure(name: name, enabled: projectId != nil)
            cell.onTap = { [weak self] in if let projectId { self?.openProject(projectId) } }
        case .tool(let step):
            guard let cell = cell as? ToolCell else { return }
            cell.configure(step: step, width: width)
            let canOpen = !step.output.isBlank || step.outputPath != nil
            cell.onToggle = canOpen ? { [weak self] in self?.toggle(id) } : nil
        case .toolGroup(let group):
            guard let cell = cell as? ToolCell else { return }
            cell.configure(group: group, width: width)
            cell.onToggle = { [weak self] in self?.toggle(id) }
        case .notice(let text):
            (cell as? NoticeCell)?.configure(heading: nil, body: text, width: width)
        case .handoff(let task):
            (cell as? NoticeCell)?.configure(heading: "从聊天转来", body: task, width: width)
        case .error(let text):
            (cell as? ErrorCell)?.configure(text, width: width)
        case .report(let card):
            guard let cell = cell as? ReportCell else { return }
            cell.configure(card: card, width: width)
            cell.onOpen = { [weak self] in self?.openProject(card.projectId) }
        case .browser(let task):
            guard let cell = cell as? BrowserCardCell else { return }
            let image = frameFor(task)
            cell.configure(task: task, frame: image, planOpen: planOpen.contains(id), width: bubbleWidth / Theme.Size.bubbleMax, canStop: state.running)
            cell.onStop = { [weak self] in self?.socket?.abort() }
            cell.onTogglePlan = { [weak self] in
                guard let self else { return }
                if self.planOpen.contains(id) { self.planOpen.remove(id) } else { self.planOpen.insert(id) }
                var snapshot = self.source.snapshot()
                snapshot.reconfigureItems([id])
                self.source.apply(snapshot, animatingDifferences: false)
            }
            cell.onExpand = { [weak self] in
                guard let self else { return }
                let controller = BrowserLargeViewController(
                    task: task,
                    frame: image,
                    onStop: self.state.running ? { [weak self] in self?.socket?.abort() } : nil
                )
                self.large = controller
                self.largeId = id
                self.present(controller, animated: true)
            }
        }
        if let texts = Self.menuTexts(row) {
            cell.accessibilityCustomActions = [
                UIAccessibilityCustomAction(name: "回复") { [weak self] _ in
                    self?.startQuote(texts.quote)
                    return true
                },
                UIAccessibilityCustomAction(name: "复制") { _ in
                    UIPasteboard.general.string = texts.copy
                    return true
                }
            ]
        } else {
            cell.accessibilityCustomActions = nil
        }
    }

    private func reconfigureAll() {
        guard source != nil else { return }
        var snapshot = source.snapshot()
        guard !snapshot.itemIdentifiers.isEmpty else { return }
        snapshot.reconfigureItems(snapshot.itemIdentifiers)
        source.apply(snapshot, animatingDifferences: false)
    }

    /// 点开或收起：一步操作的输出、一组操作。
    /// 点的那一行原地向下展开，不跟着底部走；展开后露出被输入栏挡住的部分。
    private func toggle(_ id: String) {
        if toggled.contains(id) { toggled.remove(id) } else { toggled.insert(id) }
        UISelectionFeedbackGenerator().selectionChanged()
        stick = false
        let change = {
            self.render()
            self.collectionView.layoutIfNeeded()
            self.reveal(id)
        }
        if UIAccessibility.isReduceMotionEnabled {
            change()
        } else {
            UIView.animate(springDuration: 0.3, bounce: 0, animations: change)
        }
        stick = distanceFromBottom < Self.stickDistance
    }

    private func reveal(_ id: String) {
        guard let index = rowIDs.firstIndex(of: id),
              let frame = collectionView.layoutAttributesForItem(at: IndexPath(item: index, section: 0))?.frame
        else { return }
        let inset = collectionView.adjustedContentInset
        let visibleTop = collectionView.contentOffset.y + inset.top
        let visibleBottom = collectionView.contentOffset.y + collectionView.bounds.height - inset.bottom
        guard frame.maxY > visibleBottom else { return }
        let shift = min(frame.maxY - visibleBottom, max(0, frame.minY - visibleTop))
        collectionView.contentOffset.y += shift
    }

    private func updateStatus() {
        let text: String? = if socket?.isOpen == true {
            state.queued > 0 ? "还有 \(state.queued) 条消息排着队，Pupu 说完这轮就处理" : nil
        } else {
            loaded ? "连接断开，正在重连…" : "正在连接 Pupu…"
        }
        if let text, statusLabel.text != text { statusLabel.text = text }
        let hidden = text == nil
        guard statusLabel.isHidden != hidden else { return }
        UIView.animate(withDuration: 0.2) {
            self.statusLabel.isHidden = hidden
            self.statusLabel.alpha = hidden ? 0 : 1
            self.view.layoutIfNeeded()
        }
    }

    // MARK: - 滚动

    private var distanceFromBottom: CGFloat {
        let inset = collectionView.adjustedContentInset
        return collectionView.contentSize.height + inset.bottom - collectionView.bounds.height - collectionView.contentOffset.y
    }

    /// 高度是估的，滚到底以后量出真实高度，内容可能又变长了，所以再对一次。
    private func setUpJump() {
        jump.configuration?.image = UIImage(systemName: "chevron.down")
        jump.configuration?.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)
        jump.configuration?.baseForegroundColor = Theme.ink
        jump.configuration?.cornerStyle = .capsule
        jump.configuration?.contentInsets = .zero
        jump.accessibilityLabel = "回到底部"
        jump.isHidden = true
        jump.alpha = 0
        jump.addAction(UIAction { [weak self] _ in self?.jumpToBottom() }, for: .primaryActionTriggered)
        jump.translatesAutoresizingMaskIntoConstraints = false
        view.insertSubview(jump, belowSubview: overlay)
        NSLayoutConstraint.activate([
            jump.widthAnchor.constraint(equalToConstant: Theme.Size.controlSmall),
            jump.heightAnchor.constraint(equalToConstant: Theme.Size.controlSmall),
            jump.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -Theme.Space.s4),
            jump.bottomAnchor.constraint(equalTo: bottom.topAnchor, constant: -Theme.Space.s3)
        ])
    }

    private func updateJump() {
        let hidden = stick
        if !hidden { jump.isHidden = false }
        UIView.animate(withDuration: 0.2) {
            self.jump.alpha = hidden ? 0 : 1
        } completion: { _ in
            if self.stick { self.jump.isHidden = true }
        }
    }

    private func jumpToBottom() {
        stick = true
        collectionView.layoutIfNeeded()
        let inset = collectionView.adjustedContentInset
        let y = max(-inset.top, collectionView.contentSize.height + inset.bottom - collectionView.bounds.height)
        collectionView.setContentOffset(CGPoint(x: 0, y: y), animated: !UIAccessibility.isReduceMotionEnabled)
    }

    private func scrollToBottom() {
        for _ in 0..<3 {
            collectionView.layoutIfNeeded()
            let inset = collectionView.adjustedContentInset
            let y = max(-inset.top, collectionView.contentSize.height + inset.bottom - collectionView.bounds.height)
            guard abs(collectionView.contentOffset.y - y) > 0.5 else { return }
            collectionView.setContentOffset(CGPoint(x: 0, y: y), animated: false)
        }
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        guard scrollView.isTracking || scrollView.isDragging || scrollView.isDecelerating else { return }
        stick = distanceFromBottom < Self.stickDistance
        onScroll?(stick)
    }

    /// 点状态栏回到顶上，不算拖动，也要记下已经不在底部。
    func scrollViewDidScrollToTop(_ scrollView: UIScrollView) {
        stick = distanceFromBottom < Self.stickDistance
    }

    // MARK: - 发送和引用

    /// 发输入栏里的字。Pupu 收下了才清空输入栏、收起引用；被拒了字留着，原因显示在对话末尾。
    private func send() {
        let value = composer.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sending, !value.isEmpty, let socket else { return }
        let message = quote.map { SpecialMessage.quoted($0, reply: value) } ?? value
        sending = true
        socket.submit(message) { [weak self] refusal in self?.settled(refusal) }
    }

    private func settled(_ refusal: String?) {
        sending = false
        if let refusal {
            state.error = refusal
            scheduleRender()
            return
        }
        composer.clear()
        cancelQuote()
        stick = true
        scrollToBottom()
    }

    private static func menuTexts(_ row: ChatRow) -> (copy: String, quote: String)? {
        switch row.kind {
        case .user(let body, _), .other(let body, _, _, _): (body, body)
        case .assistant(let text): (Markdown.plainText(text), text)
        case .report(let card): (card.quote, card.quote)
        default: nil
        }
    }

    private func startQuote(_ text: String) {
        quote = text
        quotePreview.configure(text, width: bubbleWidth)
        composer.placeholder = "回复消息"
        overlay.isHidden = false
        UIView.animate(withDuration: 0.25) {
            self.overlay.effect = UIBlurEffect(style: .systemUltraThinMaterial)
            self.scrim.alpha = 1
            self.quotePreview.isHidden = false
            self.quotePreview.alpha = 1
            self.view.layoutIfNeeded()
        }
        composer.textView.becomeFirstResponder()
    }

    @objc private func cancelQuote() {
        guard quote != nil else { return }
        quote = nil
        composer.placeholder = placeholder
        UIView.animate(withDuration: 0.2) {
            self.overlay.effect = nil
            self.scrim.alpha = 0
            self.quotePreview.isHidden = true
            self.quotePreview.alpha = 0
            self.view.layoutIfNeeded()
        } completion: { _ in
            if self.quote == nil { self.overlay.isHidden = true }
        }
    }

    /// 点我的气泡上方的引用：滚回原消息，让它闪一下。
    private func jump(toQuote text: String, from id: String) {
        let needle = (text.hasSuffix("…") ? String(text.dropLast()) : text).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty, let index = rowIDs.firstIndex(of: id) else { return }
        let target = rowIDs[..<index].lastIndex { candidate in
            guard let row = rowsByID[candidate], let texts = Self.menuTexts(row) else { return false }
            return texts.quote.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix(needle)
        }
        guard let target else { return }
        let path = IndexPath(item: target, section: 0)
        stick = false
        collectionView.scrollToItem(at: path, at: .centeredVertically, animated: true)
        Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard let bubble = (self?.collectionView.cellForItem(at: path) as? ChatCell)?.bubbleView else { return }
            UIView.animate(withDuration: 0.15) { bubble.alpha = 0.35 } completion: { _ in
                UIView.animate(withDuration: 0.35) { bubble.alpha = 1 }
            }
        }
    }

    // MARK: - 长按菜单

    func collectionView(_ collectionView: UICollectionView, shouldSelectItemAt indexPath: IndexPath) -> Bool { false }

    func collectionView(_ collectionView: UICollectionView, shouldHighlightItemAt indexPath: IndexPath) -> Bool { false }

    func collectionView(
        _ collectionView: UICollectionView,
        contextMenuConfigurationForItemsAt indexPaths: [IndexPath],
        point: CGPoint
    ) -> UIContextMenuConfiguration? {
        guard indexPaths.count == 1,
              let id = source.itemIdentifier(for: indexPaths[0]),
              let row = rowsByID[id],
              let texts = Self.menuTexts(row)
        else { return nil }
        return UIContextMenuConfiguration(identifier: id as NSString, previewProvider: nil) { [weak self] _ in
            UIMenu(children: [
                UIAction(title: "复制", image: UIImage(systemName: "doc.on.doc")) { _ in
                    UIPasteboard.general.string = texts.copy
                },
                UIAction(title: "回复", image: UIImage(systemName: "arrowshape.turn.up.left")) { _ in
                    self?.startQuote(texts.quote)
                }
            ])
        }
    }

    func collectionView(
        _ collectionView: UICollectionView,
        contextMenuConfiguration configuration: UIContextMenuConfiguration,
        highlightPreviewForItemAt indexPath: IndexPath
    ) -> UITargetedPreview? {
        preview(at: indexPath)
    }

    func collectionView(
        _ collectionView: UICollectionView,
        contextMenuConfiguration configuration: UIContextMenuConfiguration,
        dismissalPreviewForItemAt indexPath: IndexPath
    ) -> UITargetedPreview? {
        preview(at: indexPath)
    }

    /// 预览就是这条气泡本身。
    private func preview(at path: IndexPath) -> UITargetedPreview? {
        guard let cell = collectionView.cellForItem(at: path) as? ChatCell,
              let bubble = cell.bubbleView,
              bubble.window != nil
        else { return nil }
        let parameters = UIPreviewParameters()
        parameters.backgroundColor = .clear
        parameters.visiblePath = UIBezierPath(roundedRect: bubble.bounds, cornerRadius: cell.bubbleRadius)
        return UITargetedPreview(view: bubble, parameters: parameters)
    }

    // MARK: - 右滑回复

    func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
        guard let pan = gesture as? UIPanGestureRecognizer, pan.view === collectionView else { return true }
        let velocity = pan.velocity(in: collectionView)
        guard velocity.x > 0, abs(velocity.x) > abs(velocity.y) * 2 else { return false }
        guard let path = collectionView.indexPathForItem(at: pan.location(in: collectionView)),
              let id = source.itemIdentifier(for: path),
              let row = rowsByID[id]
        else { return false }
        return Self.menuTexts(row) != nil
    }

    @objc private func swiped(_ pan: UIPanGestureRecognizer) {
        switch pan.state {
        case .began:
            guard let path = collectionView.indexPathForItem(at: pan.location(in: collectionView)),
                  let cell = collectionView.cellForItem(at: path) as? ChatCell,
                  let id = source.itemIdentifier(for: path)
            else { return }
            swipe = (cell, id, false)
        case .changed:
            guard var current = swipe else { return }
            let x = max(0, pan.translation(in: collectionView).x)
            let limit = Self.swipeDistance
            let offset = x < limit ? x : limit + (x - limit) * 0.2
            current.cell.body.transform = CGAffineTransform(translationX: offset, y: 0)
            let armed = x >= limit
            if armed != current.armed {
                if armed { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
                current.armed = armed
            }
            swipe = current
        case .ended, .cancelled, .failed:
            guard let current = swipe else { return }
            swipe = nil
            UIView.animate(springDuration: 0.3, bounce: 0.2) { current.cell.body.transform = .identity }
            if pan.state == .ended, current.armed, let row = rowsByID[current.id], let texts = Self.menuTexts(row) {
                startQuote(texts.quote)
            }
        default:
            break
        }
    }
}
