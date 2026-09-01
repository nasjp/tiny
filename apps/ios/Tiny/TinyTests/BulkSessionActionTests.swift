import XCTest
@testable import Tiny

final class BulkSessionActionTests: XCTestCase {
    private struct Boom: LocalizedError {
        let id: String
        var errorDescription: String? { "boom \(id)" }
    }
    private actor Calls {
        var ids: [String] = []
        func add(_ id: String) { ids.append(id) }
    }

    func testRunsEveryIdAndReportsNothingWhenAllSucceed() async {
        let calls = Calls()
        let failures = await BulkSessionAction.run(["a", "b", "c"]) { await calls.add($0) }
        XCTAssertEqual(failures, [])
        let seen = await calls.ids
        XCTAssertEqual(seen.sorted(), ["a", "b", "c"])
    }

    func testAFailureDoesNotStopTheOthersAndComesBackInListOrder() async {
        let calls = Calls()
        let failures = await BulkSessionAction.run(["a", "b", "c", "d"]) { id in
            await calls.add(id)
            if id == "c" || id == "a" { throw Boom(id: id) }
        }
        XCTAssertEqual(failures, [.init(id: "a", message: "boom a"), .init(id: "c", message: "boom c")])
        let seen = await calls.ids
        XCTAssertEqual(seen.sorted(), ["a", "b", "c", "d"])
    }

    func testFailureMessage() {
        let one = [BulkSessionAction.Failure(id: "a", message: "409 cannot archive a running session")]
        XCTAssertEqual(BulkSessionAction.failureMessage(verb: "archive", failures: one, total: 1),
                       "Couldn't archive the session.\n409 cannot archive a running session")
        let two = one + [BulkSessionAction.Failure(id: "b", message: "other")]
        XCTAssertEqual(BulkSessionAction.failureMessage(verb: "unarchive", failures: two, total: 5),
                       "Couldn't unarchive 2 of 5 sessions.\n409 cannot archive a running session")
        XCTAssertEqual(BulkSessionAction.failureMessage(verb: "archive", failures: [], total: 3), "")
    }

    func testButtonTitle() {
        XCTAssertEqual(BulkSessionAction.buttonTitle(verb: "Archive", count: 0), "Archive")
        XCTAssertEqual(BulkSessionAction.buttonTitle(verb: "Archive", count: 1), "Archive 1 Session")
        XCTAssertEqual(BulkSessionAction.buttonTitle(verb: "Unarchive", count: 12), "Unarchive 12 Sessions")
    }
}
