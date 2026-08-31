import SwiftUI

struct ContentView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        if model.backend != nil {
            SessionListView()
        } else {
            PairingView()
        }
    }
}
