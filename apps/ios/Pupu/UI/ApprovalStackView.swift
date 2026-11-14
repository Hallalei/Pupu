import UIKit

/// 顶栏下方的审批卡片。一次只摊开最早的一条，其余的在卡片上写「还有 N 条」。
/// 在这台手机上批过的先收起来，不等下一次拉状态；列表里没了它，也就不用再记。
final class ApprovalStackView: UIView {
    private let relayout: () -> Void
    private var card: ApprovalCardView?
    private var approvals: [Approval] = []
    /// 这台手机批过、刚拉到的列表里还有的。
    private var decided = Set<String>()

    /// relayout 在 Shell 里排版：出现、收起时页面内容跟着挤开或者合上。
    init(relayout: @escaping () -> Void) {
        self.relayout = relayout
        super.init(frame: .zero)
        isHidden = true
    }

    required init?(coder: NSCoder) { fatalError() }

    func update(_ next: [Approval]) {
        approvals = next
        decided.formIntersection(next.map(\.id))
        render()
    }

    private func render() {
        let pending = approvals.filter { !decided.contains($0.id) }.sorted { $0.createdAt < $1.createdAt }
        let hidden = pending.isEmpty
        defer {
            if isHidden != hidden {
                isHidden = hidden
                relayout()
            }
        }
        guard let first = pending.first else {
            hide()
            return
        }
        if card?.approval.id == first.id {
            card?.setMore(pending.count - 1)
            return
        }
        hide()
        let next = ApprovalCardView(approval: first) { [weak self] id in
            self?.decided.insert(id)
            self?.render()
        }
        next.setMore(pending.count - 1)
        next.translatesAutoresizingMaskIntoConstraints = false
        addSubview(next)
        next.pin(to: self)
        card = next
        if UIAccessibility.isReduceMotionEnabled {
            next.alpha = 0
            UIView.animate(withDuration: 0.2) { next.alpha = 1 }
        } else {
            next.transform = CGAffineTransform(translationX: 0, y: -24)
            next.alpha = 0
            UIView.animate(springDuration: 0.35, bounce: 0.15) {
                next.transform = .identity
                next.alpha = 1
            }
        }
        UIAccessibility.post(notification: .screenChanged, argument: next)
    }

    private func hide() {
        guard let card else { return }
        self.card = nil
        UIView.animate(withDuration: 0.2) {
            card.alpha = 0
            card.transform = CGAffineTransform(translationX: 0, y: -12)
        } completion: { _ in
            card.removeFromSuperview()
        }
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        return hit === self ? nil : hit
    }
}

/// 审批卡片（规范 ApprovalCard）：`surface` 底，1pt `line` 外框，圆角 `radius-row` 加 2，内边距 `space-4`，各部分之间 `space-3`，不加阴影。
/// 「拒绝」（`surface-inset` 底）在左，「允许」（`action`）在右，等宽。
final class ApprovalCardView: OutlineView {
    let approval: Approval
    private let decided: (String) -> Void
    private let more = UILabel(style: .caption, color: Theme.inkMuted)
    private let deny = UIButton.secondary(title: "拒绝")
    private let allow = UIButton.action(title: "允许")

    /// `decided` 在这台手机批成了以后调，卡片交给外面收起。
    init(approval: Approval, decided: @escaping (String) -> Void) {
        self.approval = approval
        self.decided = decided
        super.init(radius: Theme.Radius.row + 2)
        backgroundColor = Theme.surface

        let mark = WaitingMark(icon: true)
        let meta = UILabel(text: "\(approval.computerName) · \(Ago.text(approval.createdAt))", style: .caption, color: Theme.inkMuted)
        meta.lineBreakMode = .byTruncatingTail
        meta.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let top = UIStackView(arrangedSubviews: [mark, meta, UIView(), more])
        top.spacing = Theme.Space.s2
        top.alignment = .center

        let title = UILabel(text: approval.title, style: .headline, lines: 0)
        var rows: [UIView] = [top, title]
        if approval.kind == "sign_in" {
            // 新手机登录：账号和登录地点，不是命令，不用等宽字。
            rows.append(UILabel(text: approval.detail, style: .subheadline, lines: 0))
        } else if !approval.detail.isEmpty {
            rows.append(CodeBlockView(text: approval.detail))
        }
        let minutes = max(1, Int((approval.expiresAt - Date.now.timeIntervalSince1970 * 1000) / 60_000))
        let why = [approval.reason, "\(minutes) 分钟内没回应就按拒绝处理。"].compactMap { $0 }.joined(separator: "。")
        rows.append(UILabel(text: why, style: .subheadline, color: Theme.inkMuted, lines: 0))

        let buttons = UIStackView(arrangedSubviews: [deny, allow])
        buttons.spacing = Theme.Space.s2
        buttons.distribution = .fillEqually
        rows.append(buttons)

        let stack = UIStackView(arrangedSubviews: rows)
        stack.axis = .vertical
        stack.spacing = Theme.Space.s3
        addSubview(stack)
        stack.pin(to: self, insets: UIEdgeInsets(top: Theme.Space.s4, left: Theme.Space.s4, bottom: Theme.Space.s4, right: Theme.Space.s4))
        NSLayoutConstraint.activate([
            deny.heightAnchor.constraint(greaterThanOrEqualToConstant: Theme.Size.control),
            allow.heightAnchor.constraint(equalTo: deny.heightAnchor)
        ])

        deny.addAction(UIAction { [weak self] _ in self?.decide(allow: false) }, for: .primaryActionTriggered)
        allow.addAction(UIAction { [weak self] _ in self?.decide(allow: true) }, for: .primaryActionTriggered)

        isAccessibilityElement = false
        accessibilityLabel = "等你批准，\(approval.title)"
    }

    required init?(coder: NSCoder) { fatalError() }

    func setMore(_ count: Int) {
        more.text = count > 0 ? "还有 \(count) 条" : nil
    }

    /// 批的请求在路上时两个按钮都不能点，点的那个转圈。批成了交给外面收起；没批成按钮恢复，可以再点。
    private func decide(allow: Bool) {
        guard let api = Store.shared.api else { return }
        setDeciding(allow ? self.allow : deny)
        Task {
            do {
                try await api.decide(approval: approval.id, allow: allow)
                Push.shared.clearDelivered(approval: approval.id)
                UINotificationFeedbackGenerator().notificationOccurred(allow ? .success : .warning)
                decided(approval.id)
            } catch {
                UINotificationFeedbackGenerator().notificationOccurred(.error)
                setDeciding(nil)
            }
            Store.shared.refresh()
        }
    }

    private func setDeciding(_ pressed: UIButton?) {
        for button in [deny, allow] {
            button.isEnabled = pressed == nil
            button.configuration?.showsActivityIndicator = button === pressed
        }
    }
}

/// 「等你批准」标记：`warning` 底、`on-warning` 字的小胶囊，`caption` 600。审批卡片上带 `hand.raised` 图标，对话里的卡片上不带。
final class WaitingMark: UIView {
    init(text: String = "等你批准", icon: Bool = false) {
        super.init(frame: .zero)
        backgroundColor = Theme.warning
        layer.cornerCurve = .continuous
        let label = UILabel(text: text, style: .caption, color: Theme.onWarning)
        label.font = Theme.font(.caption, weight: .semibold)
        var views: [UIView] = [label]
        if icon {
            let image = UIImageView(image: UIImage(systemName: "hand.raised.fill"))
            image.tintColor = Theme.onWarning
            image.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .caption2)
            views.insert(image, at: 0)
        }
        let stack = UIStackView(arrangedSubviews: views)
        stack.spacing = Theme.Space.s1
        stack.alignment = .center
        addSubview(stack)
        stack.pin(to: self, insets: UIEdgeInsets(top: 2, left: Theme.Space.s2, bottom: 2, right: Theme.Space.s2))
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
        isAccessibilityElement = true
        accessibilityLabel = text
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        layer.cornerRadius = bounds.height / 2
    }
}

/// 代码块：等宽字、surface-inset 底、radius-tag 圆角，长命令换行显示。
final class CodeBlockView: UIView {
    let label = UILabel(style: .code, lines: 0)

    init(text: String, maxLines: Int = 0) {
        super.init(frame: .zero)
        backgroundColor = Theme.surfaceInset
        layer.cornerRadius = Theme.Radius.tag
        layer.cornerCurve = .continuous
        label.text = text
        label.numberOfLines = maxLines
        label.lineBreakMode = .byCharWrapping
        addSubview(label)
        label.pin(to: self, insets: UIEdgeInsets(top: Theme.Space.s2, left: Theme.Space.s3, bottom: Theme.Space.s2, right: Theme.Space.s3))
    }

    required init?(coder: NSCoder) { fatalError() }
}
