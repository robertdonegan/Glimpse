fn main() {
    // Compile the ScreenCaptureKit sidecar (macOS). Failure is non-fatal —
    // the app falls back to `screencapture` (which bakes the cursor).
    #[cfg(target_os = "macos")]
    {
        let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        let profile = std::env::var("PROFILE").unwrap();
        let arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_else(|_| "aarch64".into());
        let target = if arch == "aarch64" {
            "arm64-apple-macos13.0"
        } else {
            "x86_64-apple-macos13.0"
        };
        let src = format!("{manifest}/sidecar/glimpse-capture.swift");
        let out_dir = format!("{manifest}/target/{profile}");
        let out = format!("{out_dir}/glimpse-capture");
        let stale = match (std::fs::metadata(&src), std::fs::metadata(&out)) {
            (Ok(s), Ok(o)) => match (s.modified(), o.modified()) {
                (Ok(sm), Ok(om)) => sm > om,
                _ => true,
            },
            _ => true,
        };
        if stale {
            std::fs::create_dir_all(&out_dir).ok();
            let status = std::process::Command::new("swiftc")
                .args(["-O", "-target", target, &src, "-o", &out])
                .status();
            if !matches!(status, Ok(s) if s.success()) {
                println!(
                    "cargo:warning=sidecar build failed — native capture will fall back to screencapture (cursor baked in)"
                );
            }
        }
        println!("cargo:rerun-if-changed=sidecar/glimpse-capture.swift");
    }
    tauri_build::build()
}
