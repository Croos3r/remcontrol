pub mod config;
pub mod injector;
pub mod protocol;
pub mod ws;

use serde_json::json;

const DEFAULT_HOSTNAME: &str = "remcontrol";

/// Normalize a raw OS hostname into a usable service instance name:
/// strip a trailing dot, drop empty results, and fall back to a default.
/// `raw` is the already-decoded string (or None if the OS call failed),
/// matching what `hostname::get().ok().and_then(into_string)` produces.
pub fn sanitize_hostname(raw: Option<String>) -> String {
    let trimmed = raw
        .map(|h| h.trim_end_matches('.').to_string())
        .filter(|h| !h.is_empty());
    trimmed.unwrap_or_else(|| DEFAULT_HOSTNAME.to_string())
}

/// Build the JSON payload encoded into the pairing QR code.
pub fn pairing_payload(ip: &str, port: u16, token: &str, name: &str) -> String {
    json!({
        "ip": ip,
        "port": port,
        "token": token,
        "name": name,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_payload_contains_all_fields() {
        let payload = pairing_payload("192.168.1.10", 17890, "secret", "valiant");
        let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(parsed["ip"], "192.168.1.10");
        assert_eq!(parsed["port"], 17890);
        assert_eq!(parsed["token"], "secret");
        assert_eq!(parsed["name"], "valiant");
    }

    #[test]
    fn pairing_payload_is_a_single_json_object() {
        let payload = pairing_payload("10.0.0.1", 1, "t", "n");
        assert!(payload.starts_with('{'));
        assert!(payload.ends_with('}'));
    }

    #[test]
    fn sanitize_hostname_keeps_a_normal_name() {
        assert_eq!(sanitize_hostname(Some("valiant".into())), "valiant");
    }

    #[test]
    fn sanitize_hostname_strips_trailing_dot() {
        assert_eq!(sanitize_hostname(Some("valiant.".into())), "valiant");
    }

    #[test]
    fn sanitize_hostname_drops_empty_name() {
        assert_eq!(sanitize_hostname(Some("".into())), "remcontrol");
    }

    #[test]
    fn sanitize_hostname_drops_none() {
        assert_eq!(sanitize_hostname(None), "remcontrol");
    }
}
