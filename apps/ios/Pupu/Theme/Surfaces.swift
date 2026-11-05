import UIKit

/// 背景层：天空渐变，铺满窗口，不随内容滚动。浅色五段，深色四段。
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

/// 内容层的卡片：标准材质，加一层半透明底、1pt 描边，可选阴影。内容层不用 Liquid Glass。
class SurfaceView: UIView {
    enum Kind {
        /// 容器：开场建议、引用条。
        case glass
        /// 更实的底：Pupu 的消息、「正在做」、审批卡片。
        case strong
        /// 嵌在 strong 里的一层：代码块、分组列表的行。
        case inset
        /// 我发的消息。
        case user
    }

    let contentView = UIView()
    private let blur: UIVisualEffectView
    private let bordered: Bool

    init(_ kind: Kind, radius: CGFloat, lifted: Bool = false) {
        switch kind {
        case .inset:
            blur = UIVisualEffectView(effect: nil)
        default:
            blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterial))
        }
        bordered = kind == .glass || kind == .strong
        super.init(frame: .zero)

        blur.contentView.backgroundColor = switch kind {
        case .glass: Theme.surfaceGlass
        case .strong: Theme.surfaceStrong
        case .inset: Theme.surfaceInset
        case .user: Theme.bubbleUser
        }
        blur.layer.cornerRadius = radius
        blur.layer.cornerCurve = .continuous
        blur.clipsToBounds = true
        if bordered { blur.layer.borderWidth = 1 }
        addSubview(blur)
        blur.pin(to: self)

        contentView.translatesAutoresizingMaskIntoConstraints = false
        blur.contentView.addSubview(contentView)
        contentView.pin(to: blur.contentView)

        if lifted {
            layer.shadowColor = UIColor(red: 15 / 255, green: 23 / 255, blue: 42 / 255, alpha: 1).cgColor
            layer.shadowOpacity = 0.06
            layer.shadowRadius = 10
            layer.shadowOffset = CGSize(width: 0, height: 6)
        }
        updateColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: SurfaceView, _: UITraitCollection) in
            view.updateColors()
        }
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        if layer.shadowOpacity > 0 {
            layer.shadowPath = UIBezierPath(roundedRect: bounds, cornerRadius: blur.layer.cornerRadius).cgPath
        }
    }

    private func updateColors() {
        guard bordered else { return }
        blur.layer.borderColor = Theme.lineGlass.resolvedColor(with: traitCollection).cgColor
    }
}

/// 控件层的 Liquid Glass 底：输入栏、浮动按钮。只用 regular 变体。
final class GlassView: UIVisualEffectView {
    init(radius: CGFloat? = nil, interactive: Bool = false) {
        let effect = UIGlassEffect(style: .regular)
        effect.isInteractive = interactive
        super.init(effect: effect)
        if let radius {
            cornerConfiguration = .corners(radius: .fixed(Double(radius)))
        } else {
            cornerConfiguration = .capsule(maximumRadius: nil)
        }
    }

    required init?(coder: NSCoder) { fatalError() }
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
}

extension UIButton {
    /// 主操作：一屏只有一个，墨色玻璃，字和图标用 on-action。
    static func action(title: String? = nil, image: String? = nil) -> UIButton {
        var config = UIButton.Configuration.prominentGlass()
        config.title = title
        config.image = image.map { UIImage(systemName: $0) } ?? nil
        config.baseForegroundColor = Theme.onAction
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = Theme.font(.body, weight: .semibold)
            return attributes
        }
        let button = UIButton(configuration: config)
        button.tintColor = Theme.action
        return button
    }

    /// 次要操作：玻璃按钮，字用 ink。
    static func glass(title: String? = nil, image: String? = nil) -> UIButton {
        var config = UIButton.Configuration.glass()
        config.title = title
        config.image = image.map { UIImage(systemName: $0) } ?? nil
        config.baseForegroundColor = Theme.ink
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = Theme.font(.body, weight: .semibold)
            return attributes
        }
        return UIButton(configuration: config)
    }
}
