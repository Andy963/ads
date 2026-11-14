use std::path::PathBuf;

use ads_reviewer::extract_related_contexts;

#[tokio::main]
async fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 3 {
        eprintln!("usage: extract-context <repo> <base> <head>");
        std::process::exit(2);
    }
    let result = extract_related_contexts(&PathBuf::from(&args[0]), &args[1], &args[2]).await;
    println!(
        "{}",
        serde_json::to_string(&result).expect("context extraction json")
    );
}
