import UIKit

/// 浏览器任务卡片（规范 BrowserCard）：对话里一张实时画面，右下角「计划」、放大、停止，下面一行状态；
/// 要你登录、输验证码时停下来等你接手；做完了画面退后，只剩一句结果。网页的 BrowserCard.tsx 是同一个样子，两边一起改。
final class BrowserCardCell: ChatCell {
    /// 画面：`radius-bubble`，`surface-inset` 底，往里收 1pt `line`，`shadow-raised`。阴影画在这一层，里面那层裁圆角。
    private let frameBox = UIView()
    private let clip = UIView()
    private let imageView = TopFillImageView(frame: .zero)
    private let placeholder = UILabel(text: "等电脑传画面…", style: .footnote, color: Theme.inkMuted)
    private let spinnerBox = FloatControlView(radius: 14)
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let planButton = BrowserCardCell.chip(title: "计划")
    private let expandButton = BrowserCardCell.chip(image: "arrow.up.left.and.arrow.down.right", label: "放大")
    private let stopButton = BrowserCardCell.chip(image: "stop.fill", label: "停止")
    private let takeOverButton = BrowserCardCell.takeOverChip()
    private let resultPill = FloatControlView(radius: 16)
    private let resultMark = ResultMarkView()
    private let resultLabel = UILabel(style: .footnote)
    private let planList = PlanListView(floating: true)
    /// 画面下面那一行：`surface-inset` 胶囊，`footnote`、`ink-muted`；等批时前面一个「等你批准」。
    private let statusPill = SurfaceView(.inset, radius: 13)
    private let statusWaiting = WaitingMark()
    private let statusLabel = UILabel(style: .footnote, color: Theme.inkMuted)
    /// 做完了、又没留下画面（比如重新打开了 App）：只剩一行结果。
    private let compact = SurfaceView(.inset, radius: Theme.Radius.row)
    private let compactMark = ResultMarkView()
    private let compactLabel = UILabel(style: .subheadline, lines: 0)
    private let compactPlan = UIButton(configuration: .plain())
    private let compactPlanList = PlanListView(floating: false)
    private let stack = UIStackView()
    private var width: NSLayoutConstraint!
    private var height: NSLayoutConstraint!
    /// 只剩一行结果时最宽 bubble-max。
    private var compactWidth: NSLayoutConstraint!

    var onStop: (() -> Void)?
    var onExpand: (() -> Void)?
    /// 交给人了，点「接手」：手机上没法直接操作那台电脑的页面，放大看实时画面。
    var onTakeOver: (() -> Void)?
    var onTogglePlan: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        frameBox.applyShadow(.raised)
        frameBox.layer.cornerRadius = Theme.Radius.bubble
        frameBox.layer.cornerCurve = .continuous
        clip.backgroundColor = Theme.surfaceInset
        clip.layer.cornerRadius = Theme.Radius.bubble
        clip.layer.cornerCurve = .continuous
        clip.clipsToBounds = true
        frameBox.addSubview(clip)
        clip.pin(to: frameBox)
        clip.addSubview(imageView)
        imageView.pin(to: clip)
        placeholder.translatesAutoresizingMaskIntoConstraints = false
        clip.addSubview(placeholder)
        // 往里收的 1pt line 盖在画面上面，画面贴边时也看得到边。
        let ring = OutlineView(radius: Theme.Radius.bubble)
        ring.isUserInteractionEnabled = false
        clip.addSubview(ring)
        ring.pin(to: clip)

        spinner.hidesWhenStopped = true
        spinner.color = Theme.ink
        spinner.transform = CGAffineTransform(scaleX: 0.7, y: 0.7)
        spinnerBox.addSubview(spinner)
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinnerBox.translatesAutoresizingMaskIntoConstraints = false
        clip.addSubview(spinnerBox)

        let buttons = UIStackView(arrangedSubviews: [planButton, expandButton, takeOverButton, stopButton])
        buttons.spacing = Theme.Space.s2
        buttons.translatesAutoresizingMaskIntoConstraints = false
        clip.addSubview(buttons)
        planButton.addAction(UIAction { [weak self] _ in self?.onTogglePlan?() }, for: .primaryActionTriggered)
        expandButton.addAction(UIAction { [weak self] _ in self?.onExpand?() }, for: .primaryActionTriggered)
        stopButton.addAction(UIAction { [weak self] _ in self?.onStop?() }, for: .primaryActionTriggered)
        takeOverButton.addAction(UIAction { [weak self] _ in self?.onTakeOver?() }, for: .primaryActionTriggered)

        resultLabel.lineBreakMode = .byTruncatingTail
        resultLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let resultRow = UIStackView(arrangedSubviews: [resultMark, resultLabel])
        resultRow.spacing = Theme.Space.s2
        resultRow.alignment = .center
        resultPill.addSubview(resultRow)
        resultRow.pin(to: resultPill, insets: UIEdgeInsets(top: 0, left: Theme.Space.s3, bottom: 0, right: Theme.Space.s3))
        resultPill.translatesAutoresizingMaskIntoConstraints = false
        clip.addSubview(resultPill)

        planList.translatesAutoresizingMaskIntoConstraints = false
        clip.addSubview(planList)

        NSLayoutConstraint.activate([
            placeholder.centerXAnchor.constraint(equalTo: clip.centerXAnchor),
            placeholder.centerYAnchor.constraint(equalTo: clip.centerYAnchor),
            spinnerBox.widthAnchor.constraint(equalToConstant: 28),
            spinnerBox.heightAnchor.constraint(equalToConstant: 28),
            spinnerBox.topAnchor.constraint(equalTo: clip.topAnchor, constant: Theme.Space.s2),
            spinnerBox.trailingAnchor.constraint(equalTo: clip.trailingAnchor, constant: -Theme.Space.s2),
            spinner.centerXAnchor.constraint(equalTo: spinnerBox.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: spinnerBox.centerYAnchor),
            buttons.trailingAnchor.constraint(equalTo: clip.trailingAnchor, constant: -Theme.Space.s2),
            buttons.bottomAnchor.constraint(equalTo: clip.bottomAnchor, constant: -Theme.Space.s2),
            resultPill.heightAnchor.constraint(equalToConstant: 32),
            resultPill.leadingAnchor.constraint(equalTo: clip.leadingAnchor, constant: Theme.Space.s2),
            resultPill.centerYAnchor.constraint(equalTo: buttons.centerYAnchor),
            resultPill.trailingAnchor.constraint(lessThanOrEqualTo: buttons.leadingAnchor, constant: -Theme.Space.s2),
            planList.trailingAnchor.constraint(equalTo: clip.trailingAnchor, constant: -Theme.Space.s2),
            planList.leadingAnchor.constraint(greaterThanOrEqualTo: clip.leadingAnchor, constant: Theme.Space.s2),
            planList.bottomAnchor.constraint(equalTo: buttons.topAnchor, constant: -Theme.Space.s2)
        ])

        statusLabel.lineBreakMode = .byTruncatingTail
        let statusRow = UIStackView(arrangedSubviews: [statusWaiting, statusLabel])
        statusRow.spacing = Theme.Space.s2
        statusRow.alignment = .center
        statusPill.contentView.addSubview(statusRow)
        statusRow.pin(to: statusPill.contentView, insets: UIEdgeInsets(top: Theme.Space.s1, left: Theme.Space.s3, bottom: Theme.Space.s1, right: Theme.Space.s3))

        var planConfig = UIButton.Configuration.plain()
        planConfig.title = "计划"
        planConfig.baseForegroundColor = Theme.inkMuted
        planConfig.contentInsets = .zero
        planConfig.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = Theme.font(.footnote)
            return attributes
        }
        compactPlan.configuration = planConfig
        compactPlan.setContentHuggingPriority(.required, for: .horizontal)
        compactPlan.addAction(UIAction { [weak self] _ in self?.onTogglePlan?() }, for: .primaryActionTriggered)
        compactLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let compactRow = UIStackView(arrangedSubviews: [compactMark, compactLabel, compactPlan])
        compactRow.spacing = Theme.Space.s2
        compactRow.alignment = .center
        compact.contentView.addSubview(compactRow)
        compactRow.pin(to: compact.contentView, insets: UIEdgeInsets(top: Theme.Space.s2, left: Theme.Space.s3, bottom: Theme.Space.s2, right: Theme.Space.s3))

        stack.axis = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.Space.s2
        for view in [frameBox, statusPill, compact, compactPlanList] as [UIView] { stack.addArrangedSubview(view) }
        place(stack, alignment: .left, fraction: 1)
        width = frameBox.widthAnchor.constraint(equalToConstant: 300)
        height = frameBox.heightAnchor.constraint(equalToConstant: 190)
        width.priority = .defaultHigh
        height.priority = .defaultHigh
        NSLayoutConstraint.activate([width, height])
        statusPill.widthAnchor.constraint(lessThanOrEqualTo: frameBox.widthAnchor).isActive = true
        compactPlanList.widthAnchor.constraint(lessThanOrEqualTo: frameBox.widthAnchor).isActive = true
        compactWidth = compact.widthAnchor.constraint(lessThanOrEqualToConstant: 300)
        compactWidth.isActive = true
    }

    required init?(coder: NSCoder) { fatalError() }

    override var bubbleView: UIView? { frameBox }

    /// width 是整列的宽，画面最宽 420。
    func configure(task: BrowserTask, frame: UIImage?, planOpen: Bool, width column: CGFloat, canStop: Bool) {
        let finished = !task.active && !task.holding
        let failed = task.state == .failed
        let resultText = task.result ?? (task.state == .done ? "浏览器里的事做完了" : task.status)
        let showFrame = !(finished && frame == nil)
        frameBox.isHidden = !showFrame
        compact.isHidden = showFrame
        compactPlanList.isHidden = showFrame || !planOpen || task.plan.isEmpty

        // 宽占满内容列，最宽 420；高按画面比例（还没画面时按 16:10），最高 352。
        let boxWidth = min(column, 420)
        width.constant = boxWidth
        let ratio = frame.map { $0.size.height / max($0.size.width, 1) } ?? 10.0 / 16.0
        height.constant = min(boxWidth * ratio, 352)
        imageView.image = frame
        imageView.alpha = finished ? 0.7 : 1
        placeholder.isHidden = frame != nil
        spinnerBox.isHidden = !task.active
        if task.active { spinner.startAnimating() } else { spinner.stopAnimating() }
        planButton.isHidden = task.plan.isEmpty
        stopButton.isHidden = !((task.active || task.holding) && canStop)
        takeOverButton.isHidden = !task.holding
        resultPill.isHidden = !finished
        resultLabel.text = resultText
        resultLabel.textColor = failed ? Theme.dangerInk : Theme.ink
        resultMark.show(task.state)
        planList.isHidden = !planOpen || task.plan.isEmpty
        planList.configure(task.plan)

        statusPill.isHidden = !(task.active || task.holding)
        let waiting = task.state == .waiting
        statusWaiting.isHidden = !waiting
        let step = waiting ? Self.dropWaitingPrefix(task.status) : task.status
        statusLabel.text = step
        statusLabel.isHidden = step.isEmpty

        compactMark.show(task.state)
        compactLabel.text = resultText
        compactLabel.textColor = failed ? Theme.dangerInk : Theme.ink
        compactLabel.preferredMaxLayoutWidth = floor(column * Theme.Size.bubbleMax) - 80
        compactWidth.constant = floor(column * Theme.Size.bubbleMax)
        compactPlan.isHidden = task.plan.isEmpty
        compactPlanList.configure(task.plan)

        isAccessibilityElement = false
        frameBox.isAccessibilityElement = true
        frameBox.accessibilityLabel = "浏览器画面，\(finished ? resultText : task.status)"
    }

    /// 等批时状态行前面已经有「等你批准」的小胶囊，后面只写那一步。
    private static func dropWaitingPrefix(_ text: String) -> String {
        guard text.hasPrefix("等你批准") else { return text }
        return String(text.dropFirst(4)).trimmingCharacters(in: CharacterSet(charactersIn: "：: "))
    }

    /// 画面上的按钮：高 32，`surface` 底、`ink` 字，往里收 1pt `line` 加 `shadow-raised`。触控区由按钮间距补到 44。
    static func chip(title: String? = nil, image: String? = nil, label: String? = nil) -> UIButton {
        var config = UIButton.Configuration.filled()
        config.title = title
        config.image = image.map { UIImage(systemName: $0, withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .semibold)) } ?? nil
        config.cornerStyle = .capsule
        config.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: title == nil ? 0 : Theme.Space.s3, bottom: 0, trailing: title == nil ? 0 : Theme.Space.s3)
        config.background.strokeColor = Theme.line
        config.background.strokeWidth = 1
        config.paint(fill: Theme.surface, ink: Theme.ink, style: .footnote)
        let button = UIButton(configuration: config)
        button.configurationUpdateHandler = { button in
            button.configuration?.paint(fill: Theme.surface, ink: Theme.ink, pressed: button.isHighlighted, style: .footnote)
        }
        button.applyShadow(.raised)
        button.accessibilityLabel = label
        button.setContentHuggingPriority(.required, for: .horizontal)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.heightAnchor.constraint(equalToConstant: 32).isActive = true
        if title == nil { button.widthAnchor.constraint(equalToConstant: 32).isActive = true }
        return button
    }

    /// 「接手」：`action` 底、`on-action` 字、600。
    static func takeOverChip() -> UIButton {
        var config = UIButton.Configuration.filled()
        config.title = "接手"
        config.cornerStyle = .capsule
        config.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: Theme.Space.s3, bottom: 0, trailing: Theme.Space.s3)
        config.paint(fill: Theme.action, ink: Theme.onAction, style: .footnote)
        let button = UIButton(configuration: config)
        button.configurationUpdateHandler = { button in
            button.configuration?.paint(fill: Theme.action, ink: Theme.onAction, pressed: button.isHighlighted, style: .footnote)
        }
        button.setContentHuggingPriority(.required, for: .horizontal)
        button.heightAnchor.constraint(equalToConstant: 32).isActive = true
        return button
    }
}

/// 画面上浮着的一小块：`surface` 底，往里收 1pt `line`，`shadow-raised`。转圈的小圆、结果胶囊、计划都用它。
final class FloatControlView: OutlineView {
    init(radius: CGFloat) {
        super.init(radius: radius)
        backgroundColor = Theme.surface
        applyShadow(.raised)
    }

    required init?(coder: NSCoder) { fatalError() }
}

/// 结果前面的记号：做完了 `online` 对勾；停下了、等你回话、交给你接手了是 `ink-muted` 的 8pt 圆点；没做完是 `danger` 圆点。
final class ResultMarkView: UIView {
    private let check = UIImageView(image: UIImage(systemName: "checkmark"))
    private let dot = UIView()

    init() {
        super.init(frame: .zero)
        check.tintColor = Theme.online
        check.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 12, weight: .semibold)
        dot.layer.cornerRadius = 4
        for view in [check, dot] {
            view.translatesAutoresizingMaskIntoConstraints = false
            addSubview(view)
            view.centerXAnchor.constraint(equalTo: centerXAnchor).isActive = true
            view.centerYAnchor.constraint(equalTo: centerYAnchor).isActive = true
        }
        translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: 14),
            heightAnchor.constraint(equalToConstant: 14),
            dot.widthAnchor.constraint(equalToConstant: 8),
            dot.heightAnchor.constraint(equalToConstant: 8)
        ])
        setContentHuggingPriority(.required, for: .horizontal)
        isAccessibilityElement = false
    }

    required init?(coder: NSCoder) { fatalError() }

    func show(_ state: BrowserTask.State) {
        check.isHidden = state != .done
        dot.isHidden = state == .done
        dot.backgroundColor = state == .failed ? Theme.danger : Theme.inkMuted
    }
}

/// 计划：每步一行 `footnote`，彼此 8，内边距 10 / 12，`radius-row`。做完的打 `checkmark.circle`（`online`），字用 `ink-muted`；
/// 没做的是 `circle`（`ink-faint`）。浮在画面上时是 `surface` 底加描边和 `shadow-raised`，单独一行时是 `surface-inset` 底。
final class PlanListView: OutlineView {
    private let stack = UIStackView()

    init(floating: Bool) {
        super.init(radius: Theme.Radius.row, color: floating ? Theme.line : .clear)
        backgroundColor = floating ? Theme.surface : Theme.surfaceInset
        if floating { applyShadow(.raised) }
        stack.axis = .vertical
        stack.spacing = Theme.Space.s2
        addSubview(stack)
        stack.pin(to: self, insets: UIEdgeInsets(top: Theme.Space.s2_5, left: Theme.Space.s3, bottom: Theme.Space.s2_5, right: Theme.Space.s3))
        isAccessibilityElement = false
        accessibilityLabel = "计划"
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(_ steps: [BrowserTask.PlanStep]) {
        for view in stack.arrangedSubviews { view.removeFromSuperview() }
        for step in steps {
            let mark = UIImageView(image: UIImage(systemName: step.done ? "checkmark.circle" : "circle"))
            mark.tintColor = step.done ? Theme.online : Theme.inkFaint
            mark.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .footnote)
            mark.setContentHuggingPriority(.required, for: .horizontal)
            let label = UILabel(text: step.text, style: .footnote, color: step.done ? Theme.inkMuted : Theme.ink, lines: 0)
            label.accessibilityLabel = step.done ? "做完了：\(step.text)" : step.text
            let row = UIStackView(arrangedSubviews: [mark, label])
            row.spacing = Theme.Space.s2
            row.alignment = .firstBaseline
            stack.addArrangedSubview(row)
        }
    }
}

/// 点放大：整屏看画面，背后压一层 `scrim`（不加模糊），下面「计划」「收起」「取消任务」。画面跟着新帧更新。
final class BrowserLargeViewController: UIViewController {
    private let frameBox = UIView()
    private let imageView = UIImageView()
    private let caption = UILabel(style: .footnote, color: Theme.inkMuted)
    private let planList = PlanListView(floating: true)
    private var task: BrowserTask
    private let onStop: (() -> Void)?

    init(task: BrowserTask, frame: UIImage?, onStop: (() -> Void)?) {
        self.task = task
        self.onStop = onStop
        super.init(nibName: nil, bundle: nil)
        imageView.image = frame
        modalPresentationStyle = .overFullScreen
        modalTransitionStyle = .crossDissolve
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.scrim
        view.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(backgroundTapped)))

        // 画面：surface-inset 底、radius-bubble，往里收 1pt line，shadow-card。
        frameBox.applyShadow(.card)
        imageView.contentMode = .scaleAspectFit
        imageView.backgroundColor = Theme.surfaceInset
        imageView.layer.cornerRadius = Theme.Radius.bubble
        imageView.layer.cornerCurve = .continuous
        imageView.clipsToBounds = true
        imageView.isAccessibilityElement = true
        imageView.accessibilityLabel = "浏览器画面"
        frameBox.addSubview(imageView)
        imageView.pin(to: frameBox)
        let ring = OutlineView(radius: Theme.Radius.bubble)
        ring.isUserInteractionEnabled = false
        frameBox.addSubview(ring)
        ring.pin(to: frameBox)
        planList.translatesAutoresizingMaskIntoConstraints = false
        planList.isHidden = true
        frameBox.addSubview(planList)

        let plan = Self.bar(title: "计划")
        plan.isHidden = task.plan.isEmpty
        plan.addAction(UIAction { [weak self] _ in self?.planList.isHidden.toggle() }, for: .primaryActionTriggered)
        let close = Self.bar(title: "收起")
        close.addAction(UIAction { [weak self] _ in self?.dismiss(animated: true) }, for: .primaryActionTriggered)
        let cancel = Self.bar(title: "取消任务")
        cancel.isHidden = onStop == nil || !(task.active || task.holding)
        cancel.addAction(UIAction { [weak self] _ in
            self?.onStop?()
            self?.dismiss(animated: true)
        }, for: .primaryActionTriggered)
        let buttons = UIStackView(arrangedSubviews: [plan, close, cancel])
        buttons.spacing = Theme.Space.s2

        // 结果或正在做什么：surface 胶囊，footnote、ink-muted。
        let captionPill = SurfaceView(.surface, radius: 13)
        caption.lineBreakMode = .byTruncatingTail
        captionPill.contentView.addSubview(caption)
        caption.pin(to: captionPill.contentView, insets: UIEdgeInsets(top: Theme.Space.s1, left: Theme.Space.s3, bottom: Theme.Space.s1, right: Theme.Space.s3))
        planList.configure(task.plan)
        update(task: task, frame: nil)

        let stack = UIStackView(arrangedSubviews: [frameBox, captionPill, buttons])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = Theme.Space.s3
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: Theme.Space.s4),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -Theme.Space.s4),
            frameBox.widthAnchor.constraint(equalTo: stack.widthAnchor),
            frameBox.heightAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.heightAnchor, multiplier: 0.62),
            frameBox.heightAnchor.constraint(equalTo: frameBox.widthAnchor, multiplier: 0.65).withPriority(.defaultHigh),
            captionPill.widthAnchor.constraint(lessThanOrEqualTo: stack.widthAnchor),
            planList.trailingAnchor.constraint(equalTo: frameBox.trailingAnchor, constant: -Theme.Space.s3),
            planList.bottomAnchor.constraint(equalTo: frameBox.bottomAnchor, constant: -Theme.Space.s3),
            planList.leadingAnchor.constraint(greaterThanOrEqualTo: frameBox.leadingAnchor, constant: Theme.Space.s3)
        ])
    }

    @objc private func backgroundTapped(_ gesture: UITapGestureRecognizer) {
        guard gesture.view?.hitTest(gesture.location(in: gesture.view), with: nil) === view else { return }
        dismiss(animated: true)
    }

    func update(task: BrowserTask, frame: UIImage?) {
        self.task = task
        if let frame { imageView.image = frame }
        caption.text = task.result ?? task.status
        planList.configure(task.plan)
    }

    /// 放大视图下面的按钮：高 44，左右 16，`subheadline` 600；`surface` 底、往里收 1pt `line`。
    private static func bar(title: String) -> UIButton {
        var config = UIButton.Configuration.filled()
        config.title = title
        config.cornerStyle = .capsule
        config.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: Theme.Space.s4, bottom: 0, trailing: Theme.Space.s4)
        config.background.strokeColor = Theme.line
        config.background.strokeWidth = 1
        config.paint(fill: Theme.surface, ink: Theme.ink, style: .subheadline)
        let button = UIButton(configuration: config)
        button.configurationUpdateHandler = { button in
            button.configuration?.paint(fill: Theme.surface, ink: Theme.ink, pressed: button.isHighlighted, style: .subheadline)
        }
        button.heightAnchor.constraint(equalToConstant: Theme.Size.control).isActive = true
        return button
    }
}

private extension NSLayoutConstraint {
    func withPriority(_ priority: UILayoutPriority) -> NSLayoutConstraint {
        self.priority = priority
        return self
    }
}
