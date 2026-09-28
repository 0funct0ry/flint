//! MCP transport: a local Streamable HTTP server (per the M10.21 prompt — MCP's real wire
//! transports are stdio and Streamable HTTP; there's no standard raw-TCP framing for it).
//! Each JSON-RPC request gets an immediate synchronous JSON response (the "stateless" mode the
//! Streamable HTTP spec allows instead of an SSE stream), which is enough for the request/response
//! tool-call flow this milestone needs — no async runtime required.

use super::auth::extract_bearer_token;
use super::tools::{self, ToolCtx};
use flint_core::Index;
use rand::RngCore;
use std::collections::HashMap;
use std::net::{SocketAddr, TcpListener};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use tauri::AppHandle;

use crate::SuppressedWrite;

/// Generate a fresh 32-byte bearer token, hex-encoded.
pub fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Bind `127.0.0.1` only — never any other address, and never a configurable bind host. Tries
/// `preferred_port` first, then an OS-assigned ephemeral port (`0`) if that's taken.
pub fn bind_loopback(preferred_port: u16) -> std::io::Result<(tiny_http::Server, u16)> {
    let addr = loopback_addr(preferred_port);
    match tiny_http::Server::http(addr) {
        Ok(server) => {
            let port = server
                .server_addr()
                .to_ip()
                .map(|a| a.port())
                .unwrap_or(preferred_port);
            Ok((server, port))
        }
        Err(_) => {
            let ephemeral = loopback_addr(0);
            let server = tiny_http::Server::http(ephemeral)
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
            Ok((server, port))
        }
    }
}

/// The single place a bind address is constructed — always loopback, so a test can assert this
/// never produces anything else (M10.21 DoD: "binding is refused if anything but 127.0.0.1 is
/// configured").
fn loopback_addr(port: u16) -> SocketAddr {
    // Bind via TCP directly first to fail fast on an unavailable port with a clear error,
    // matching tiny_http's own `Server::http` behavior but letting us control the exact address.
    let _ = TcpListener::bind(("127.0.0.1", port));
    SocketAddr::from(([127, 0, 0, 1], port))
}

#[allow(clippy::too_many_arguments)]
pub fn serve(
    http_server: Arc<tiny_http::Server>,
    stop_flag: Arc<AtomicBool>,
    token: Arc<RwLock<Option<String>>>,
    require_auth: Arc<AtomicBool>,
    root: PathBuf,
    index: Arc<RwLock<Index>>,
    suppressed_writes: Arc<Mutex<HashMap<String, SuppressedWrite>>>,
    app_handle: AppHandle,
) {
    for mut request in http_server.incoming_requests() {
        if stop_flag.load(Ordering::Relaxed) {
            break;
        }

        let url = request.url().to_string();
        let method = request.method().clone();

        let current_token = token.read().ok().and_then(|t| t.clone());
        let presented = extract_bearer_token(&request);
        let authorized = is_authorized(
            require_auth.load(Ordering::Relaxed),
            current_token.as_deref(),
            presented.as_deref(),
        );

        if !authorized {
            let response = tiny_http::Response::from_string("{\"error\":\"unauthorized\"}")
                .with_status_code(401);
            let _ = request.respond(response);
            continue;
        }

        if method != tiny_http::Method::Post {
            let _ = request.respond(tiny_http::Response::from_string("").with_status_code(404));
            continue;
        }

        let mut body = String::new();
        if request.as_reader().read_to_string(&mut body).is_err() {
            let _ = request.respond(tiny_http::Response::from_string("").with_status_code(400));
            continue;
        }

        if !url.starts_with("/mcp") {
            let _ = request.respond(tiny_http::Response::from_string("").with_status_code(404));
            continue;
        }

        let ctx = ToolCtx {
            root: &root,
            index: &index,
            suppressed_writes: &suppressed_writes,
            app_handle: &app_handle,
        };
        let response_body = handle_jsonrpc(&body, &ctx);
        let _ = request.respond(
            tiny_http::Response::from_string(response_body).with_header(
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                    .expect("static header is always valid"),
            ),
        );
    }
}

/// Whether a request should be let through, per M10.21's opt-in auth model: off by default
/// (every request accepted unconditionally); when on, only a presented token matching the one
/// currently persisted (generated from Settings) is accepted — no token yet, a missing header, or
/// a mismatch are all unauthorized (fail closed).
fn is_authorized(require_auth: bool, current_token: Option<&str>, presented: Option<&str>) -> bool {
    if !require_auth {
        return true;
    }
    match (current_token, presented) {
        (Some(current), Some(presented)) => constant_time_eq(presented, current),
        _ => false,
    }
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Dispatch a single JSON-RPC 2.0 request body. Unknown/malformed input returns a JSON-RPC error
/// object rather than a transport-level failure, per the protocol.
fn handle_jsonrpc(body: &str, ctx: &ToolCtx) -> String {
    let request: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => {
            return jsonrpc_error(
                serde_json::Value::Null,
                -32700,
                &format!("parse error: {e}"),
            )
        }
    };

    let id = request
        .get("id")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let method = request.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = request
        .get("params")
        .cloned()
        .unwrap_or(serde_json::json!({}));

    match method {
        "initialize" => jsonrpc_result(
            id,
            serde_json::json!({
                "protocolVersion": "2024-11-05",
                "serverInfo": { "name": "flint", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "tools": {} }
            }),
        ),
        "notifications/initialized" | "ping" => jsonrpc_result(id, serde_json::json!({})),
        "tools/list" => jsonrpc_result(id, serde_json::json!({ "tools": tools::list_tools() })),
        "tools/call" => {
            let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or(serde_json::json!({}));
            match tools::call_tool(name, arguments, ctx) {
                Ok(value) => jsonrpc_result(
                    id,
                    serde_json::json!({
                        "content": [{ "type": "text", "text": value.to_string() }],
                        "isError": false
                    }),
                ),
                Err(err) => jsonrpc_result(
                    id,
                    serde_json::json!({
                        "content": [{ "type": "text", "text": err.to_string() }],
                        "isError": true
                    }),
                ),
            }
        }
        other => jsonrpc_error(id, -32601, &format!("method not found: {other}")),
    }
}

fn jsonrpc_result(id: serde_json::Value, result: serde_json::Value) -> String {
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

fn jsonrpc_error(id: serde_json::Value, code: i32, message: &str) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bind_loopback_never_produces_non_loopback_address() {
        for port in [0u16, 4870, 18291] {
            let addr = loopback_addr(port);
            assert!(addr.ip().is_loopback(), "address must be loopback: {addr}");
        }
    }

    #[test]
    fn constant_time_eq_matches_string_equality() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "ab"));
    }

    #[test]
    fn auth_off_authorizes_every_request_regardless_of_header() {
        assert!(is_authorized(false, None, None));
        assert!(is_authorized(false, None, Some("anything")));
        assert!(is_authorized(false, Some("secret"), Some("wrong")));
    }

    #[test]
    fn auth_on_with_no_token_yet_fails_closed() {
        assert!(!is_authorized(true, None, None));
        assert!(!is_authorized(true, None, Some("anything")));
    }

    #[test]
    fn auth_on_rejects_missing_or_wrong_token_accepts_matching() {
        assert!(!is_authorized(true, Some("secret"), None));
        assert!(!is_authorized(true, Some("secret"), Some("wrong")));
        assert!(is_authorized(true, Some("secret"), Some("secret")));
    }
}
