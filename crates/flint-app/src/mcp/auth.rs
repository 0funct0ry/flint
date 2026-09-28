//! Bearer-token extraction for the local MCP server. Loopback-only binding still means any
//! other local process or user on a shared machine can connect, so every request (other than
//! the auth check itself) must present the current per-launch token.

/// Extract the token from an `Authorization: Bearer <token>` header, if present.
pub fn extract_bearer_token(request: &tiny_http::Request) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|h| {
            h.field
                .as_str()
                .as_str()
                .eq_ignore_ascii_case("authorization")
        })
        .map(|h| h.value.as_str().to_string())
        .and_then(|v| v.strip_prefix("Bearer ").map(|t| t.trim().to_string()))
}

#[cfg(test)]
mod tests {
    #[test]
    fn header_value_strips_bearer_prefix() {
        let header =
            tiny_http::Header::from_bytes(&b"Authorization"[..], &b"Bearer abc123"[..]).unwrap();
        assert!(header
            .field
            .as_str()
            .as_str()
            .eq_ignore_ascii_case("authorization"));
        assert_eq!(
            header.value.as_str().strip_prefix("Bearer "),
            Some("abc123")
        );
    }
}
