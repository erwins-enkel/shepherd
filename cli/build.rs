//! Generates the Shepherd API client from the derived contract (contracts/openapi.rust.yaml,
//! produced by scripts/gen-contract-rust.ts). Nothing about the server is hand-typed here.

use std::{env, fs, path::Path};

const SPEC: &str = "../contracts/openapi.rust.yaml";

fn main() {
    println!("cargo:rerun-if-changed={SPEC}");
    let file = fs::File::open(SPEC).expect("open contracts/openapi.rust.yaml");
    let spec: openapiv3::OpenAPI =
        serde_norway::from_reader(file).expect("parse openapi.rust.yaml");
    let mut settings = progenitor::GenerationSettings::default();
    settings.with_interface(progenitor::InterfaceStyle::Builder);
    let mut generator = progenitor::Generator::new(&settings);
    let tokens = generator.generate_tokens(&spec).expect("generate client");
    let ast = syn::parse2(tokens).expect("parse generated client");
    let out = Path::new(&env::var("OUT_DIR").unwrap()).join("codegen.rs");
    fs::write(out, prettyplease::unparse(&ast)).expect("write generated client");
}
