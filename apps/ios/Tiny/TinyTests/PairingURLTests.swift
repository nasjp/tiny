import XCTest
@testable import Tiny

/// Destination guard for the pairing QR. Front-door validation so the bearer is never sent to an attacker URL
final class PairingURLTests: XCTestCase {
    private func ok(_ s: String) -> Bool {
        guard let u = URL(string: s) else { return false }
        return AppModel.isAcceptablePairingURL(u)
    }

    func testAcceptsLocalAndTailscaleHosts() {
        XCTAssertTrue(ok("http://100.100.100.100:7777"))  // Tailscale CGNAT (synthetic value)
        XCTAssertTrue(ok("http://192.168.1.10:7777"))     // LAN
        XCTAssertTrue(ok("http://10.0.0.5:7777"))
        XCTAssertTrue(ok("http://172.16.0.9:7777"))
        XCTAssertTrue(ok("http://mac.local:7777"))        // mDNS
        XCTAssertTrue(ok("https://mymac.tailnet.ts.net")) // MagicDNS
        XCTAssertTrue(ok("http://127.0.0.1:7777"))        // simulator
    }

    func testRejectsExternalAndBogusHosts() {
        XCTAssertFalse(ok("https://evil.example.com"))    // external host
        XCTAssertFalse(ok("http://8.8.8.8:7777"))         // global IP
        XCTAssertFalse(ok("http://172.32.0.1:7777"))      // outside 172.16/12
        XCTAssertFalse(ok("ftp://192.168.1.10"))          // scheme violation
        XCTAssertFalse(ok("javascript:alert(1)"))         // scheme violation
        XCTAssertFalse(ok("http://100.128.0.1"))          // outside 100.64/10
    }
}
