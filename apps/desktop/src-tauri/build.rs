// SPDX-License-Identifier: Apache-2.0

fn main() {
    println!("cargo:rerun-if-env-changed=CIALAI_SKIP_WINDOWS_RESOURCES");
    let target = std::env::var("TARGET").unwrap_or_default();
    let cross_check =
        std::env::var_os("CIALAI_SKIP_WINDOWS_RESOURCES").is_some() && target.contains("windows");
    if cross_check {
        println!("cargo:rustc-env=TAURI_ENV_TARGET_TRIPLE={target}");
        return;
    }
    tauri_build::build();
}
