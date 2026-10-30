import Foundation

/// 服务端发来的 pi 事件形状很多，这里不逐个建类型，按需取字段。
nonisolated enum JSON: Decodable, Sendable, Equatable {
    case object([String: JSON])
    case array([JSON])
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSON].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSON].self))
        }
    }

    static func parse(_ text: String) -> JSON? {
        try? JSONDecoder().decode(JSON.self, from: Data(text.utf8))
    }

    subscript(key: String) -> JSON? {
        if case .object(let object) = self { return object[key] }
        return nil
    }

    subscript(index: Int) -> JSON? {
        if case .array(let array) = self, array.indices.contains(index) { return array[index] }
        return nil
    }

    var string: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    var number: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    var bool: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    var array: [JSON]? {
        if case .array(let value) = self { return value }
        return nil
    }

    var object: [String: JSON]? {
        if case .object(let value) = self { return value }
        return nil
    }

    var isNull: Bool { self == .null }

    /// 字符串原样返回；整数去掉小数点，比如 pi 的 entry id。
    var idString: String? {
        switch self {
        case .string(let value): value
        case .number(let value): value == value.rounded() ? String(Int64(value)) : String(value)
        default: nil
        }
    }

    /// 把参数这类小对象写回紧凑的 JSON 文本，给界面显示用。
    var compactText: String {
        switch self {
        case .string(let value): value
        case .number(let value): value == value.rounded() ? String(Int64(value)) : String(value)
        case .bool(let value): value ? "true" : "false"
        case .null: "null"
        case .array(let items): "[" + items.map(\.compactText).joined(separator: ", ") + "]"
        case .object(let fields):
            "{" + fields.keys.sorted().map { "\($0): \(fields[$0]?.compactText ?? "")" }.joined(separator: ", ") + "}"
        }
    }
}
