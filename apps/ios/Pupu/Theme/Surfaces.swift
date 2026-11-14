import UIKit

/// 登录页的天空（品牌层，只在登录页）：铺满窗口，不随内容滚动。浅色五段，深色四段。
final class SkyView: UIView {
    override class var layerClass: AnyClass { CAGradientLayer.self }

    private var gradient: CAGradientLayer { layer as! CAGradientLayer }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        update()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: SkyView, _: UITraitCollection) in
            view.update()
        }
    }

    required init?(coder: NSCoder) { fatalError() }

    private func update() {
        let dark = traitCollection.userInterfaceStyle == .dark
        let colors = dark ? Array(Theme.sky.prefix(4)) : Theme.sky
        gradient.colors = colors.map { $0.resolvedColor(with: traitCollection).cgColor }
        gradient.locations = (dark ? [0, 0.35, 0.7, 1] : [0, 0.28, 0.52, 0.76, 1]).map { NSNumber(value: $0) }
    }
}

/// 实色的一块：卡片里嵌的一层、气泡、分组的行。不加模糊，不描边，不加阴影。
/// 内容放进 `contentView`，超出圆角的部分裁掉。
class SurfaceView: UIView {
    enum Kind {
        /// 会话卡的底色：浮在 surface-inset 上的小块。
        case surface
        /// 卡片里再嵌一层：代码块、工具卡片、开场建议、分组的行。
        case inset
        /// 我和别人的气泡。
        case user
    }

    let contentView = UIView()

    init(_ kind: Kind, radius: CGFloat) {
        super.init(frame: .zero)
        backgroundColor = switch kind {
        case .surface: Theme.surface
        case .inset: Theme.surfaceInset
        case .user: Theme.bubbleUser
        }
        layer.cornerRadius = radius
        layer.cornerCurve = .continuous
        clipsToBounds = true
        contentView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(contentView)
        contentView.pin(to: self)
    }

    required init?(coder: NSCoder) { fatalError() }
}

/// 往里收的一圈 1pt `line` 描边（规范 ComputerCard、TaskList、ApprovalCard 的外框），底色由调用方给。描边色跟着深浅色换。
class OutlineView: UIView {
    init(radius: CGFloat, color: UIColor = Theme.line) {
        super.init(frame: .zero)
        layer.cornerRadius = radius
        layer.cornerCurve = .continuous
        layer.borderWidth = 1
        layer.borderColor = color.resolvedColor(with: traitCollection).cgColor
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: OutlineView, _: UITraitCollection) in
            view.layer.borderColor = color.resolvedColor(with: view.traitCollection).cgColor
        }
    }

    required init?(coder: NSCoder) { fatalError() }
}

/// 窗框上的会话卡（规范 README 三层、uikit.md「会话卡片」）：`surface` 底，上角 26、下角 41，
/// 外面 `shadow-card`（浅色一圈 0.5pt 黑 6% 加 0 8 30 的投影，深色只留一圈白 8%）。
/// 内容放进 `contentView`，按卡片的形状裁。阴影画在外面这一层，所以这一层不裁。
final class CardView: UIView {
    let contentView = UIView()
    private let ring = CAShapeLayer()
    /// 上角：会话卡 `card-top` 26；登录页贴底的卡片是 `radius-sheet-top` 32（规范 SignIn）。
    private let topRadius: CGFloat

    init(topRadius: CGFloat = Theme.Radius.cardTop) {
        self.topRadius = topRadius
        super.init(frame: .zero)
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOffset = CGSize(width: 0, height: 8)
        layer.shadowRadius = 15
        contentView.backgroundColor = Theme.surface
        contentView.cornerConfiguration = .uniformEdges(topRadius: .fixed(topRadius), bottomRadius: .fixed(Theme.Radius.card))
        contentView.clipsToBounds = true
        contentView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(contentView)
        contentView.pin(to: self)
        // 那圈 0.5pt 的边盖在内容上面，和网页的 box-shadow 一样不占位。
        ring.fillColor = nil
        ring.lineWidth = 1
        layer.addSublayer(ring)
        updateColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: CardView, _: UITraitCollection) in
            view.updateColors()
        }
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        let path = Self.path(in: bounds, top: topRadius).cgPath
        layer.shadowPath = path
        ring.frame = bounds
        ring.path = path
        // 线宽 1、只露出里面那一半：0.5pt 的边画在卡片里面。
        let mask = CAShapeLayer()
        mask.path = path
        ring.mask = mask
    }

    /// 卡片的外形：上角 `top`，下角 card。两个圆角矩形合成一条轮廓（直接拼两段会在中间多画两道横线）。
    static func path(in rect: CGRect, top: CGFloat = Theme.Radius.cardTop) -> UIBezierPath {
        let bottom = Theme.Radius.card
        guard rect.height > top + bottom, rect.width > bottom * 2 else { return UIBezierPath(rect: rect) }
        let upper = UIBezierPath(roundedRect: CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height - bottom), byRoundingCorners: [.topLeft, .topRight], cornerRadii: CGSize(width: top, height: top)).cgPath
        let lower = UIBezierPath(roundedRect: CGRect(x: rect.minX, y: rect.minY + top, width: rect.width, height: rect.height - top), byRoundingCorners: [.bottomLeft, .bottomRight], cornerRadii: CGSize(width: bottom, height: bottom)).cgPath
        return UIBezierPath(cgPath: upper.union(lower))
    }

    private func updateColors() {
        let dark = traitCollection.userInterfaceStyle == .dark
        layer.shadowOpacity = dark ? 0 : 0.1
        ring.strokeColor = (dark ? UIColor(white: 1, alpha: 0.08) : UIColor(white: 0, alpha: 0.06)).cgColor
    }

    /// 放成一页的会话卡：上边贴着导航栏，左右下各离屏幕 `frame-gap`。
    func placeAsSession(in view: UIView) {
        translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(self)
        NSLayoutConstraint.activate([
            topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: Theme.Space.frameGap),
            trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -Theme.Space.frameGap),
            bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -Theme.Space.frameGap)
        ])
    }
}

extension Project {
    /// 这个空间的窗框色（规范 SpaceColor 的 `frame-*`）。
    var frameColor: UIColor { Theme.SpaceColor(id: color).frame }
}

/// 卡片里的淡出（uikit.md「卡片上沿的淡出」）：一段从卡片底色（`surface`）到透明的渐变，盖在消息列表上面。
/// `top`：列表顶上 16pt，往上滚的消息不会被卡片上沿硬切。`bottom`：垫在输入栏后面，上面 12pt 淡开，下面实色，
/// 滚到输入栏后面的消息不从两边露出来。规范写的是给列表加渐变 mask；底下就是实色的卡片，盖一层渐变看起来一样，滚动时不用离屏渲染。
final class FadeEdgeView: UIView {
    enum Edge { case top, bottom }

    override class var layerClass: AnyClass { CAGradientLayer.self }

    private var gradient: CAGradientLayer { layer as! CAGradientLayer }
    private let edge: Edge

    init(_ edge: Edge) {
        self.edge = edge
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        isAccessibilityElement = false
        update()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: FadeEdgeView, _: UITraitCollection) in
            view.update()
        }
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        update()
    }

    private func update() {
        let solid = Theme.surface.resolvedColor(with: traitCollection)
        let clear = solid.withAlphaComponent(0)
        switch edge {
        case .top:
            gradient.colors = [solid.cgColor, clear.cgColor]
            gradient.locations = [0, 1]
        case .bottom:
            let fade = bounds.height > 0 ? min(Theme.Space.s3 / bounds.height, 1) : 0
            gradient.colors = [clear.cgColor, solid.cgColor, solid.cgColor]
            gradient.locations = [0, NSNumber(value: Double(fade)), 1]
        }
    }
}

extension UIView {
    func pin(to other: UIView, insets: UIEdgeInsets = .zero) {
        translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            leadingAnchor.constraint(equalTo: other.leadingAnchor, constant: insets.left),
            trailingAnchor.constraint(equalTo: other.trailingAnchor, constant: -insets.right),
            topAnchor.constraint(equalTo: other.topAnchor, constant: insets.top),
            bottomAnchor.constraint(equalTo: other.bottomAnchor, constant: -insets.bottom)
        ])
    }

    /// 小东西的阴影（`selected`、`raised`），形状跟着 layer 的圆角。这一层不能裁（`clipsToBounds`），不然投影被裁掉。
    /// 规范里只有 `card` 在深色下换成白边，这两种深浅一样（深色下几乎看不出，和网页一样）。
    func applyShadow(_ shadow: Theme.Shadow) {
        layer.shadowColor = UIColor.black.cgColor
        switch shadow {
        case .card:
            layer.shadowOffset = CGSize(width: 0, height: 8)
            layer.shadowRadius = 15
            layer.shadowOpacity = 0.1
        case .selected:
            layer.shadowOffset = CGSize(width: 0, height: 1)
            layer.shadowRadius = 1.5
            layer.shadowOpacity = 0.08
            layer.borderWidth = 0.5
            layer.borderColor = UIColor(white: 0, alpha: 0.06).cgColor
        case .raised:
            layer.shadowOffset = CGSize(width: 0, height: 1)
            layer.shadowRadius = 1
            layer.shadowOpacity = 0.06
        }
    }
}

extension UIButton.Configuration {
    /// 按这一刻的状态上色：底色、图标和字都固定成给的颜色，系统不再自己调暗；按下时底色淡一点。
    /// `.filled()` 点不了时系统会换成它自己的灰，规范要的是 `action-off`，所以颜色都由这里给。
    mutating func paint(fill: UIColor, ink: UIColor, pressed: Bool = false, style: Theme.Text = .body) {
        let shown = pressed ? UIColor { traits in
            let color = fill.resolvedColor(with: traits)
            return color.withAlphaComponent(color.cgColor.alpha * 0.8)
        } : fill
        baseBackgroundColor = shown
        baseForegroundColor = ink
        background.backgroundColorTransformer = UIConfigurationColorTransformer { _ in shown }
        imageColorTransformer = UIConfigurationColorTransformer { _ in ink }
        titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = Theme.font(style, weight: .semibold)
            attributes.foregroundColor = ink
            return attributes
        }
    }
}

extension UIButton {
    /// 主操作（uikit.md「发送、停止」）：一屏只有一个，`.filled()` 墨色胶囊，字和图标用 on-action；
    /// 点不了时 `action-off` 底、`ink-muted` 字。
    static func action(title: String? = nil, image: String? = nil) -> UIButton {
        var config = UIButton.Configuration.filled()
        config.title = title
        config.image = image.map { UIImage(systemName: $0) } ?? nil
        config.cornerStyle = .capsule
        config.paint(fill: Theme.action, ink: Theme.onAction)
        let button = UIButton(configuration: config)
        button.configurationUpdateHandler = { button in
            let on = button.isEnabled
            button.configuration?.paint(fill: on ? Theme.action : Theme.actionOff, ink: on ? Theme.onAction : Theme.inkMuted, pressed: button.isHighlighted)
        }
        return button
    }

    /// 次要操作（uikit.md「次要按钮」）：`.gray()` 胶囊，底换成 surface-inset，字用 ink；点不了时字换 ink-muted。
    static func secondary(title: String? = nil, image: String? = nil, style: Theme.Text = .body) -> UIButton {
        var config = UIButton.Configuration.gray()
        config.title = title
        config.image = image.map { UIImage(systemName: $0) } ?? nil
        config.cornerStyle = .capsule
        config.paint(fill: Theme.surfaceInset, ink: Theme.ink, style: style)
        let button = UIButton(configuration: config)
        button.configurationUpdateHandler = { button in
            button.configuration?.paint(fill: Theme.surfaceInset, ink: button.isEnabled ? Theme.ink : Theme.inkMuted, pressed: button.isHighlighted, style: style)
        }
        return button
    }

    /// 远程桌面黑底画面上的按钮（规范 RemoteDesktop）：`.filled()`，`island-fill` 底、`on-island` 图标，胶囊，不用玻璃。
    static func island(image: String) -> UIButton {
        var config = UIButton.Configuration.filled()
        config.image = UIImage(systemName: image, withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .medium))
        config.cornerStyle = .capsule
        config.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: Theme.Space.s4, bottom: 0, trailing: Theme.Space.s4)
        config.paint(fill: Theme.islandFill, ink: Theme.onIsland)
        let button = UIButton(configuration: config)
        button.configurationUpdateHandler = { button in
            button.configuration?.paint(fill: Theme.islandFill, ink: Theme.onIsland, pressed: button.isHighlighted)
        }
        return button
    }

    /// 圆形图标按钮（默认 `control-sm` 36，触控区由调用方补到 44）：底色和图标色由调用方给。
    static func round(image: String, background: UIColor = Theme.surfaceInset, foreground: UIColor = Theme.ink, side: CGFloat = Theme.Size.controlSmall, label: String) -> UIButton {
        var config = UIButton.Configuration.filled()
        config.image = UIImage(systemName: image, withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold))
        config.cornerStyle = .capsule
        config.contentInsets = .zero
        config.paint(fill: background, ink: foreground)
        let button = UIButton(configuration: config)
        button.configurationUpdateHandler = { button in
            button.configuration?.paint(fill: background, ink: button.isEnabled ? foreground : Theme.inkFaint, pressed: button.isHighlighted)
        }
        button.accessibilityLabel = label
        button.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            button.widthAnchor.constraint(equalToConstant: side),
            button.heightAnchor.constraint(equalToConstant: side)
        ])
        return button
    }
}

extension UIBarButtonItem {
    /// sheet 顶上的返回和关闭（规范 SettingsSheet「二级页」）：34 的实色圆，`surface-inset` 底，系统不再套一层玻璃。
    static func sheetButton(image: String, label: String, action: @escaping () -> Void) -> UIBarButtonItem {
        let button = UIButton.round(image: image, side: 34, label: label)
        button.addAction(UIAction { _ in action() }, for: .primaryActionTriggered)
        let item = UIBarButtonItem(customView: button)
        item.hidesSharedBackground = true
        return item
    }
}

/// 设置、Artifacts 这类整页 sheet 的导航（规范 SettingsSheet「外观」）：底是 `surface-sheet`，导航栏透明，标题用 `title`；
/// 推进去的每一页左边是自己的返回圆。换了自己的返回，侧滑返回要导航控制器自己放行。
final class SheetNavigationController: UINavigationController, UIGestureRecognizerDelegate {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.surfaceSheet
        let appearance = UINavigationBarAppearance()
        appearance.configureWithTransparentBackground()
        appearance.titleTextAttributes = [.font: Theme.font(.title), .foregroundColor: Theme.ink]
        navigationBar.standardAppearance = appearance
        navigationBar.scrollEdgeAppearance = appearance
        navigationBar.compactAppearance = appearance
        navigationBar.prefersLargeTitles = false
        interactivePopGestureRecognizer?.delegate = self
    }

    override func pushViewController(_ viewController: UIViewController, animated: Bool) {
        if !viewControllers.isEmpty {
            viewController.navigationItem.hidesBackButton = true
            viewController.navigationItem.leftBarButtonItem = .sheetButton(image: "chevron.left", label: "返回") { [weak self, weak viewController] in
                guard let self, let viewController, self.topViewController === viewController else { return }
                self.popViewController(animated: true)
            }
        }
        viewController.navigationItem.largeTitleDisplayMode = .never
        super.pushViewController(viewController, animated: animated)
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        viewControllers.count > 1
    }
}

/// 输入框（uikit.md「输入框」）：不描边，surface-inset 底，圆角 radius-field 12，高 44，左右留 12。
final class FieldView: UITextField {
    override init(frame: CGRect) {
        super.init(frame: frame)
        borderStyle = .none
        backgroundColor = Theme.surfaceInset
        layer.cornerRadius = Theme.Radius.field
        layer.cornerCurve = .continuous
        font = Theme.font(.body)
        adjustsFontForContentSizeCategory = true
        textColor = Theme.ink
        tintColor = Theme.ink
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(greaterThanOrEqualToConstant: Theme.Size.control).isActive = true
    }

    required init?(coder: NSCoder) { fatalError() }

    override var placeholder: String? {
        didSet {
            attributedPlaceholder = placeholder.map {
                NSAttributedString(string: $0, attributes: [.foregroundColor: Theme.inkMuted, .font: Theme.font(.body)])
            }
        }
    }

    override func textRect(forBounds bounds: CGRect) -> CGRect {
        super.textRect(forBounds: bounds).inset(by: UIEdgeInsets(top: 0, left: Theme.Space.s3, bottom: 0, right: Theme.Space.s3))
    }

    override func editingRect(forBounds bounds: CGRect) -> CGRect {
        textRect(forBounds: bounds)
    }

    override func placeholderRect(forBounds bounds: CGRect) -> CGRect {
        textRect(forBounds: bounds)
    }
}

/// 开关（规范 README「开关」）：开着 `action` 底、`on-action` 圆钮；关着交给系统。
final class SwitchView: UISwitch {
    override init(frame: CGRect) {
        super.init(frame: frame)
        onTintColor = Theme.action
        addAction(UIAction { [weak self] _ in self?.paintThumb() }, for: .valueChanged)
        paintThumb()
    }

    required init?(coder: NSCoder) { fatalError() }

    override var isOn: Bool {
        didSet { paintThumb() }
    }

    override func setOn(_ on: Bool, animated: Bool) {
        super.setOn(on, animated: animated)
        paintThumb()
    }

    private func paintThumb() {
        thumbTintColor = isOn ? Theme.onAction : nil
    }
}
