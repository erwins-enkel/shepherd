// swift-tools-version: 6.1
import PackageDescription

let package = Package(
  name: "ShepherdKit",
  defaultLocalization: "en",
  platforms: [.macOS(.v15), .iOS(.v18)],
  products: [
    .library(name: "ShepherdKit", targets: ["ShepherdKit"]),
    .library(name: "ShepherdAppCore", targets: ["ShepherdAppCore"])
  ],
  dependencies: [
    .package(url: "https://github.com/apple/swift-openapi-generator", from: "1.13.1"),
    .package(url: "https://github.com/apple/swift-openapi-runtime", from: "1.12.1"),
    .package(url: "https://github.com/apple/swift-openapi-urlsession", from: "1.3.1"),
  ],
  targets: [
    .target(
      name: "ShepherdAppCore",
      dependencies: ["ShepherdKit"],
      // Copy the directory: Xcode compiles individually copied xcstrings and
      // would duplicate the generator's runtime Localizable.strings outputs.
      resources: [
        .copy("Resources/Catalog"),
        .process("Resources/en.lproj"),
        .process("Resources/de.lproj")
      ],
      swiftSettings: [.enableUpcomingFeature("ExistentialAny")]
    ),
    .testTarget(
      name: "ShepherdAppCoreTests",
      dependencies: ["ShepherdAppCore"],
      swiftSettings: [.enableUpcomingFeature("ExistentialAny")]
    ),
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
