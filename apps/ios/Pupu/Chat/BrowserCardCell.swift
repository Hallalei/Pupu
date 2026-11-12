import UIKit

/// 浏览器任务卡片，学的是 Hark：对话里一张实时画面，右下角「计划」、放大、停止，下面一行状态；
/// 做完了收起来，画面变暗、左下角一句结果。网页的 BrowserCard.tsx 是同一个样子，两边一起改。
final class BrowserCardCell: ChatCell {
    private let frameBox = UIView()
    private let imageView = UIImageView()
    private let placeholder = UILabel(text: "等电脑传画面…", style: .footnote, color: UIColor.white.withAlphaComponent(0.6))
    private let spinnerBox = UIView()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let planButton = BrowserCardCell.darkButton(title: "计划", image: "sparkles")
    private let expandButton = BrowserCardCell.darkButton(image: "arrow.up.left.and.arrow.down.right")
    private let stopButton = BrowserCardCell.darkButton(image: "xmark")
    private let resultPill = UIView()
    private let resultMark = UIImageView()
    private let resultLabel = UILabel(style: .footnote, color: .white)
    private let planList = PlanListView(dark: true)
    private let statusLabel = UILabel(style: .footnote, color: Theme.inkMuted)
    private let statusPill = SurfaceView(.glass, radius: 13)
    /// 做完了、又没留下画面（比如重新打开了 App）：只剩一行结果。
    private let compact = SurfaceView(.strong, radius: Theme.Radius.row)
    private let compactMark = UIImageView()
    private let compactLabel = UILabel(style: .subheadline, lines: 0)
    private let compactPlan = UIButton(configuration: .plain())
    private let compactPlanList = PlanListView(dark: false)
    private let stack = UIStackView()
    private var width: NSLayoutConstraint!
    private var height: NSLayoutConstraint!

    var onStop: (() -> Void)?
    var onExpand: (() -> Void)?
    var onTogglePlan: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        frameBox.backgroundColor = UIColor(white: 0.07, alpha: 1)
        frameBox.layer.cornerRadius = Theme.Radius.bubble
        frameBox.layer.cornerCurve = .continuous
        frameBox.clipsToBounds = true
        // 不裁：计划展开时卡片会被撑高，裁了会切掉页面左边；底色是黑的，留边看不出来。
        imageView.contentMode = .scaleAspectFit
        imageView.clipsToBounds = true
        frameBox.addSubview(imageView)
        imageView.pin(to: frameBox)
        placeholder.translatesAutoresizingMaskIntoConstraints = false
        frameBox.addSubview(placeholder)

        spinnerBox.backgroundColor = UIColor.black.withAlphaComponent(0.6)
        spinnerBox.layer.cornerRadius = 14
        spinner.color = .white
        spinnerBox.addSubview(spinner)
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinnerBox.translatesAutoresizingMaskIntoConstraints = false
        frameBox.addSubview(spinnerBox)

        let buttons = UIStackView(arrangedSubviews: [planButton, expandButton, stopButton])
        buttons.spacing = 6
        buttons.translatesAutoresizingMaskIntoConstraints = false
        frameBox.addSubview(buttons)
        planButton.addAction(UIAction { [weak self] _ in self?.onTogglePlan?() }, for: .primaryActionTriggered)
        expandButton.addAction(UIAction { [weak self] _ in self?.onExpand?() }, for: .primaryActionTriggered)
        stopButton.addAction(UIAction { [weak self] _ in self?.onStop?() }, for: .primaryActionTriggered)
        expandButton.accessibilityLabel = "放大"
        stopButton.accessibilityLabel = "停止"

        resultPill.backgroundColor = UIColor.black.withAlphaComponent(0.75)
        resultPill.layer.cornerRadius = 15
        resultMark.image = UIImage(systemName: "checkmark")
        resultMark.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .footnote, scale: .small)
        resultMark.setContentHuggingPriority(.required, for: .horizontal)
        resultLabel.lineBreakMode = .byTruncatingTail
        resultLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let resultRow = UIStackView(arrangedSubviews: [resultMark, resultLabel])
        resultRow.spacing = 6
        resultRow.alignment = .center
        resultPill.addSubview(resultRow)
        resultRow.pin(to: resultPill, insets: UIEdgeInsets(top: 6, left: 10, bottom: 6, right: 12))
        resultPill.translatesAutoresizingMaskIntoConstraints = false
        frameBox.addSubview(resultPill)

        planList.translatesAutoresizingMaskIntoConstraints = false
        frameBox.addSubview(planList)

        NSLayoutConstraint.activate([
            placeholder.centerXAnchor.constraint(equalTo: frameBox.centerXAnchor),
            placeholder.centerYAnchor.constraint(equalTo: frameBox.centerYAnchor),
            spinnerBox.widthAnchor.constraint(equalToConstant: 28),
            spinnerBox.heightAnchor.constraint(equalToConstant: 28),
            spinnerBox.topAnchor.constraint(equalTo: frameBox.topAnchor, constant: 10),
            spinnerBox.trailingAnchor.constraint(equalTo: frameBox.trailingAnchor, constant: -10),
            spinner.centerXAnchor.constraint(equalTo: spinnerBox.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: spinnerBox.centerYAnchor),
            buttons.trailingAnchor.constraint(equalTo: frameBox.trailingAnchor, constant: -10),
            buttons.bottomAnchor.constraint(equalTo: frameBox.bottomAnchor, constant: -10),
            resultPill.leadingAnchor.constraint(equalTo: frameBox.leadingAnchor, constant: 10),
            resultPill.centerYAnchor.constraint(equalTo: buttons.centerYAnchor),
            resultPill.trailingAnchor.constraint(lessThanOrEqualTo: buttons.leadingAnchor, constant: -8),
            planList.trailingAnchor.constraint(equalTo: frameBox.trailingAnchor, constant: -10),
            planList.leadingAnchor.constraint(greaterThanOrEqualTo: frameBox.leadingAnchor, constant: 10),
            planList.bottomAnchor.constraint(equalTo: buttons.topAnchor, constant: -8)
        ])

        statusPill.contentView.addSubview(statusLabel)
        statusLabel.pin(to: statusPill.contentView, insets: UIEdgeInsets(top: 4, left: 12, bottom: 4, right: 12))

        compactMark.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .subheadline)
        compactMark.setContentHuggingPriority(.required, for: .horizontal)
        var planConfig = UIButton.Configuration.plain()
        planConfig.title = "计划"
        planConfig.baseForegroundColor = Theme.inkMuted
        planConfig.contentInsets = .zero
        compactPlan.configuration = planConfig
        compactPlan.setContentHuggingPriority(.required, for: .horizontal)
        compactPlan.addAction(UIAction { [weak self] _ in self?.onTogglePlan?() }, for: .primaryActionTriggered)
        let compactRow = UIStackView(arrangedSubviews: [compactMark, compactLabel, compactPlan])
        compactRow.spacing = Theme.Space.s2
        compactRow.alignment = .center
        compact.contentView.addSubview(compactRow)
        compactRow.pin(to: compact.contentView, insets: UIEdgeInsets(top: Theme.Space.s2, left: Theme.Space.s3, bottom: Theme.Space.s2, right: Theme.Space.s3))

        stack.axis = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        for view in [frameBox, statusPill, compact, compactPlanList] as [UIView] { stack.addArrangedSubview(view) }
        place(stack, alignment: .left, fraction: 1)
        width = frameBox.widthAnchor.constraint(equalToConstant: 300)
        height = frameBox.heightAnchor.constraint(equalToConstant: 190)
        width.priority = .defaultHigh
        height.priority = .defaultHigh
        NSLayoutConstraint.activate([width, height])
        compact.widthAnchor.constraint(lessThanOrEqualTo: frameBox.widthAnchor).isActive = true
        compactPlanList.widthAnchor.constraint(lessThanOrEqualTo: frameBox.widthAnchor).isActive = true
    }

    required init?(coder: NSCoder) { fatalError() }

    override var bubbleView: UIView? { frameBox }

    func configure(task: BrowserTask, frame: UIImage?, planOpen: Bool, width cardWidth: CGFloat, canStop: Bool) {
        let finished = !task.active
        let resultText = task.result ?? (task.state == .done ? "浏览器里的事做完了" : task.status)
        let showFrame = !(finished && frame == nil)
        frameBox.isHidden = !showFrame
        compact.isHidden = showFrame
        compactPlanList.isHidden = showFrame || !planOpen || task.plan.isEmpty

        let boxWidth = min(cardWidth, 420)
        width.constant = boxWidth
        let ratio = frame.map { $0.size.height / max($0.size.width, 1) } ?? 10.0 / 16.0
        height.constant = min(boxWidth * ratio, 352)
        imageView.image = frame
        imageView.alpha = finished ? 0.7 : 1
        placeholder.isHidden = frame != nil
        spinnerBox.isHidden = !task.active
        if task.active { spinner.startAnimating() } else { spinner.stopAnimating() }
        planButton.isHidden = task.plan.isEmpty
        stopButton.isHidden = !(task.active && canStop)
        resultPill.isHidden = !finished
        resultLabel.text = resultText
        resultMark.tintColor = task.state == .done ? UIColor.systemGreen : UIColor.white.withAlphaComponent(0.7)
        resultMark.image = UIImage(systemName: task.state == .done ? "checkmark" : "circle.fill")
        planList.isHidden = !planOpen || task.plan.isEmpty
        planList.configure(task.plan)
        statusPill.isHidden = !task.active
        statusLabel.text = task.status

        compactMark.image = UIImage(systemName: task.state == .done ? "checkmark" : "circle.fill")
        compactMark.tintColor = task.state == .done ? UIColor.systemGreen : Theme.inkMuted
        compactLabel.text = resultText
        compactLabel.preferredMaxLayoutWidth = boxWidth - 80
        compactPlan.isHidden = task.plan.isEmpty
        compactPlanList.configure(task.plan)

        isAccessibilityElement = false
        frameBox.isAccessibilityElement = true
        frameBox.accessibilityLabel = "浏览器画面，\(finished ? resultText : task.status)"
    }

    static func darkButton(title: String? = nil, image: String) -> UIButton {
        var config = UIButton.Configuration.filled()
        config.title = title
        config.image = UIImage(systemName: image)
        config.imagePadding = 4
        config.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(textStyle: .footnote, scale: .small)
        config.baseBackgroundColor = UIColor.black.withAlphaComponent(0.7)
        config.baseForegroundColor = .white
        config.cornerStyle = .capsule
        config.contentInsets = NSDirectionalEdgeInsets(top: 7, leading: title == nil ? 8 : 12, bottom: 7, trailing: title == nil ? 8 : 12)
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = Theme.font(.footnote)
            return attributes
        }
        let button = UIButton(configuration: config)
        button.setContentHuggingPriority(.required, for: .horizontal)
        return button
    }
}

/// 计划的几步，做完的打勾。
final class PlanListView: UIView {
    private let stack = UIStackView()
    private let dark: Bool

    init(dark: Bool) {
        self.dark = dark
        super.init(frame: .zero)
        backgroundColor = dark ? UIColor.black.withAlphaComponent(0.82) : Theme.surfaceStrong
        layer.cornerRadius = Theme.Radius.row
        layer.cornerCurve = .continuous
        stack.axis = .vertical
        stack.spacing = 6
        addSubview(stack)
        stack.pin(to: self, insets: UIEdgeInsets(top: 10, left: 12, bottom: 10, right: 12))
        accessibilityLabel = "计划"
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(_ steps: [BrowserTask.PlanStep]) {
        for view in stack.arrangedSubviews { view.removeFromSuperview() }
        for step in steps {
            let mark = UIImageView(image: UIImage(systemName: step.done ? "checkmark.circle.fill" : "circle"))
            mark.tintColor = step.done ? .systemGreen : (dark ? UIColor.white.withAlphaComponent(0.6) : Theme.inkMuted)
            mark.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .footnote)
            mark.setContentHuggingPriority(.required, for: .horizontal)
            let label = UILabel(text: step.text, style: .footnote, color: dark ? .white : Theme.ink, lines: 0)
            label.alpha = step.done ? 0.75 : 1
            let row = UIStackView(arrangedSubviews: [mark, label])
            row.spacing = 8
            row.alignment = .firstBaseline
            stack.addArrangedSubview(row)
        }
    }
}

/// 点放大：整屏看画面，下面「计划」「收起」「取消任务」。画面跟着新帧更新。
final class BrowserLargeViewController: UIViewController {
    private let imageView = UIImageView()
    private let caption = UILabel(style: .footnote, color: .white, lines: 2)
    private let planList = PlanListView(dark: true)
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
        let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemThickMaterialDark))
        view.addSubview(blur)
        blur.pin(to: view)

        imageView.contentMode = .scaleAspectFit
        imageView.backgroundColor = UIColor(white: 0.07, alpha: 1)
        imageView.layer.cornerRadius = Theme.Radius.bubble
        imageView.layer.cornerCurve = .continuous
        imageView.clipsToBounds = true
        imageView.isAccessibilityElement = true
        imageView.accessibilityLabel = "浏览器画面"

        let plan = BrowserCardCell.darkButton(title: "计划", image: "sparkles")
        plan.isHidden = task.plan.isEmpty
        plan.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.planList.isHidden.toggle()
        }, for: .primaryActionTriggered)
        let close = BrowserCardCell.darkButton(image: "arrow.down.right.and.arrow.up.left")
        close.accessibilityLabel = "收起"
        close.addAction(UIAction { [weak self] _ in self?.dismiss(animated: true) }, for: .primaryActionTriggered)
        let cancel = BrowserCardCell.darkButton(title: "取消任务", image: "stop.fill")
        cancel.isHidden = onStop == nil || !task.active
        cancel.addAction(UIAction { [weak self] _ in
            self?.onStop?()
            self?.dismiss(animated: true)
        }, for: .primaryActionTriggered)
        let buttons = UIStackView(arrangedSubviews: [plan, close, cancel])
        buttons.spacing = Theme.Space.s2

        planList.isHidden = true
        planList.configure(task.plan)
        caption.textAlignment = .center
        update(task: task, frame: nil)

        let stack = UIStackView(arrangedSubviews: [imageView, planList, buttons, caption])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = Theme.Space.s3
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: Theme.Space.s4),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -Theme.Space.s4),
            imageView.widthAnchor.constraint(equalTo: stack.widthAnchor),
            imageView.heightAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.heightAnchor, multiplier: 0.62),
            imageView.heightAnchor.constraint(equalTo: imageView.widthAnchor, multiplier: 0.65).withPriority(.defaultHigh),
            planList.widthAnchor.constraint(lessThanOrEqualTo: stack.widthAnchor)
        ])
    }

    func update(task: BrowserTask, frame: UIImage?) {
        self.task = task
        if let frame { imageView.image = frame }
        caption.text = task.result ?? task.status
        planList.configure(task.plan)
    }
}

private extension NSLayoutConstraint {
    func withPriority(_ priority: UILayoutPriority) -> NSLayoutConstraint {
        self.priority = priority
        return self
    }
}
