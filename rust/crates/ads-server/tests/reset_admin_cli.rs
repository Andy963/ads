use std::process::{Command, Stdio};

fn run_cli(state_dir: &std::path::Path, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_ads-server"))
        .args(args)
        .env("ADS_STATE_DIR", state_dir)
        .stdin(Stdio::null())
        .output()
        .expect("run ads-server")
}

#[test]
fn reset_admin_cli_creates_then_updates_the_primary_user() {
    let directory = tempfile::tempdir().expect("temp dir");
    let created = run_cli(
        directory.path(),
        &["reset-admin", "--username", "admin", "--password", "secret"],
    );
    assert_eq!(created.status.code(), Some(0));
    let created_stdout = String::from_utf8_lossy(&created.stdout);
    assert!(created_stdout.starts_with("OK (created user=admin id="));

    let updated = run_cli(
        directory.path(),
        &[
            "reset-admin",
            "--username",
            "admin....",
            "--password",
            "new-secret",
        ],
    );
    assert_eq!(updated.status.code(), Some(0));
    let updated_stdout = String::from_utf8_lossy(&updated.stdout);
    assert!(updated_stdout.starts_with("OK (updated user=admin id="));
    assert!(updated_stdout.contains(" prev=admin"));
}

#[test]
fn reset_admin_cli_reads_the_password_from_stdin() {
    let directory = tempfile::tempdir().expect("temp dir");
    let mut child = Command::new(env!("CARGO_BIN_EXE_ads-server"))
        .args([
            "reset-admin",
            "--username",
            "stdin-admin",
            "--password-stdin",
        ])
        .env("ADS_STATE_DIR", directory.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn ads-server");
    {
        use std::io::Write;
        child
            .stdin
            .as_mut()
            .expect("stdin")
            .write_all(b"stdin-secret\r\n\n")
            .expect("write password");
    }
    let output = child.wait_with_output().expect("wait for ads-server");
    assert_eq!(output.status.code(), Some(0));
    assert!(
        String::from_utf8_lossy(&output.stdout).starts_with("OK (created user=stdin-admin id=")
    );
}
