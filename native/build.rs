//! Links the pinned libghostty-vt static library that
//! `scripts/fetch-ghostty-vt.sh` puts in `vendor/ghostty-vt/`.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let root = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let dir = format!("{root}/../vendor/ghostty-vt");
    if !std::path::Path::new(&format!("{dir}/libghostty-vt.a")).exists() {
        panic!("libghostty-vt is missing: run `sh scripts/fetch-ghostty-vt.sh`");
    }
    println!("cargo:rerun-if-changed={dir}/libghostty-vt.a");
    println!("cargo:rustc-link-search=native={dir}");
    println!("cargo:rustc-link-lib=static=ghostty-vt");
    println!("cargo:rustc-link-lib=c++");
}
