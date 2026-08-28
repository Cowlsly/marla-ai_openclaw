import CryptoKit
import Darwin
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct ExecHostSocketCancellationTests {
    enum Cancellation: CaseIterable {
        case disconnect
        case serverStop
    }

    private static let socketTimeoutSeconds = 5

    private enum CommandEvent: Sendable {
        case ready
        case finished(ExecHostResponse)
    }

    @Test
    func `normal request half-close still receives native execution result`() async throws {
        try await self.withServer { server, root in
            let client = try self.connect(root)
            defer { close(client) }
            try self.send(command: ["/usr/bin/printf", "half-close-ok"], root: root, client: client)
            #expect(shutdown(client, SHUT_WR) == 0)
            let response = try await Task.detached {
                try self.readResponse(client)
            }.value
            #expect(response.ok)
            #expect(response.payload?.stdout == "half-close-ok")
            #expect(response.payload?.success == true)
            server.stop()
        }
    }

    @Test(arguments: Cancellation.allCases, [false, true])
    func `closed caller or server stops native command and its descendant`(
        _ cancellation: Cancellation, withTimeout: Bool) async throws
    {
        let (events, continuation) = AsyncStream<CommandEvent>.makeStream()
        defer { continuation.finish() }
        try await self.withServer(onExecFinished: { response in
            continuation.yield(.finished(response))
            continuation.finish()
        }) { server, root in
            var client = try self.connect(root)
            defer { if client >= 0 { close(client) } }
            let parentFile = root.appendingPathComponent("parent.pid")
            let childFile = root.appendingPathComponent("child.pid")
            let sentinel = root.appendingPathComponent("sentinel")
            let readyURL = root.appendingPathComponent("ready")
            let releaseURL = root.appendingPathComponent("release")
            let ready = try self.makeFIFO(readyURL)
            defer { try? ready.close() }
            let release = try self.makeFIFO(releaseURL)
            defer { try? release.close() }
            defer { TestProcessSupport.killLeakedProcesses(in: [parentFile, childFile]) }
            ready.readabilityHandler = { handle in
                handle.readabilityHandler = nil
                continuation.yield(.ready)
                continuation.finish()
            }
            defer { ready.readabilityHandler = nil }
            // Use the socket's existing watchdog, not a separate startup SLA across MainActor policy work.
            let watchdog = DispatchWorkItem { continuation.finish() }
            DispatchQueue.global().asyncAfter(
                deadline: .now() + .seconds(Self.socketTimeoutSeconds), execute: watchdog)
            defer { watchdog.cancel() }
            // Ready is published only after both PID writes and opening the child's release gate.
            let command = [
                "/bin/sh", "-c",
                """
                printf '%s' "$$" > '\(parentFile.path)'
                /bin/sh -c '
                  trap "" TERM
                  printf "%s" "$$" > "\(childFile.path)"
                  exec 3< "\(releaseURL.path)"
                  printf ready > "\(readyURL.path)"
                  IFS= read -r _ <&3 || exit 1
                  /usr/bin/touch "\(sentinel.path)"
                ' &
                wait
                """,
            ]
            do {
                try self.send(command: command, root: root, client: client, timeoutMs: withTimeout ? 10000 : nil)
                #expect(shutdown(client, SHUT_WR) == 0)
                var iterator = events.makeAsyncIterator()
                let event = try #require(
                    await iterator.next(),
                    "native command did not become ready before socket watchdog")
                watchdog.cancel()
                switch event {
                case .ready:
                    break
                case let .finished(response):
                    let reason = response.error?.reason ?? "none"
                    Issue.record("execution ended before readiness: ok=\(response.ok), reason=\(reason)")
                    throw POSIXError(.ECHILD)
                }
                let parent = try self.readPID(parentFile)
                let child = try self.readPID(childFile)
                switch cancellation {
                case .disconnect:
                    close(client)
                    client = -1
                case .serverStop:
                    server.stop()
                }
                #expect(await self.waitUntil { self.isGone(parent) && self.isGone(child) })
                // A surviving child must be released so broken cancellation exposes its side effect.
                try release.write(contentsOf: Data("go\n".utf8))
                await server.stop().value
                #expect(!FileManager.default.fileExists(atPath: sentinel.path))
            } catch {
                try? release.write(contentsOf: Data("go\n".utf8))
                await server.stop().value
                throw error
            }
        }
    }

    @Test
    func `cancelled native executor never starts a command`() async throws {
        let root = try self.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        try self.seed(root)
        let sentinel = root.appendingPathComponent("unexpected")
        let request = ExecHostRequest(command: ["/usr/bin/touch", sentinel.path], cwd: root.path)
        let response = await Task.detached {
            withUnsafeCurrentTask { $0?.cancel() }
            return await ExecApprovalsStore.withStateDirectory(root) {
                await ExecHostExecutor.handle(request)
            }
        }.value
        #expect(!response.ok)
        #expect(!FileManager.default.fileExists(atPath: sentinel.path))
    }

    private func withServer(
        onExecFinished: @escaping @Sendable (ExecHostResponse) -> Void = { _ in },
        _ body: (ExecApprovalsSocketServer, URL) async throws -> Void) async throws
    {
        let root = try self.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        try self.seed(root)
        let server = ExecApprovalsSocketServer(
            socketPath: root.appendingPathComponent("exec.sock").path,
            token: "test-token",
            onPrompt: { _ in .deny },
            onExec: { request in
                let response = await ExecApprovalsStore.withStateDirectory(root) {
                    await ExecHostExecutor.handle(request)
                }
                onExecFinished(response)
                return response
            },
            onUnexpectedStop: { _ in })
        do {
            try #require(await server.start())
            try await body(server, root)
        } catch {
            await server.stop().value
            throw error
        }
        await server.stop().value
    }

    private func makeFIFO(_ url: URL) throws -> FileHandle {
        try #require(mkfifo(url.path, 0o600) == 0)
        // Keep both ends open so setup and failure cleanup never block on a missing child.
        let fd = open(url.path, O_RDWR | O_NONBLOCK | O_CLOEXEC)
        try #require(fd >= 0)
        return FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    }

    private func makeRoot() throws -> URL {
        let root = URL(fileURLWithPath: "/tmp/oehc-\(UUID().uuidString.prefix(12))", isDirectory: true)
        try FileManager.default.createDirectory(
            at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        return root.resolvingSymlinksInPath()
    }

    private func seed(_ root: URL) throws {
        try ExecApprovalsSQLiteStore.write(
            ExecApprovalsFile(version: 1, defaults: nil, agents: [:]),
            stateDirectoryURL: root)
    }

    private func connect(_ root: URL) throws -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw POSIXError(.EIO) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let socketPath = root.appendingPathComponent("exec.sock").path
        socketPath.withCString { source in
            withUnsafeMutablePointer(to: &address.sun_path) {
                $0.withMemoryRebound(to: CChar.self, capacity: 104) { destination in
                    _ = strcpy(destination, source)
                }
            }
        }
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard result == 0 else {
            close(fd)
            throw POSIXError(.ECONNREFUSED)
        }
        var timeout = timeval(tv_sec: Self.socketTimeoutSeconds, tv_usec: 0)
        _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        return fd
    }

    private func send(command: [String], root: URL, client: Int32, timeoutMs: Int? = 10000) throws {
        let request = ExecHostRequest(command: command, cwd: root.path, timeoutMs: timeoutMs)
        let requestJSON = try #require(String(data: JSONEncoder().encode(request), encoding: .utf8))
        let nonce = UUID().uuidString
        let timestamp = Int(Date().timeIntervalSince1970 * 1000)
        let hmac = HMAC<SHA256>.authenticationCode(
            for: Data("\(nonce):\(timestamp):\(requestJSON)".utf8),
            using: SymmetricKey(data: Data("test-token".utf8)))
            .map { String(format: "%02x", $0) }.joined()
        let envelope: [String: Any] = [
            "type": "exec", "id": UUID().uuidString, "nonce": nonce,
            "ts": timestamp, "hmac": hmac, "requestJson": requestJSON,
        ]
        var bytes = try JSONSerialization.data(withJSONObject: envelope)
        bytes.append(0x0A)
        try FileHandle(fileDescriptor: client, closeOnDealloc: false).write(contentsOf: bytes)
    }

    private func readResponse(_ fd: Int32) throws -> ExecHostResponse {
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while !data.contains(0x0A) {
            let count = recv(fd, &buffer, buffer.count, 0)
            guard count > 0 else { throw POSIXError(.EIO) }
            data.append(contentsOf: buffer.prefix(count))
        }
        return try JSONDecoder().decode(ExecHostResponse.self, from: data)
    }

    private func readPID(_ url: URL) throws -> pid_t {
        try #require(pid_t(String(contentsOf: url, encoding: .utf8)))
    }

    private func isGone(_ pid: pid_t) -> Bool {
        errno = 0
        return kill(pid, 0) == -1 && errno == ESRCH
    }

    private func waitUntil(_ condition: () -> Bool) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(1)
        while ContinuousClock.now < deadline {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return condition()
    }
}
