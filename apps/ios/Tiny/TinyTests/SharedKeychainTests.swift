import XCTest
@testable import Tiny

final class SharedKeychainTests: XCTestCase {
    override func setUp() { SharedKeychain.wipe() }
    override func tearDown() { SharedKeychain.wipe() }

    func testSetGetDelete() {
        XCTAssertNil(SharedKeychain.get(.bearerToken))
        SharedKeychain.set("tok1", for: .bearerToken)
        XCTAssertEqual(SharedKeychain.get(.bearerToken), "tok1")
        SharedKeychain.set("tok2", for: .bearerToken)   // overwrite
        XCTAssertEqual(SharedKeychain.get(.bearerToken), "tok2")
        SharedKeychain.delete(.bearerToken)
        XCTAssertNil(SharedKeychain.get(.bearerToken))
    }

    func testWipeClearsAllKeys() {
        SharedKeychain.set("u", for: .serverURL)
        SharedKeychain.set("t", for: .bearerToken)
        SharedKeychain.set("k", for: .e2eKey)
        SharedKeychain.set("d", for: .deviceId)
        SharedKeychain.wipe()
        XCTAssertNil(SharedKeychain.get(.serverURL))
        XCTAssertNil(SharedKeychain.get(.bearerToken))
        XCTAssertNil(SharedKeychain.get(.e2eKey))
        XCTAssertNil(SharedKeychain.get(.deviceId))
    }
}
