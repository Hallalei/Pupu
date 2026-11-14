import UIKit

/// 会话卡最上面的状态条（规范 SpaceHeader 的状态条）：「正在做 N」胶囊，没有就整行收起，不占位。
/// 规范只画了计数。这里点「正在做」往下摊开每台电脑在做什么，点一行去对话里那台电脑的卡；
/// 屏幕控制开着时状态条上多一个「收回」（规范对照记录：冲突 2）。灵动岛划掉以后，手机上收回屏幕控制只剩这里。
/// 规范还画了「等你批准 N」：审批卡就在状态条下面，不再写一遍。和网页 Doing.tsx 的 StatusStrip 一起改。
final class StatusStripView: UIView {
    /// 一行画出来的内容。只有它变了才重建，否则 5 秒一次的轮询会让转圈闪。
    private struct Line: Equatable {
        let computerId: String
        let title: String
        let detail: String
        let state: ComputerActivity.State
        let screen: Bool
        let taking: Bool
    }

    private struct Drawn: Equatable {
        let lines: [Line]
        let expanded: Bool
        let failure: String?
    }

    private let doing = StripChip(dot: true, chevron: true)
    private let takeback = StripChip(dot: false, chevron: false)
    private let failureLabel = UILabel(style: .footnote, color: Theme.dangerInk, lines: 0)
    private let list = SurfaceView(.inset, radius: Theme.Radius.row)
    private let listRows = UIStackView()
    private let open: (ComputerActivity) -> Void
    private let relayout: () -> Void
    private var rows: [ComputerActivity] = []
    private var expanded = false
    /// 收回的请求在路上的电脑：按钮点不了，重建也不丢。
    private var taking = Set<String>()
    private var failure: String?
    private var drawn: Drawn?

    /// relayout 在 Shell 里排版：状态条变高变矮时，下面的对话跟着动画挤开或者合上。
    /// open：点了一行。去对话里那台电脑的卡，带空间的去那个空间。
    init(open: @escaping (ComputerActivity) -> Void, relayout: @escaping () -> Void) {
        self.open = open
        self.relayout = relayout
        super.init(frame: .zero)
        isHidden = true
        alpha = 0

        doing.addAction(UIAction { [weak self] _ in self?.toggle() }, for: .primaryActionTriggered)
        takeback.title.font = Theme.font(.footnote, weight: .semibold)
        takeback.title.text = "收回"
        takeback.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.takeBack(self.rows.filter(\.screen).map(\.computerId))
        }, for: .primaryActionTriggered)
        let chips = UIStackView(arrangedSubviews: [doing, takeback, UIView()])
        chips.spacing = Theme.Space.s2
        chips.alignment = .center

        listRows.axis = .vertical
        list.contentView.addSubview(listRows)
        listRows.pin(to: list.contentView)
        list.isHidden = true
        failureLabel.isHidden = true

        let column = UIStackView(arrangedSubviews: [chips, failureLabel, list])
        column.axis = .vertical
        column.spacing = Theme.Space.s2
        addSubview(column)
        column.pin(to: self)
    }

    required init?(coder: NSCoder) { fatalError() }

    /// `next` 是要列的电脑：`busy` 过的，停在审批上的已经去掉（审批卡就在下面，同一件事不写两遍）。
    func update(_ next: [ComputerActivity]) {
        rows = next
        if rows.isEmpty {
            expanded = false
            failure = nil
        }
        render()
    }

    private func render() {
        let lines = rows.map(line)
        let next = Drawn(lines: lines, expanded: expanded, failure: failure)
        guard next != drawn else { return }
        let previous = drawn
        drawn = next
        let hidden = lines.isEmpty
        // 空了留着旧内容：整条收起时一起淡出，不是先变空再收。
        if !hidden {
            let waiting = lines.contains { $0.state == .waiting }
            doing.dot.backgroundColor = waiting ? Theme.warning : Theme.ink
            doing.title.text = "正在做 \(lines.count)"
            doing.chevron.transform = expanded ? CGAffineTransform(rotationAngle: .pi) : .identity
            doing.accessibilityLabel = "正在做 \(lines.count) 件\(waiting ? "，有等你批准的" : "")"
            doing.accessibilityValue = expanded ? "已展开" : "已收起"
            let screens = lines.filter(\.screen)
            takeback.isEnabled = !screens.contains(where: \.taking)
            takeback.title.textColor = takeback.isEnabled ? Theme.ink : Theme.inkMuted
            takeback.accessibilityLabel = "收回\(screens.map { "「\(name(of: $0.computerId))」" }.joined())的屏幕控制"
            failureLabel.text = failure
            if previous?.lines != lines { rebuildList(lines) }
        }
        let showTakeback = !hidden && !expanded && lines.contains(where: \.screen)
        let showFailure = next.failure != nil
        let showList = !hidden && expanded
        // 栈里的视图只在真要变时才改 isHidden：同一个值在动画里反复设，UIStackView 会把它弄丢。
        resize {
            if self.isHidden != hidden { self.isHidden = hidden }
            self.alpha = hidden ? 0 : 1
            if self.takeback.isHidden == showTakeback { self.takeback.isHidden = !showTakeback }
            if self.failureLabel.isHidden == showFailure { self.failureLabel.isHidden = !showFailure }
            if self.list.isHidden == showList { self.list.isHidden = !showList }
            self.list.alpha = showList ? 1 : 0
        }
    }

    private func name(of computerId: String) -> String {
        rows.first { $0.computerId == computerId }?.computerName ?? "电脑"
    }

    private func line(_ activity: ComputerActivity) -> Line {
        Line(
            computerId: activity.computerId,
            title: activity.doing ?? "闲着，屏幕控制还开着",
            detail: [activity.computerName, activity.project?.name, activity.since.map { Ago.text($0) }]
                .compactMap { $0 }
                .joined(separator: " · "),
            state: activity.currentState,
            screen: activity.screen,
            taking: taking.contains(activity.computerId)
        )
    }

    private func toggle() {
        UISelectionFeedbackGenerator().selectionChanged()
        expanded.toggle()
        render()
    }

    private func resize(_ change: @escaping () -> Void) {
        guard window != nil, !UIAccessibility.isReduceMotionEnabled else {
            change()
            relayout()
            return
        }
        UIView.animate(springDuration: 0.3, bounce: 0) {
            change()
            self.relayout()
        }
    }

    /// 摊开的列表：`surface-inset` 底、`radius-row`，每台电脑一行，行之间 1pt `line`，从左边 44 开始。
    private func rebuildList(_ lines: [Line]) {
        listRows.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for (index, line) in lines.enumerated() {
            if index > 0 {
                let rule = UIView()
                let stroke = UIView()
                stroke.backgroundColor = Theme.line
                rule.addSubview(stroke)
                stroke.translatesAutoresizingMaskIntoConstraints = false
                NSLayoutConstraint.activate([
                    rule.heightAnchor.constraint(equalToConstant: 1),
                    stroke.topAnchor.constraint(equalTo: rule.topAnchor),
                    stroke.bottomAnchor.constraint(equalTo: rule.bottomAnchor),
                    stroke.leadingAnchor.constraint(equalTo: rule.leadingAnchor, constant: 44),
                    stroke.trailingAnchor.constraint(equalTo: rule.trailingAnchor)
                ])
                listRows.addArrangedSubview(rule)
            }
            listRows.addArrangedSubview(row(line))
        }
    }

    /// 一行：在做什么（`subheadline`），下面哪台电脑、哪个空间、做了多久（`footnote`，`ink-muted`）。
    /// 屏幕控制开着的右边有「收回」：`surface` 底，高 32。
    private func row(_ line: Line) -> UIView {
        let name = UILabel(text: line.title, style: .subheadline)
        let detail = UILabel(text: line.detail, style: .footnote, color: Theme.inkMuted)
        for label in [name, detail] {
            label.lineBreakMode = .byTruncatingTail
            label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        }
        let text = UIStackView(arrangedSubviews: [name, detail])
        text.axis = .vertical
        text.spacing = 2

        let content = UIStackView(arrangedSubviews: [mark(line.state), text])
        content.spacing = Theme.Space.s3
        content.alignment = .center
        content.isUserInteractionEnabled = false

        let body = HighlightControl()
        body.addSubview(content)
        content.pin(to: body, insets: UIEdgeInsets(top: Theme.Space.s2, left: Theme.Space.s4, bottom: Theme.Space.s2, right: 0))
        body.isAccessibilityElement = true
        body.accessibilityLabel = "\(line.title)，\(line.detail)\(line.state == .waiting ? "，等你批准" : "")"
        body.accessibilityTraits = .button
        let computerId = line.computerId
        body.addAction(UIAction { [weak self] _ in
            guard let activity = self?.rows.first(where: { $0.computerId == computerId }) else { return }
            self?.open(activity)
        }, for: .touchUpInside)

        var items: [UIView] = [body]
        if line.screen {
            var config = UIButton.Configuration.filled()
            config.title = "收回"
            config.cornerStyle = .capsule
            config.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 14, bottom: 0, trailing: 14)
            config.showsActivityIndicator = line.taking
            config.paint(fill: Theme.surface, ink: Theme.ink, style: .subheadline)
            let button = UIButton(configuration: config)
            button.configurationUpdateHandler = { button in
                button.configuration?.paint(fill: Theme.surface, ink: button.isEnabled ? Theme.ink : Theme.inkMuted, pressed: button.isHighlighted, style: .subheadline)
            }
            button.isEnabled = !line.taking
            button.heightAnchor.constraint(equalToConstant: 32).isActive = true
            button.setContentHuggingPriority(.required, for: .horizontal)
            button.setContentCompressionResistancePriority(.required, for: .horizontal)
            button.accessibilityLabel = "收回「\(self.name(of: computerId))」的屏幕控制"
            button.addAction(UIAction { [weak self] _ in self?.takeBack([computerId]) }, for: .touchUpInside)
            items.append(button)
        }
        let bar = UIStackView(arrangedSubviews: items)
        bar.spacing = Theme.Space.s3
        bar.alignment = .center
        let row = UIView()
        row.addSubview(bar)
        bar.pin(to: row, insets: UIEdgeInsets(top: 0, left: 0, bottom: 0, right: Theme.Space.s3))
        row.heightAnchor.constraint(greaterThanOrEqualToConstant: 52).isActive = true
        return row
    }

    /// 转圈和圆点放进同样宽的格子，几行的字对齐。
    private func mark(_ state: ComputerActivity.State) -> UIView {
        let mark: UIView
        if state == .working {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.transform = CGAffineTransform(scaleX: 0.8, y: 0.8)
            spinner.startAnimating()
            spinner.accessibilityLabel = "在做"
            mark = spinner
        } else {
            mark = UIView()
            mark.backgroundColor = state == .waiting ? Theme.warning : Theme.online
            mark.layer.cornerRadius = 4
            NSLayoutConstraint.activate([
                mark.widthAnchor.constraint(equalToConstant: 8),
                mark.heightAnchor.constraint(equalToConstant: 8)
            ])
        }
        let box = UIView()
        box.addSubview(mark)
        mark.translatesAutoresizingMaskIntoConstraints = false
        box.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            box.widthAnchor.constraint(equalToConstant: 16),
            box.heightAnchor.constraint(equalToConstant: 20),
            mark.centerXAnchor.constraint(equalTo: box.centerXAnchor),
            mark.centerYAnchor.constraint(equalTo: box.centerYAnchor)
        ])
        return box
    }

    private func takeBack(_ ids: [String]) {
        let ids = ids.filter { !taking.contains($0) }
        guard let api = Store.shared.api, !ids.isEmpty else { return }
        taking.formUnion(ids)
        failure = nil
        render()
        Task {
            do {
                for id in ids { try await api.takeback(computer: id) }
            } catch {
                failure = "没收回：\(error.localizedDescription)"
            }
            taking.subtract(ids)
            render()
            Store.shared.refresh()
        }
    }
}

/// 状态条上的胶囊：高 28，`surface-inset` 底，`footnote`。「正在做」前面 8pt 圆点、后面一个会转的 chevron。
private final class StripChip: TapControl {
    let dot = UIView()
    let title = UILabel(style: .footnote)
    let chevron = UIImageView(image: UIImage(systemName: "chevron.down", withConfiguration: UIImage.SymbolConfiguration(pointSize: 10, weight: .semibold)))

    init(dot hasDot: Bool, chevron hasChevron: Bool) {
        super.init(frame: .zero)
        backgroundColor = Theme.surfaceInset
        layer.cornerRadius = 14
        dot.layer.cornerRadius = 4
        dot.isHidden = !hasDot
        dot.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            dot.widthAnchor.constraint(equalToConstant: 8),
            dot.heightAnchor.constraint(equalToConstant: 8)
        ])
        chevron.tintColor = Theme.inkMuted
        chevron.isHidden = !hasChevron
        let row = UIStackView(arrangedSubviews: [dot, title, chevron])
        row.spacing = 6
        row.alignment = .center
        row.isUserInteractionEnabled = false
        addSubview(row)
        row.pin(to: self, insets: UIEdgeInsets(top: 0, left: Theme.Space.s3, bottom: 0, right: Theme.Space.s3))
        heightAnchor.constraint(equalToConstant: 28).isActive = true
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    required init?(coder: NSCoder) { fatalError() }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.6 : 1 }
    }

    /// 看得见的高 28，点按区上下补到 44。
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        bounds.insetBy(dx: 0, dy: -8).contains(point)
    }
}

/// 按下时铺一层 `line` 的整行点按区。
final class HighlightControl: UIControl {
    override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted ? Theme.line : .clear }
    }
}
