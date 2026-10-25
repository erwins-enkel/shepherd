//! Is the local server we're about to hand a stored token to really ours?
//!
//! Loopback ports are not reserved per user: while the operator's server is down, another local
//! account can bind `127.0.0.1:7330` and collect the profile token. On Linux the kernel reports each
//! socket's owning uid in `/proc/net/tcp{,6}`, so a listener owned by a different uid is detectable
//! for the cost of two small reads. Elsewhere (or when the tables are unreadable) there is no check.

/// LISTEN in the `st` column of `/proc/net/tcp`.
const TCP_LISTEN: &str = "0A";

/// The port of an `http(s)://` URL whose host is `localhost` or a loopback address, else `None`.
fn loopback_port(url: &str) -> Option<u16> {
    let (rest, default_port) = if let Some(r) = url.strip_prefix("http://") {
        (r, 80)
    } else {
        (url.strip_prefix("https://")?, 443)
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let (host, port) = if let Some(v6) = authority.strip_prefix('[') {
        let (host, tail) = v6.split_once(']')?;
        (host, tail.strip_prefix(':'))
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority, None),
        }
    };
    let loopback = host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    if !loopback {
        return None;
    }
    match port {
        Some(p) => p.parse().ok(),
        None => Some(default_port),
    }
}

/// Does a `/proc/net/tcp{,6}` local address accept loopback connections (loopback or any-address)?
fn reaches_loopback(addr_hex: &str) -> bool {
    match addr_hex.len() {
        // IPv4, host byte order (little-endian on every Linux target we ship): 127.x.x.x ends in 7F.
        8 => addr_hex == "00000000" || addr_hex.ends_with("7F"),
        32 => {
            let any = "0".repeat(32);
            let lo6 = "00000000000000000000000001000000";
            let mapped = addr_hex.starts_with("0000000000000000FFFF0000");
            addr_hex == any || addr_hex == lo6 || (mapped && reaches_loopback(&addr_hex[24..]))
        }
        _ => false,
    }
}

/// True when a LISTEN socket on `url`'s loopback port is owned by a uid other than `euid`.
/// `tables` are the raw texts of `/proc/net/tcp` and `/proc/net/tcp6`.
pub fn foreign_listener(url: &str, euid: u32, tables: &[&str]) -> bool {
    let Some(port) = loopback_port(url) else {
        return false;
    };
    let port_hex = format!("{port:04X}");
    tables.iter().flat_map(|t| t.lines().skip(1)).any(|line| {
        let f: Vec<&str> = line.split_whitespace().collect();
        let (Some(local), Some(st), Some(uid)) = (f.get(1), f.get(3), f.get(7)) else {
            return false;
        };
        let Some((addr, p)) = local.split_once(':') else {
            return false;
        };
        *st == TCP_LISTEN
            && p == port_hex
            && reaches_loopback(addr)
            && uid.parse::<u32>().is_ok_and(|u| u != euid)
    })
}

/// [`foreign_listener`] against the live kernel tables. Linux only; `false` elsewhere or when the
/// tables or our own uid can't be read.
#[cfg(target_os = "linux")]
pub fn check(url: &str) -> bool {
    use std::os::unix::fs::MetadataExt;
    let Ok(euid) = std::fs::metadata("/proc/self").map(|m| m.uid()) else {
        return false;
    };
    let v4 = std::fs::read_to_string("/proc/net/tcp").unwrap_or_default();
    let v6 = std::fs::read_to_string("/proc/net/tcp6").unwrap_or_default();
    foreign_listener(url, euid, &[&v4, &v6])
}

#[cfg(not(target_os = "linux"))]
pub fn check(_url: &str) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADER: &str = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

    fn table(rows: &[(&str, &str, u32)]) -> String {
        let mut t = String::from(HEADER);
        for (i, (local, st, uid)) in rows.iter().enumerate() {
            t.push_str(&format!(
                "\n   {i}: {local} 00000000:0000 {st} 00000000:00000000 00:00000000 00000000  {uid}        0 1{i} 1 0000000000000000 100 0 0 10 0"
            ));
        }
        t
    }

    const URL: &str = "http://127.0.0.1:7330";

    #[test]
    fn own_listener_is_not_foreign() {
        let t = table(&[("0100007F:1CA2", "0A", 1000)]);
        assert!(!foreign_listener(URL, 1000, &[&t]));
    }

    #[test]
    fn other_uid_listener_is_foreign() {
        let t = table(&[("0100007F:1CA2", "0A", 1001)]);
        assert!(foreign_listener(URL, 1000, &[&t]));
        let any = table(&[("00000000:1CA2", "0A", 1001)]);
        assert!(foreign_listener("http://localhost:7330/", 1000, &[&any]));
    }

    #[test]
    fn v6_loopback_and_any_listeners_count() {
        let lo6 = table(&[("00000000000000000000000001000000:1CA2", "0A", 1001)]);
        assert!(foreign_listener("http://[::1]:7330", 1000, &[&lo6]));
        let any6 = table(&[("00000000000000000000000000000000:1CA2", "0A", 1001)]);
        assert!(foreign_listener(URL, 1000, &["", &any6]));
        let mapped = table(&[("0000000000000000FFFF00000100007F:1CA2", "0A", 1001)]);
        assert!(foreign_listener(URL, 1000, &[&mapped]));
    }

    #[test]
    fn ignores_other_ports_states_addresses_and_remote_urls() {
        let other_port = table(&[("0100007F:1CA3", "0A", 1001)]);
        assert!(!foreign_listener(URL, 1000, &[&other_port]));
        let established = table(&[("0100007F:1CA2", "01", 1001)]);
        assert!(!foreign_listener(URL, 1000, &[&established]));
        let lan = table(&[("0101A8C0:1CA2", "0A", 1001)]); // 192.168.1.1
        assert!(!foreign_listener(URL, 1000, &[&lan]));
        let t = table(&[("0100007F:1CA2", "0A", 1001)]);
        assert!(!foreign_listener(
            "https://shepherd.example.ts.net:7330",
            1000,
            &[&t]
        ));
    }

    #[test]
    fn parses_loopback_urls() {
        assert_eq!(loopback_port("http://127.0.0.1:7330"), Some(7330));
        assert_eq!(loopback_port("http://localhost"), Some(80));
        assert_eq!(loopback_port("https://[::1]/x"), Some(443));
        assert_eq!(loopback_port("http://127.0.0.1.evil.example:7330"), None);
        assert_eq!(loopback_port("http://example.com:7330"), None);
        assert_eq!(loopback_port("ftp://127.0.0.1"), None);
    }
}
