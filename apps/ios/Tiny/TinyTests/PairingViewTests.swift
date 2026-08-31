import XCTest
@testable import Tiny

final class PairingViewTests: XCTestCase {
    func testNormalizeCodeFixesCommonMisreads() {
        // Correction premised on the code alphabet excluding I/O/0/1
        XCTAssertEqual(PairingView.normalizeCode(" k7mpq2xa "), "K7MPQ2XA")
        XCTAssertEqual(PairingView.normalizeCode("K0MPQ21A"), "KOMPQ2IA")
    }
}
