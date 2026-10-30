import UIKit

/// Pupu 消息里的 Markdown。块级结构按行自己拆，行内的粗体、斜体、代码、链接交给 Foundation 解析。
/// 流式输出时文字是半截的：没闭合的代码块先按代码块画，后面的字来了再重画。
enum Markdown {
    enum Segment: Equatable {
        case text(NSAttributedString)
        /// 代码块和表格：等宽字，宽了在块里横向滚动。
        case code(String)
    }

    /// 链接放在自己的属性里：`.link` 会被画成系统蓝，规范要的是 ink 加下划线。
    static let linkKey = NSAttributedString.Key("PupuLink")

    private static var cache: [String: [Segment]] = [:]

    static func segments(_ source: String) -> [Segment] {
        if let hit = cache[source] { return hit }
        let result = parse(source)
        if cache.count > 300 { cache.removeAll() }
        cache[source] = result
        return result
    }

    /// 字号变了，缓存里的字体就过时了。
    static func reset() {
        cache.removeAll()
    }

    /// 复制用的纯文字。
    static func plainText(_ source: String) -> String {
        segments(source).map { segment in
            switch segment {
            case .text(let text): text.string.replacingOccurrences(of: "\u{2028}", with: "\n")
            case .code(let code): code
            }
        }.joined(separator: "\n")
    }

    private enum Block {
        case paragraph([String])
        case heading(String)
        case item(marker: String, level: Int, text: String)
        case quote([String])
        case rule
    }

    private static func parse(_ source: String) -> [Segment] {
        var segments: [Segment] = []
        var blocks: [Block] = []
        var paragraph: [String] = []
        var quote: [String] = []
        var table: [String] = []
        var code: [String]?
        var fence: Character = "`"

        func closeParagraph() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph)) }
            if !quote.isEmpty { blocks.append(.quote(quote)) }
            paragraph = []
            quote = []
        }
        func closeText() {
            closeParagraph()
            if !blocks.isEmpty { segments.append(.text(render(blocks))) }
            blocks = []
        }
        func closeTable() {
            if !table.isEmpty { segments.append(.code(table.joined(separator: "\n"))) }
            table = []
        }
        func closeCode(_ lines: [String]) {
            var lines = lines
            while lines.last?.isBlank == true { lines.removeLast() }
            segments.append(.code(lines.joined(separator: "\n")))
        }

        for raw in source.components(separatedBy: "\n") {
            let line = raw.replacingOccurrences(of: "\t", with: "    ")
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let lines = code {
                if trimmed.count >= 3, trimmed.allSatisfy({ $0 == fence }) {
                    closeCode(lines)
                    code = nil
                } else {
                    code = lines + [line]
                }
                continue
            }
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                closeText()
                closeTable()
                fence = trimmed.first ?? "`"
                code = []
                continue
            }
            if trimmed.hasPrefix("|") {
                closeText()
                table.append(trimmed)
                continue
            }
            closeTable()
            if trimmed.isEmpty {
                closeParagraph()
            } else if let heading = heading(trimmed) {
                closeParagraph()
                blocks.append(.heading(heading))
            } else if let item = listItem(line) {
                closeParagraph()
                blocks.append(item)
            } else if trimmed.hasPrefix(">") {
                if !paragraph.isEmpty { blocks.append(.paragraph(paragraph)) }
                paragraph = []
                var rest = trimmed.dropFirst()
                if rest.first == " " { rest = rest.dropFirst() }
                quote.append(String(rest))
            } else if isRule(trimmed) {
                closeParagraph()
                blocks.append(.rule)
            } else {
                if !quote.isEmpty { blocks.append(.quote(quote)) }
                quote = []
                paragraph.append(trimmed)
            }
        }
        if let code { closeCode(code) }
        closeTable()
        closeText()
        return segments
    }

    private static func heading(_ line: String) -> String? {
        let hashes = line.prefix { $0 == "#" }.count
        guard (1...6).contains(hashes) else { return nil }
        let rest = line.dropFirst(hashes)
        guard rest.first == " " else { return nil }
        let text = rest.trimmingCharacters(in: .whitespaces)
        return text.isEmpty ? nil : text
    }

    private static func listItem(_ line: String) -> Block? {
        let indent = line.prefix { $0 == " " }.count
        let rest = line.dropFirst(indent)
        let level = min(indent / 2, 3)
        if let first = rest.first, "-*+".contains(first), rest.dropFirst().first == " " {
            return .item(marker: "•", level: level, text: rest.dropFirst(2).trimmingCharacters(in: .whitespaces))
        }
        let digits = rest.prefix { $0.isASCII && $0.isNumber }
        guard !digits.isEmpty, digits.count <= 3 else { return nil }
        let after = rest.dropFirst(digits.count)
        guard let mark = after.first, mark == "." || mark == ")", after.dropFirst().first == " " else { return nil }
        return .item(marker: "\(digits).", level: level, text: after.dropFirst(2).trimmingCharacters(in: .whitespaces))
    }

    private static func isRule(_ line: String) -> Bool {
        let marks = line.filter { $0 != " " }
        guard marks.count >= 3, let first = marks.first, "-*_".contains(first) else { return false }
        return marks.allSatisfy { $0 == first }
    }

    private static func render(_ blocks: [Block]) -> NSAttributedString {
        let result = NSMutableAttributedString()
        let body = Theme.font(.message)
        let base = Theme.messageAttributes()
        let offset = base[.baselineOffset] ?? 0
        var previous: Block?

        for (index, block) in blocks.enumerated() {
            let start = result.length
            let paragraph = Theme.messageParagraph()
            var spacing: CGFloat = Theme.Space.s2
            switch block {
            case .paragraph(let lines):
                result.append(inline(lines.joined(separator: "\u{2028}"), font: body, color: Theme.ink))
            case .heading(let text):
                result.append(inline(text, font: Theme.font(.headline), color: Theme.ink))
                if index > 0 { spacing = Theme.Space.s3 }
            case .item(let marker, let level, let text):
                let indent = CGFloat(level) * Theme.Space.s4
                let column: CGFloat = marker == "•" ? 16 : 24
                paragraph.firstLineHeadIndent = indent
                paragraph.headIndent = indent + column
                paragraph.tabStops = [NSTextTab(textAlignment: .left, location: indent + column)]
                result.append(NSAttributedString(string: marker + "\t", attributes: [.font: body, .foregroundColor: Theme.inkMuted]))
                result.append(inline(text, font: body, color: Theme.ink))
                if case .item = previous { spacing = Theme.Space.s1 }
            case .quote(let lines):
                paragraph.firstLineHeadIndent = Theme.Space.s3
                paragraph.headIndent = Theme.Space.s3
                result.append(inline(lines.joined(separator: "\u{2028}"), font: body, color: Theme.inkMuted))
            case .rule:
                paragraph.alignment = .center
                result.append(NSAttributedString(string: "· · ·", attributes: [.font: body, .foregroundColor: Theme.inkMuted]))
            }
            if index < blocks.count - 1 {
                result.append(NSAttributedString(string: "\n", attributes: [.font: body]))
            }
            paragraph.paragraphSpacingBefore = index == 0 ? 0 : spacing
            let range = NSRange(location: start, length: result.length - start)
            result.addAttribute(.paragraphStyle, value: paragraph, range: range)
            result.addAttribute(.baselineOffset, value: offset, range: range)
            previous = block
        }
        detectLinks(in: result)
        return result
    }

    private static func inline(_ text: String, font: UIFont, color: UIColor) -> NSAttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: false,
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        guard let parsed = try? AttributedString(markdown: text, options: options) else {
            return NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color])
        }
        let result = NSMutableAttributedString()
        for run in parsed.runs {
            var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
            let intent = run.inlinePresentationIntent ?? []
            if intent.contains(.code) {
                attributes[.font] = Theme.font(.code)
                attributes[.backgroundColor] = Theme.surfaceInset
            } else {
                var traits: UIFontDescriptor.SymbolicTraits = []
                if intent.contains(.stronglyEmphasized) { traits.insert(.traitBold) }
                if intent.contains(.emphasized) { traits.insert(.traitItalic) }
                if !traits.isEmpty,
                   let descriptor = font.fontDescriptor.withSymbolicTraits(font.fontDescriptor.symbolicTraits.union(traits)) {
                    attributes[.font] = UIFont(descriptor: descriptor, size: 0)
                }
            }
            if intent.contains(.strikethrough) {
                attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
            }
            if let link = run.link {
                attributes[linkKey] = link
                attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
            }
            result.append(NSAttributedString(string: String(parsed[run.range].characters), attributes: attributes))
        }
        return result
    }

    /// 模型常直接写网址，不加 Markdown 链接语法。
    private static let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

    private static func detectLinks(in text: NSMutableAttributedString) {
        guard let detector else { return }
        let whole = NSRange(location: 0, length: text.length)
        for match in detector.matches(in: text.string, range: whole) {
            guard let url = match.url, ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { continue }
            if text.attribute(linkKey, at: match.range.location, effectiveRange: nil) != nil { continue }
            text.addAttributes([linkKey: url, .underlineStyle: NSUnderlineStyle.single.rawValue], range: match.range)
        }
    }
}

/// 能点链接的标签。点的位置换算成字符，再看那里有没有链接。
/// 换算的办法来自 MessageKit 的 MessageLabel（MIT 协议）：搭一套和标签同尺寸的 TextKit 1 排版去对位置，
/// 点在这一行的实际文字范围外就不算。
final class LinkLabel: UILabel {
    var onLink: ((URL) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        numberOfLines = 0
        adjustsFontForContentSizeCategory = false
        isUserInteractionEnabled = true
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
    }

    required init?(coder: NSCoder) { fatalError() }

    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
        guard let url = link(at: gesture.location(in: self)) else { return }
        onLink?(url)
    }

    private func link(at point: CGPoint) -> URL? {
        guard let text = attributedText, text.length > 0 else { return nil }
        let storage = NSTextStorage(attributedString: text)
        let layout = NSLayoutManager()
        let container = NSTextContainer(size: bounds.size)
        container.lineFragmentPadding = 0
        container.maximumNumberOfLines = numberOfLines
        container.lineBreakMode = lineBreakMode
        layout.addTextContainer(container)
        storage.addLayoutManager(layout)
        let glyph = layout.glyphIndex(for: point, in: container)
        guard layout.lineFragmentUsedRect(forGlyphAt: glyph, effectiveRange: nil).contains(point) else { return nil }
        let index = layout.characterIndexForGlyph(at: glyph)
        return text.attribute(Markdown.linkKey, at: index, effectiveRange: nil) as? URL
    }
}
