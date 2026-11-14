import UIKit

/// 聊天顶上的「正在做」。灵动岛划掉以后，手机上收回屏幕控制只剩这里。
/// 多台电脑时只摊开第一行，+N 展开全部。
final class DoingView: SurfaceView {
    /// 一行画出来的内容。只有它变了才重建，否则 5 秒一次的轮询会让转圈闪。
    private struct Line: Equatable {
        let activity: ComputerActivity
        let detail: String
        let failed: Bool
        let takingBack: Bool
    }

    /// 收回一台电脑的屏幕控制：请求在路上，或者没收回（带原因）。
    /// 都只算这一次授权的：授权没了（收回了、过期了），失败的原因跟着丢掉，下次授权不再冒出来。
    private enum Takeback: Equatable {
        case sending
        case failed(String)
    }

    private let stack = UIStackView()
    private let more = UIButton(configuration: .plain())
    private let open: (ComputerActivity) -> Void
    private let relayout: () -> Void
    private var activity: [ComputerActivity] = []
    private var lines: [Line] = []
    private var expanded = false
    /// 按电脑记。在路上时按钮转圈，重建也不丢；失败的原因显示在那一行的第二行。
    private var takebacks: [String: Takeback] = [:]

    /// relayout 在 Shell 里排版：新高度要加给页面的安全区，内容才跟着动画挤开。
    /// open：点了一行。去对话里那台电脑的任务卡，带项目的去那个项目。
    init(open: @escaping (ComputerActivity) -> Void, relayout: @escaping () -> Void) {
        self.open = open
        self.relayout = relayout
        super.init(.strong, radius: Theme.Radius.row, lifted: true)
        isHidden = true
        alpha = 0
        stack.axis = .vertical
        fit(stack, in: contentView)

        more.configuration?.baseForegroundColor = Theme.inkMuted
        more.configuration?.contentInsets = .zero
        more.configuration?.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(textStyle: .footnote)
        more.configuration?.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = Theme.font(.footnote)
            return attributes
        }
        more.setContentHuggingPriority(.required, for: .horizontal)
        more.setContentCompressionResistancePriority(.required, for: .horizontal)
        more.addAction(UIAction { [weak self] _ in self?.toggle() }, for: .primaryActionTriggered)
        NSLayoutConstraint.activate([
            more.widthAnchor.constraint(greaterThanOrEqualToConstant: Theme.Size.control),
            more.heightAnchor.constraint(greaterThanOrEqualToConstant: Theme.Size.control)
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    /// `all` 是所有电脑的；`shown` 为 false 时整块收起（不在聊天页），但授权的变化照样跟。
    func update(_ all: [ComputerActivity], shown: Bool) {
        activity = shown ? ComputerActivity.busy(all) : []
        let granted = Set(all.filter(\.screen).map(\.computerId))
        takebacks = takebacks.filter { computerId, takeback in
            takeback == .sending || granted.contains(computerId)
        }
        render()
    }

    private func render() {
        let next = activity.map(line)
        guard next != lines else { return }
        lines = next
        if lines.count < 2 { expanded = false }
        // 空了留着旧行：外框收起时把它们裁掉，不是先变空再收。
        if !lines.isEmpty { rebuild() }
        let hidden = lines.isEmpty
        resize {
            if self.isHidden != hidden { self.isHidden = hidden }
            self.alpha = hidden ? 0 : 1
        }
    }

    private func line(_ activity: ComputerActivity) -> Line {
        let takeback = takebacks[activity.computerId]
        let error: String? = if case .failed(let reason) = takeback { reason } else { nil }
        let detail = error ?? [activity.computerName, activity.project?.name, activity.since.map { Ago.text($0) }]
            .compactMap { $0 }
            .joined(separator: " · ")
        return Line(
            activity: activity,
            detail: detail,
            failed: error != nil,
            takingBack: takeback == .sending
        )
    }

    private func rebuild() {
        // 锁住高度先把新行排好：放开后动画里只有外框在变，字不会从左上角长出来。
        let held = heightAnchor.constraint(equalToConstant: bounds.height)
        held.isActive = true
        for view in stack.arrangedSubviews { view.removeFromSuperview() }
        for (index, line) in lines.enumerated() {
            stack.addArrangedSubview(row(line, more: index == 0 && lines.count > 1 ? more : nil))
        }
        updateMore()
        showRest()
        layoutIfNeeded()
        held.isActive = false
    }

    private func toggle() {
        expanded.toggle()
        updateMore()
        resize { self.showRest() }
    }

    private func updateMore() {
        more.configuration?.title = expanded ? nil : "+\(lines.count - 1)"
        more.configuration?.image = expanded ? UIImage(systemName: "chevron.up") : nil
        more.accessibilityLabel = expanded ? "收起" : "展开全部 \(lines.count) 台电脑"
    }

    private func showRest() {
        for row in stack.arrangedSubviews.dropFirst() {
            row.isHidden = !expanded
            row.alpha = expanded ? 1 : 0
        }
    }

    private func resize(_ change: @escaping () -> Void) {
        guard window != nil, !UIAccessibility.isReduceMotionEnabled else {
            change()
            return
        }
        UIView.animate(springDuration: 0.3, bounce: 0) {
            change()
            self.relayout()
        }
    }

    /// 一行：在做什么，第二行是哪台电脑、哪个项目、做了多久。点开去这台电脑的任务卡。
    private func row(_ line: Line, more: UIView?) -> UIView {
        let activity = line.activity
        let title = activity.doing ?? "闲着，屏幕控制还开着"
        let name = UILabel(text: title, style: .subheadline)
        name.font = Theme.font(.subheadline, weight: .medium)
        let detail = UILabel(text: line.detail, style: .caption, color: line.failed ? Theme.dangerInk : Theme.inkMuted)
        // 放不下时字先截断，右边的按钮保持完整。
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        detail.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let text = UIStackView(arrangedSubviews: [name, detail])
        text.axis = .vertical
        text.spacing = 2

        let content = UIStackView(arrangedSubviews: [mark(activity.currentState), text])
        content.spacing = Theme.Space.s3
        content.alignment = .center
        content.isUserInteractionEnabled = false

        let body = UIControl()
        body.addSubview(content)
        content.pin(to: body, insets: UIEdgeInsets(top: Theme.Space.s2, left: Theme.Space.s4, bottom: Theme.Space.s2, right: 0))
        body.isAccessibilityElement = true
        body.accessibilityLabel = "\(title)，\(line.detail)\(activity.currentState == .waiting ? "，等你批准" : "")"
        body.accessibilityTraits = .button
        body.addAction(UIAction { [weak self] _ in self?.open(activity) }, for: .touchUpInside)

        let items = [body, activity.screen ? takebackButton(line) : nil, more].compactMap { $0 }
        let bar = UIStackView(arrangedSubviews: items)
        bar.spacing = Theme.Space.s2
        bar.alignment = .center
        let row = UIView()
        fit(bar, in: row, trailing: more == nil ? Theme.Space.s4 : Theme.Space.s1)
        return row
    }

    /// 转圈和圆点放进同样宽的格子，几行的字对齐。
    private func mark(_ state: ComputerActivity.State) -> UIView {
        let mark: UIView
        if state == .working {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.startAnimating()
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
            box.widthAnchor.constraint(equalToConstant: 20),
            box.heightAnchor.constraint(equalToConstant: 20),
            mark.centerXAnchor.constraint(equalTo: box.centerXAnchor),
            mark.centerYAnchor.constraint(equalTo: box.centerYAnchor)
        ])
        return box
    }

    private func takebackButton(_ line: Line) -> UIButton {
        let computerId = line.activity.computerId
        let button = UIButton.glass(title: "收回")
        button.configuration?.buttonSize = .small
        button.configuration?.showsActivityIndicator = line.takingBack
        button.isEnabled = !line.takingBack
        button.setContentHuggingPriority(.required, for: .horizontal)
        button.setContentCompressionResistancePriority(.required, for: .horizontal)
        button.addAction(UIAction { [weak self] _ in self?.takeback(computerId) }, for: .touchUpInside)
        button.accessibilityLabel = "收回「\(line.activity.computerName)」的屏幕控制"
        return button
    }

    private func takeback(_ computerId: String) {
        guard let api = Store.shared.api, takebacks[computerId] != .sending else { return }
        takebacks[computerId] = .sending
        render()
        Task {
            do {
                try await api.takeback(computer: computerId)
                takebacks[computerId] = nil
            } catch {
                takebacks[computerId] = .failed("没收回：\(error.localizedDescription)")
            }
            render()
            Store.shared.refresh()
        }
    }

    /// 收起时 UIStackView 把外层高度压到 0。底边比字的抗压缩低一档：字保持原高，被外框裁掉，不和 0 打架。
    private func fit(_ content: UIView, in box: UIView, trailing: CGFloat = 0) {
        box.addSubview(content)
        content.translatesAutoresizingMaskIntoConstraints = false
        let bottom = content.bottomAnchor.constraint(equalTo: box.bottomAnchor)
        bottom.priority = .defaultHigh - 1
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: box.topAnchor),
            content.leadingAnchor.constraint(equalTo: box.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -trailing),
            bottom
        ])
    }
}
