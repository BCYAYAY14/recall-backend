// Generates fixtures/isnewer.json from Recall's OWN ISODate.swift, so the
// verdicts are Swift's by construction and the TypeScript side must match them.
//
//   swiftc -o /tmp/gen-isnewer <Recall>/Sources/Core/ISODate.swift tools/fixtures/gen-isnewer.swift
//   /tmp/gen-isnewer > fixtures/isnewer.json
//
// (The file is compiled as the program's main file, so swiftc is given it
// under the name main.swift by tools/fixtures/gen-isnewer.sh.)
import Foundation

var state: UInt64 = 0x5EED_2026_0916
func next() -> UInt64 {
    state = state &* 6364136223846793005 &+ 1442695040888963407
    return state >> 11
}
func wire(_ ms: Int64) -> String {
    ISODate.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
}

var pairs: [(String, String)] = []
let anchors: [Int64] = [0, 1, 999, 1000, 946_684_799_999, 946_684_800_000,
                        1_788_321_563_554, 1_787_728_345_399, 1_789_000_000_000,
                        4_102_444_799_999]
for a in anchors {
    pairs.append((wire(a), wire(a)))
    pairs.append((wire(a + 1), wire(a)))
    pairs.append((wire(a), wire(a + 1)))
    pairs.append((wire(a + 1000), wire(a)))
}
while pairs.count < 240 {
    let base = Int64(next() % 4_102_444_800_000)
    let kind = next() % 4
    let delta: Int64
    switch kind {
    case 0: delta = 0
    case 1: delta = Int64(next() % 3) - 1
    case 2: delta = Int64(next() % 2000) - 1000
    default: delta = Int64(next() % 86_400_000) - 43_200_000
    }
    let b = max(0, base + delta)
    pairs.append((wire(base), wire(b)))
}

// Every string the protocol accepts is exactly YYYY-MM-DDTHH:MM:SS.sssZ.
let pattern = try! NSRegularExpression(pattern: #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$"#)
func valid(_ s: String) -> Bool {
    pattern.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
}

var out = "{\n  \"about\": \"ISODate.isNewer verdicts generated from Recall's ISODate.swift. a_newer_than_b is isNewer(a, than: b). Both suites must reproduce every verdict.\",\n  \"pairs\": [\n"
for (i, p) in pairs.enumerated() {
    precondition(valid(p.0) && valid(p.1), "non-wire string \(p)")
    let da = ISODate.date(fromISO: p.0)!, db = ISODate.date(fromISO: p.1)!
    let v = ISODate.isNewer(da, than: db)
    out += "    {\"a\": \"\(p.0)\", \"b\": \"\(p.1)\", \"a_newer_than_b\": \(v)}"
    out += i == pairs.count - 1 ? "\n" : ",\n"
}
out += "  ],\n  \"rejected_on_the_wire\": [\n"
let bad = ["2026-09-16T11:02:14Z", "2026-09-16T11:02:14.31Z", "2026-09-16T11:02:14.3185Z",
           "2026-09-16T13:02:14.318+02:00", "2026-09-16 11:02:14.318", "2026-09-16T11:02:14.318z",
           "", "2026-13-16T11:02:14.318Z", "2026-02-30T11:02:14.318Z", "2026-09-16T24:00:00.000Z",
           "1787728345399", "2026-09-16T11:60:14.318Z"]
for (i, s) in bad.enumerated() {
    out += "    \"\(s)\"" + (i == bad.count - 1 ? "\n" : ",\n")
}
out += "  ]\n}\n"
print(out, terminator: "")
