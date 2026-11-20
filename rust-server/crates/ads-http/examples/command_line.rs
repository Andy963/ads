use std::io::{self, BufRead};
use std::path::PathBuf;

use serde_json::json;

fn main() {
    let workspace_root = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let Ok(command) = line else {
            break;
        };
        if command.trim().is_empty() {
            continue;
        }
        let result = ads_http::run_ads_command_line(&command, &workspace_root);
        let record = json!({ "ok": result.ok, "output": result.output });
        println!("{record}");
    }
}
