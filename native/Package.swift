// swift-tools-version: 6.1
import PackageDescription

let package = Package(
  name: "ShepherdKit",
  platforms: [.macOS(.v15), .iOS(.v18)],
  products: [
    .library(name: "ShepherdKit", targets: ["ShepherdKit"])
  ],
  dependencies: [
    .package(url: "https://github.com/apple/swift-openapi-generator", from: "1.13.1"),
    .package(url: "https://github.com/apple/swift-openapi-runtime", from: "1.12.1"),
    .package(url: "https://github.com/apple/swift-openapi-urlsession", from: "1.3.1"),
  ],
  targets: [
    .target(
      name: "ShepherdKit",
      dependencies: [
        .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
        .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
      ],
      plugins: [
        .plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator")
      ]
    ),
    .testTarget(
      name: "ShepherdKitTests",
      dependencies: ["ShepherdKit"]
    ),
  ],
  swiftLanguageModes: [.v6]
)
