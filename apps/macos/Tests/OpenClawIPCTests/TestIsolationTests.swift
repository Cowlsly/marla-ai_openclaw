import Foundation
import Testing

struct TestIsolationTests {
    private enum BodyFailure: Error {
        case expected
    }

    @Test(arguments: [
        (initial: nil, temporary: "temporary"),
        (initial: nil, temporary: nil),
        (initial: "", temporary: "temporary"),
        (initial: "", temporary: nil),
        (initial: " original \t\n", temporary: "temporary"),
        (initial: " original \t\n", temporary: nil),
    ] as [(initial: String?, temporary: String?)], [false, true])
    @MainActor
    func `environment values restore exactly after completion or throw`(
        _ values: (initial: String?, temporary: String?),
        shouldThrow: Bool) async
    {
        let key = "OPENCLAW_TEST_ISOLATION_\(UUID().uuidString.replacingOccurrences(of: "-", with: "_"))"
        await TestIsolationLock.shared.acquire()
        #expect(getenv(key) == nil)
        if let initial = values.initial {
            setenv(key, initial, 1)
        }
        await TestIsolationLock.shared.release()

        var didThrow = false
        do {
            try await TestIsolation.withEnvValues([key: values.temporary]) {
                #expect(getenv(key).map { String(cString: $0) } == values.temporary)
                if shouldThrow {
                    throw BodyFailure.expected
                }
            }
        } catch {
            didThrow = true
            #expect(error is BodyFailure)
        }
        #expect(didThrow == shouldThrow)

        await TestIsolationLock.shared.acquire()
        #expect(getenv(key).map { String(cString: $0) } == values.initial)
        unsetenv(key)
        await TestIsolationLock.shared.release()
    }
}
