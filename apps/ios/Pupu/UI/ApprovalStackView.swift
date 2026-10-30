import UIKit

/// 顶栏下方的审批卡片。一次只摊开最早的一条，其余的在卡片上写「还有 N 条」。
final class ApprovalStackView: UIView {
    private var card: ApprovalCardView?
    private var shownID: String?

    func update(_ approvals: [Approval]) {
        let pending = approvals.sorted { $0.createdAt < $1.createdAt }
        guard let first = pending.first else {
            hide()
            return
        }
        if shownID == first.id {
            card?.setMore(pending.count - 1)
            return
        }
        hide()
        let next = ApprovalCardView(approval: first)
        next.setMore(pending.count - 1)
        next.translatesAutoresizingMaskIntoConstraints = false
        addSubview(next)
        next.pin(to: self)
        card = next
        shownID = first.id
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
        shownID = nil
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

final class ApprovalCardView: SurfaceView {
    private let approval: Approval
    private let more = UILabel(style: .caption, color: Theme.inkMuted)
    private let deny = UIButton.glass(title: "拒绝")
    private let allow = UIButton.action(title: "允许")

    init(approval: Approval) {
        self.approval = approval
        super.init(.strong, radius: Theme.Radius.panel, lifted: true)

        let mark = WaitingMark()
        let meta = UILabel(text: "\(approval.computerName) · \(Ago.text(approval.createdAt))", style: .caption, color: Theme.inkMuted)
        let top = UIStackView(arrangedSubviews: [mark, meta, UIView(), more])
        top.spacing = Theme.Space.s2
        top.alignment = .center

        let title = UILabel(text: approval.title, style: .headline, lines: 0)
        var rows: [UIView] = [top, title]
        if !approval.detail.isEmpty {
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
        contentView.addSubview(stack)
        stack.pin(to: contentView, insets: UIEdgeInsets(top: Theme.Space.s4, left: Theme.Space.s4, bottom: Theme.Space.s4, right: Theme.Space.s4))
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

    private func decide(allow: Bool) {
        guard let api = Store.shared.api else { return }
        deny.isEnabled = false
        self.allow.isEnabled = false
        (allow ? self.allow : deny).configuration?.showsActivityIndicator = true
        Task {
            do {
                try await api.decide(approval: approval.id, allow: allow)
                UINotificationFeedbackGenerator().notificationOccurred(allow ? .success : .warning)
            } catch {
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
            Store.shared.refresh()
            deny.isEnabled = true
            self.allow.isEnabled = true
            self.allow.configuration?.showsActivityIndicator = false
            deny.configuration?.showsActivityIndicator = false
        }
    }
}

/// 「等你批准」标记：warning 底、on-warning 字。
final class WaitingMark: UIView {
    init(text: String = "等你批准") {
        super.init(frame: .zero)
        backgroundColor = Theme.warning
        layer.cornerCurve = .continuous
        let icon = UIImageView(image: UIImage(systemName: "hand.raised.fill"))
        icon.tintColor = Theme.onWarning
        icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .caption2)
        let label = UILabel(text: text, style: .caption, color: Theme.onWarning)
        label.font = Theme.font(.caption, weight: .semibold)
        let stack = UIStackView(arrangedSubviews: [icon, label])
        stack.spacing = Theme.Space.s1
        stack.alignment = .center
        addSubview(stack)
        stack.pin(to: self, insets: UIEdgeInsets(top: 2, left: Theme.Space.s2, bottom: 2, right: Theme.Space.s2))
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
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
