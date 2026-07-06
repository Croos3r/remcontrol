pub mod config;
pub mod crypto;
pub mod injector;
pub mod protocol;
pub mod ws;

use serde_json::json;
use sha2::{Digest, Sha256};
use std::net::{IpAddr, Ipv4Addr};

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

/// A short, non-secret fingerprint of the pairing token, shown in the
/// terminal so the user can confirm the QR they scanned belongs to this
/// server without exposing the token itself (H-3). First 8 hex chars of
/// SHA-256(token).
pub fn token_fingerprint(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    hex::encode(&digest[..4])
}

/// Build the JSON payload encoded into the pairing QR code. Includes the
/// protocol version (M-3) and the long-lived PSK token, which is safe to
/// encode here because it is never transmitted on the wire — it
/// authenticates the ephemeral ECDH handshake (H-3, C-1).
pub fn pairing_payload(ip: &str, port: u16, token: &str, name: &str) -> String {
    json!({
        "v": crypto::PROTOCOL_VERSION,
        "ip": ip,
        "port": port,
        "token": token,
        "name": name,
    })
    .to_string()
}

/// Interface-name prefixes for virtual / bridge / tunnel interfaces we never
/// want to bind to or advertise. The Wi-Fi or Ethernet interface carrying the
/// LAN is what the phone must reach; a Tailscale/WireGuard/Docker bridge IP
/// is either unreachable from the phone or the wrong subnet.
const VIRTUAL_IFACE_PREFIXES: &[&str] = &[
    "lo",
    "docker",
    "br-",
    "veth",
    "virbr",
    "tun",
    "tap",
    "tailscale",
    "wg",
    "utun",
    "ppp",
    "zt",
];

/// True if an interface name looks like a virtual/loopback/tunnel device and
/// should be skipped when picking the LAN IP.
fn is_virtual_iface(name: &str) -> bool {
    let n = name.trim_end_matches(':');
    VIRTUAL_IFACE_PREFIXES.iter().any(|p| n.starts_with(p))
}

/// Pick the best LAN IPv4 from a list of `(interface_name, ip)` pairs.
///
/// Rules: IPv4 only, skip virtual/loopback/tunnel interfaces by name, skip
/// loopback and link-local addresses, prefer RFC 1918 private ranges, then
/// take the first candidate. Returns `None` if nothing matches.
///
/// This is pure over its input so it can be unit-tested without depending on
/// the host's actual interfaces.
pub fn select_lan_ipv4<'a, I>(ifaces: I) -> Option<Ipv4Addr>
where
    I: IntoIterator<Item = (&'a str, IpAddr)>,
{
    let mut best: Option<Ipv4Addr> = None;
    for (name, ip) in ifaces {
        if is_virtual_iface(name) {
            continue;
        }
        let IpAddr::V4(v4) = ip else { continue };
        if v4.is_loopback() || v4.is_link_local() || v4.is_unspecified() {
            continue;
        }
        // Prefer RFC 1918 private; keep the first private candidate.
        if v4.is_private() {
            return Some(v4);
        }
        // Otherwise remember a non-private, non-virtual public IPv4 as a
        // last-resort fallback (rare on a LAN server).
        best.get_or_insert(v4);
    }
    best
}

/// Discover a LAN IPv4 to bind on and advertise in the QR. Enumerates the
/// host's interfaces and picks a private IPv4 on a non-virtual interface, so
/// the server doesn't accidentally bind to a Tailscale/WireGuard/Docker IP
/// that the phone can't reach. Falls back to `local_ip_address::local_ip()`
/// if enumeration yields nothing (e.g., an unusual platform).
pub fn pick_lan_ip() -> Result<IpAddr, String> {
    let ifaces = local_ip_address::list_afinet_netifas()
        .map_err(|e| format!("interface enumeration failed: {e}"))?;
    let candidates: Vec<(String, IpAddr)> = ifaces;
    let picked = select_lan_ipv4(candidates.iter().map(|(n, ip)| (n.as_str(), *ip)));
    match picked {
        Some(v4) => Ok(IpAddr::V4(v4)),
        None => local_ip_address::local_ip()
            .map_err(|e| format!("no LAN IPv4 found, and local_ip failed: {e}")),
    }
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

    #[test]
    fn select_lan_ipv4_prefers_wifi_over_docker_and_loopback() {
        let ifaces = [
            ("lo", IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))),
            ("wlp0s20f3", IpAddr::V4(Ipv4Addr::new(10, 68, 253, 178))),
            ("docker0", IpAddr::V4(Ipv4Addr::new(172, 17, 0, 1))),
            ("lo", IpAddr::V6("::1".parse().unwrap())),
        ];
        assert_eq!(
            select_lan_ipv4(ifaces.into_iter()),
            Some(Ipv4Addr::new(10, 68, 253, 178))
        );
    }

    #[test]
    fn select_lan_ipv4_skips_tailscale_and_picks_real_lan() {
        // Regression: the server previously bound to a Tailscale IP because
        // local_ip() followed the default route through tailscale0. The phone
        // could not reach 10.213.103.120 from Wi-Fi.
        let ifaces = [
            ("tailscale0", IpAddr::V4(Ipv4Addr::new(10, 213, 103, 120))),
            ("wlp0s20f3", IpAddr::V4(Ipv4Addr::new(192, 168, 1, 42))),
        ];
        assert_eq!(
            select_lan_ipv4(ifaces.into_iter()),
            Some(Ipv4Addr::new(192, 168, 1, 42))
        );
    }

    #[test]
    fn select_lan_ipv4_skips_link_local_and_unspecified() {
        let ifaces = [
            ("eth0", IpAddr::V4(Ipv4Addr::new(169, 254, 1, 2))), // link-local
            ("eth1", IpAddr::V4(Ipv4Addr::new(0, 0, 0, 0))),     // unspecified
            ("eth2", IpAddr::V4(Ipv4Addr::new(172, 16, 0, 1))),  // private
        ];
        assert_eq!(
            select_lan_ipv4(ifaces.into_iter()),
            Some(Ipv4Addr::new(172, 16, 0, 1))
        );
    }

    #[test]
    fn select_lan_ipv4_returns_none_for_only_virtual() {
        let ifaces = [
            ("lo", IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))),
            ("docker0", IpAddr::V4(Ipv4Addr::new(172, 17, 0, 1))),
            ("br-abc", IpAddr::V4(Ipv4Addr::new(172, 18, 0, 1))),
        ];
        assert_eq!(select_lan_ipv4(ifaces.into_iter()), None);
    }

    #[test]
    fn is_virtual_iface_recognizes_known_prefixes() {
        for v in [
            "lo",
            "lo:",
            "docker0",
            "br-1234",
            "vethabc",
            "tun0",
            "tailscale0",
            "wg0",
            "utun1",
        ] {
            assert!(is_virtual_iface(v), "{v} should be virtual");
        }
        for r in ["wlp0s20f3", "eth0", "en0", "wlan0"] {
            assert!(!is_virtual_iface(r), "{r} should NOT be virtual");
        }
    }
}
