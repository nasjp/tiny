// Check that a blob sealed by Node's sealForDevice can be decrypted with Apple CryptoKit.
// Proof that the Phase 3 Notification Service Extension is viable.
// Usage: swift scripts/cryptokit-check.swift <keyBase64> <combinedBase64>
import CryptoKit
import Foundation

let args = CommandLine.arguments
guard args.count == 3,
      let keyData = Data(base64Encoded: args[1]),
      let combined = Data(base64Encoded: args[2]) else {
  FileHandle.standardError.write("usage: cryptokit-check.swift <keyBase64> <combinedBase64>\n".data(using: .utf8)!)
  exit(2)
}
do {
  let box = try ChaChaPoly.SealedBox(combined: combined)
  let opened = try ChaChaPoly.open(box, using: SymmetricKey(data: keyData))
  print(String(data: opened, encoding: .utf8) ?? "<non-utf8>")
} catch {
  FileHandle.standardError.write("decrypt failed: \(error)\n".data(using: .utf8)!)
  exit(1)
}
