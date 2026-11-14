use std::sync::Arc;
use std::time::Duration;

use ads_codex_app_server::{
    CodexAppServerClient, InitializeResponse, RequestId, RpcError, SpawnOptions,
};
use serde_json::{Value, json};
use tokio::io::{
    AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf, split,
};
use tokio::sync::Mutex;

struct ServerSide {
    reader: BufReader<ReadHalf<DuplexStream>>,
    writer: WriteHalf<DuplexStream>,
}

impl ServerSide {
    async fn read(&mut self) -> Value {
        let mut line = String::new();
        self.reader.read_line(&mut line).await.expect("server read");
        serde_json::from_str(line.trim()).expect("server JSON")
    }

    async fn write(&mut self, value: Value) {
        self.writer
            .write_all(format!("{value}\n").as_bytes())
            .await
            .expect("server write");
        self.writer.flush().await.expect("server flush");
    }

    async fn initialize(&mut self) {
        let request = self.read().await;
        assert_eq!(request["method"], "initialize");
        self.write(json!({
            "jsonrpc": "2.0",
            "id": request["id"],
            "result": {
                "userAgent": "fake-codex/1.0",
                "codexHome": "/tmp/codex-home",
                "platformFamily": "unix",
                "platformOs": "linux"
            }
        }))
        .await;
        let initialized = self.read().await;
        assert_eq!(initialized["method"], "initialized");
        assert!(initialized.get("params").is_none());
    }
}

fn pair() -> (CodexAppServerClient, ServerSide) {
    let (client_stream, server_stream) = tokio::io::duplex(1024 * 1024);
    let (client_reader, client_writer) = split(client_stream);
    let (server_reader, server_writer) = split(server_stream);
    (
        CodexAppServerClient::from_io(client_reader, client_writer),
        ServerSide {
            reader: BufReader::new(server_reader),
            writer: server_writer,
        },
    )
}

async fn start_pair(client: &CodexAppServerClient, server: &mut ServerSide) {
    let start_client = client.clone();
    let start_task = tokio::spawn(async move { start_client.start().await });
    server.initialize().await;
    start_task.await.expect("start task").expect("client start");
}

#[tokio::test]
async fn starts_with_initialize_and_initialized_notification() {
    let (client, mut server) = pair();
    let server_task = tokio::spawn(async move {
        server.initialize().await;
    });

    let response = client.start().await.expect("client start");
    assert_eq!(
        response,
        InitializeResponse {
            user_agent: "fake-codex/1.0".to_string(),
            codex_home: "/tmp/codex-home".to_string(),
            platform_family: "unix".to_string(),
            platform_os: "linux".to_string(),
        }
    );
    assert_eq!(client.start().await.expect("idempotent start"), response);
    server_task.await.expect("server task");
    client.close().await;
}

#[tokio::test]
async fn correlates_concurrent_request_ids_in_any_response_order() {
    let (client, mut server) = pair();
    start_pair(&client, &mut server).await;
    let first_task = tokio::spawn({
        let client = client.clone();
        async move { client.request("first", json!({}), None).await }
    });
    let second_task = tokio::spawn({
        let client = client.clone();
        async move { client.request("second", json!({}), None).await }
    });
    let first = server.read().await;
    let second = server.read().await;
    let (first, second) = if first["method"] == "first" {
        (first, second)
    } else {
        (second, first)
    };
    assert_eq!(first["method"], "first");
    assert_eq!(second["method"], "second");
    server
        .write(json!({"jsonrpc": "2.0", "id": second["id"], "result": {"value": "two"}}))
        .await;
    server
        .write(json!({"jsonrpc": "2.0", "id": first["id"], "result": {"value": "one"}}))
        .await;

    let first_result = first_task.await.expect("first task");
    let second_result = second_task.await.expect("second task");
    assert_eq!(first_result.expect("first result")["value"], "one");
    assert_eq!(second_result.expect("second result")["value"], "two");
    client.close().await;
}

#[tokio::test]
async fn dispatches_notifications_and_server_requests() {
    let (client, mut server) = pair();
    let observed = Arc::new(Mutex::new(Vec::new()));
    let notification_observed = Arc::clone(&observed);
    let delta_subscription = client
        .on_notification("item/agentMessage/delta", move |params, method| {
            notification_observed
                .try_lock()
                .expect("notification lock")
                .push((method, params));
        })
        .await;
    let request_subscription = client
        .on_server_request(
            "item/commandExecution/requestApproval",
            |params, method, id| async move {
                assert_eq!(method, "item/commandExecution/requestApproval");
                assert!(matches!(id, RequestId::String(_)));
                Ok(json!({
                    "decision": "decline",
                    "itemId": params["itemId"]
                }))
            },
            None,
        )
        .await;

    start_pair(&client, &mut server).await;
    server
        .write(json!({
            "jsonrpc": "2.0",
            "method": "item/agentMessage/delta",
            "params": {"delta": "hello"}
        }))
        .await;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    while observed.lock().await.is_empty() {
        assert!(tokio::time::Instant::now() < deadline);
        tokio::task::yield_now().await;
    }
    assert_eq!(observed.lock().await[0].0, "item/agentMessage/delta");
    assert_eq!(observed.lock().await[0].1["delta"], "hello");

    server
        .write(json!({
            "jsonrpc": "2.0",
            "id": "request-1",
            "method": "item/commandExecution/requestApproval",
            "params": {"itemId": "command-1"}
        }))
        .await;
    let approval = server.read().await;
    assert_eq!(approval["id"], "request-1");
    assert_eq!(approval["result"]["decision"], "decline");
    assert_eq!(approval["result"]["itemId"], "command-1");

    server
        .write(json!({
            "jsonrpc": "2.0",
            "id": "request-unsupported",
            "method": "item/unknown",
            "params": {}
        }))
        .await;
    let unsupported = server.read().await;
    assert_eq!(unsupported["id"], "request-unsupported");
    assert_eq!(unsupported["error"]["code"], -32601);
    assert!(
        unsupported["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("Unsupported server request"))
    );

    client
        .off_notification("item/agentMessage/delta", &delta_subscription)
        .await;
    client
        .off_server_request(
            "item/commandExecution/requestApproval",
            &request_subscription,
        )
        .await;
    client.close().await;
}

#[tokio::test]
async fn reports_remote_timeout_and_closed_errors() {
    let (client, mut server) = pair();
    start_pair(&client, &mut server).await;

    let remote_task = tokio::spawn({
        let client = client.clone();
        async move { client.request("remote", json!({}), None).await }
    });
    let remote_request = server.read().await;
    server
        .write(json!({
            "jsonrpc": "2.0",
            "id": remote_request["id"],
            "error": {"code": -32000, "message": "remote failed"}
        }))
        .await;
    let remote = remote_task
        .await
        .expect("remote task")
        .expect_err("remote error");
    assert!(matches!(
        remote,
        RpcError::Remote {
            code: -32000,
            ref message,
            ..
        } if message == "remote failed"
    ));

    let timeout_task = tokio::spawn({
        let client = client.clone();
        async move {
            client
                .request("timeout", json!({}), Some(Duration::from_millis(20)))
                .await
        }
    });
    let timeout_request = server.read().await;
    assert_eq!(timeout_request["method"], "timeout");
    let timeout = timeout_task
        .await
        .expect("timeout task")
        .expect_err("timeout error");
    assert!(matches!(timeout, RpcError::Timeout { .. }));

    let pending_task = tokio::spawn({
        let client = client.clone();
        async move { client.request("pending", json!({}), None).await }
    });
    let pending_request = server.read().await;
    assert_eq!(pending_request["method"], "pending");
    client.close().await;
    let closed = pending_task
        .await
        .expect("pending task")
        .expect_err("closed error");
    assert!(matches!(closed, RpcError::Closed { graceful: true, .. }));
}

#[tokio::test]
async fn spawns_the_configured_binary_with_args_cwd_and_environment() {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("temp dir");
        let script = directory.path().join("fake-codex");
        std::fs::write(
            &script,
            concat!(
                "#!/bin/sh\n",
                "printf '%s\\n' \"$@\" > \"$ADS_APP_SERVER_TEST_DIR/args.txt\"\n",
                "pwd > \"$ADS_APP_SERVER_TEST_DIR/cwd.txt\"\n",
                "printf '%s\\n' \"$ADS_APP_SERVER_TEST_ENV\" > \"$ADS_APP_SERVER_TEST_DIR/env.txt\"\n",
                "IFS= read -r initialize\n",
                "printf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"userAgent\":\"spawned\",\"codexHome\":\"/tmp/codex-home\",\"platformFamily\":\"unix\",\"platformOs\":\"linux\"}}'\n",
                "cat >/dev/null\n",
            ),
        )
        .expect("write fake binary");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
            .expect("executable fake binary");

        let mut env = std::collections::HashMap::new();
        env.insert(
            "ADS_APP_SERVER_TEST_DIR".to_string(),
            directory.path().to_string_lossy().to_string(),
        );
        env.insert("ADS_APP_SERVER_TEST_ENV".to_string(), "present".to_string());
        let client = CodexAppServerClient::spawn(SpawnOptions {
            binary: script.to_string_lossy().to_string(),
            global_args: vec!["global-one".to_string()],
            app_server_args: vec!["server-one".to_string()],
            cwd: Some(directory.path().to_path_buf()),
            env,
            request_timeout: Duration::from_secs(5),
        })
        .await
        .expect("spawn fake app-server");
        assert_eq!(
            client.start().await.expect("spawned start").user_agent,
            "spawned"
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("args.txt")).expect("args"),
            "global-one\napp-server\nserver-one\n"
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("cwd.txt"))
                .expect("cwd")
                .trim(),
            directory.path().to_string_lossy()
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("env.txt"))
                .expect("env")
                .trim(),
            "present"
        );

        client.close().await;
        assert!(client.is_closed());
        assert!(client.is_gracefully_closed());
    }
}
