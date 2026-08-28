import Foundation
import Testing

@MainActor
struct TestIsolationTests {
    private enum BodyError: Error {
        case expected
    }

    @Test(arguments: [nil, "original"] as [String?], [false, true])
    func `environment snapshots restore absence and values after body completion`(
        originalValue: String?,
        throwingBody: Bool) async throws
    {
        let key = "OPENCLAW_TEST_ISOLATION_\(UUID().uuidString)"
        try #require(getenv(key) == nil)
        // Clean up even when the helper fails to restore this test-owned canary.
        defer { unsetenv(key) }
        if let originalValue {
            try #require(setenv(key, originalValue, 1) == 0)
        }

        var bodyRan = false
        do {
            let result = try await TestIsolation.withEnvValues([key: "override"]) {
                bodyRan = true
                #expect(getenv(key).map { String(cString: $0) } == "override")
                if throwingBody { throw BodyError.expected }
                return "completed"
            }
            #expect(!throwingBody)
            #expect(result == "completed")
        } catch {
            #expect(throwingBody)
            #expect(error as? BodyError == .expected)
        }

        #expect(bodyRan)
        #expect(getenv(key).map { String(cString: $0) } == originalValue)
    }
}
