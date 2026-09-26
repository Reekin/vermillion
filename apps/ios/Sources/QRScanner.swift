import SwiftUI
import AVFoundation

struct QRScanner: UIViewControllerRepresentable {
    let complete: (Result<URL, Error>) -> Void
    func makeUIViewController(context: Context) -> ScannerController { ScannerController(complete: complete) }
    func updateUIViewController(_ controller: ScannerController, context: Context) {}
    static func dismantleUIViewController(_ controller: ScannerController, coordinator: ()) { controller.stop() }
}

final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let capture = AVCaptureSession()
    private let queue = DispatchQueue(label: "app.vermillion.qr")
    private var preview: AVCaptureVideoPreviewLayer?
    private var finished = false
    private let complete: (Result<URL, Error>) -> Void
    init(complete: @escaping (Result<URL, Error>) -> Void) { self.complete = complete; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func viewDidLoad() {
        super.viewDidLoad()
        AVCaptureDevice.requestAccess(for: .video) { granted in
            DispatchQueue.main.async {
                guard granted, let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device),
                      self.capture.canAddInput(input) else {
                    self.complete(.failure(NSError(domain: "Camera", code: 1, userInfo: [NSLocalizedDescriptionKey: "相机不可用，请在系统设置中允许访问，或手动配对。"])))
                    return
                }
                self.capture.addInput(input)
                let output = AVCaptureMetadataOutput()
                guard self.capture.canAddOutput(output) else { return }
                self.capture.addOutput(output); output.setMetadataObjectsDelegate(self, queue: .main); output.metadataObjectTypes = [.qr]
                let preview = AVCaptureVideoPreviewLayer(session: self.capture)
                preview.videoGravity = .resizeAspectFill; preview.frame = self.view.bounds
                self.view.layer.addSublayer(preview); self.preview = preview
                self.queue.async { self.capture.startRunning() }
            }
        }
    }
    override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); preview?.frame = view.bounds }
    func stop() { queue.async { self.capture.stopRunning() } }
    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !finished, let value = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue,
              let url = URL(string: value) else { return }
        finished = true; stop(); complete(.success(url))
    }
}
