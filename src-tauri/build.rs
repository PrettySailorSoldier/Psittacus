use std::path::PathBuf;

fn main() {
    tauri_build::build();

    // -----------------------------------------------------------------------
    // Sidecar triple-suffix copies
    // -----------------------------------------------------------------------
    // `tauri-plugin-shell` resolves sidecar binaries by appending the target
    // triple to the sidecar name, e.g. `ffmpeg-x86_64-pc-windows-msvc.exe`,
    // and looks for that file next to the running executable.
    //
    // The Tauri CLI copies the source binaries into `target/debug/` *after*
    // `cargo build` finishes, and strips the triple when it does so (producing
    // just `ffmpeg.exe`).  Because our build.rs runs *during* cargo build, the
    // stripped copy isn't there yet and we cannot rely on it.
    //
    // Instead, we copy directly from `src-tauri/` — where the files already
    // carry the full triple-suffix name — into the profile output dir with
    // that same name.  `CARGO_MANIFEST_DIR` always points at `src-tauri/` and
    // is set before build.rs runs, so the source is always available.
    // -----------------------------------------------------------------------
    let triple = std::env::var("TARGET").unwrap_or_default();

    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let binaries_dir = manifest_dir;

    // OUT_DIR is `target/debug/build/psittacus-<hash>/out`.
    // Walk up 3 levels to reach `target/debug/`.
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let profile_dir = out_dir
        .ancestors()
        .nth(3)
        .expect("unexpected OUT_DIR depth")
        .to_path_buf();

    let ext = if cfg!(windows) { ".exe" } else { "" };

    for name in &["ffmpeg", "ffprobe", "tesseract"] {
        let src = binaries_dir.join(format!("{name}-{triple}{ext}"));
        let dst = profile_dir.join(format!("{name}-{triple}{ext}"));
        if src.exists() {
            println!("cargo:rerun-if-changed={}", src.display());
            if let Err(e) = std::fs::copy(&src, &dst) {
                println!("cargo:warning=Could not copy {name} sidecar: {e}");
            }
        }
    }
}


