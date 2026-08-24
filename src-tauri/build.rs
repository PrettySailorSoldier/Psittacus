use std::path::PathBuf;

fn main() {
    tauri_build::build();

    // -----------------------------------------------------------------------
    // Sidecar triple-suffix copies
    // -----------------------------------------------------------------------
    // `tauri-plugin-shell` resolves sidecar binaries by looking for
    //   <out_dir>/<name>-<target-triple>[.exe]
    // next to the compiled executable.  During `tauri dev` (i.e. a plain
    // `cargo build`), Tauri copies `binaries/ffmpeg-<triple>.exe` into
    // `target/debug/` but strips the triple, producing `ffmpeg.exe`.
    // The plugin then can't find it and returns OS error 3 ("path not found").
    //
    // Fix: after every build we copy/overwrite the triple-free names back to
    // triple-suffixed names inside `OUT_DIR`'s parent (= `target/{profile}/`).
    // -----------------------------------------------------------------------
    let triple = std::env::var("CARGO_CFG_TARGET_ARCH")
        .ok()
        .and_then(|arch| {
            let os = std::env::var("CARGO_CFG_TARGET_OS").ok()?;
            let env = std::env::var("CARGO_CFG_TARGET_ENV").ok()?;
            Some(format!("{arch}-pc-{os}-{env}"))
        })
        .unwrap_or_else(|| std::env::var("TARGET").unwrap_or_default());

    // OUT_DIR is something like `target/debug/build/psittacus-<hash>/out`.
    // We want `target/debug/` itself.
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    // Walk up: out → <hash>/out parent → build parent → debug
    let profile_dir = out_dir
        .ancestors()
        .nth(3)
        .expect("unexpected OUT_DIR depth")
        .to_path_buf();

    let ext = if cfg!(windows) { ".exe" } else { "" };

    for name in &["ffmpeg", "ffprobe", "tesseract"] {
        let src = profile_dir.join(format!("{name}{ext}"));
        let dst = profile_dir.join(format!("{name}-{triple}{ext}"));
        if src.exists() && src != dst {
            if let Err(e) = std::fs::copy(&src, &dst) {
                // Non-fatal: warn but don't break the build.
                println!("cargo:warning=Could not copy {name} sidecar: {e}");
            }
        }
    }
}

