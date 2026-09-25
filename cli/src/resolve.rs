//! Session references: a UUID, or the designation an operator sees (`TASK-07`, `task-7`, `7`).

use crate::api::types::Session;

fn digits(s: &str) -> Option<u64> {
    (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        .then(|| s.parse().ok())
        .flatten()
}

/// The desig's numeric suffix: `TASK-07` → 7.
fn desig_number(desig: &str) -> Option<u64> {
    digits(desig.rsplit('-').next()?)
}

/// Finds the session `key` names. Exact id first, then designation (case-insensitive), then a bare
/// or `TASK-`-prefixed number matched on the designation's numeric suffix (so `5` finds `TASK-05`).
pub fn find<'a>(sessions: &'a [Session], key: &str) -> Option<&'a Session> {
    let key = key.trim();
    if let Some(s) = sessions.iter().find(|s| s.id == key) {
        return Some(s);
    }
    if let Some(s) = sessions.iter().find(|s| s.desig.eq_ignore_ascii_case(key)) {
        return Some(s);
    }
    let lower = key.to_ascii_lowercase();
    let n = digits(lower.strip_prefix("task-").unwrap_or(&lower))?;
    let mut hits = sessions
        .iter()
        .filter(|s| desig_number(&s.desig) == Some(n));
    let first = hits.next()?;
    hits.next().is_none().then_some(first)
}

/// True when `key` is shaped like a session id (a UUID) and needs no lookup.
pub fn looks_like_id(key: &str) -> bool {
    uuid::Uuid::parse_str(key.trim()).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, desig: &str) -> Session {
        serde_json::from_value(crate::test_support::session_json(id, desig)).unwrap()
    }

    #[test]
    fn finds_by_id_desig_and_number() {
        let list = vec![session("aaa", "TASK-05"), session("bbb", "TASK-435")];
        assert_eq!(find(&list, "bbb").unwrap().id, "bbb");
        assert_eq!(find(&list, "task-05").unwrap().id, "aaa");
        assert_eq!(find(&list, "5").unwrap().id, "aaa");
        assert_eq!(find(&list, "TASK-5").unwrap().id, "aaa");
        assert_eq!(find(&list, "435").unwrap().id, "bbb");
        assert!(find(&list, "6").is_none());
        assert!(find(&list, "nope").is_none());
    }

    #[test]
    fn ambiguous_number_matches_nothing() {
        let list = vec![session("a", "TASK-05"), session("b", "EPIC-5")];
        assert!(find(&list, "5").is_none());
        assert_eq!(find(&list, "EPIC-5").unwrap().id, "b");
    }

    #[test]
    fn uuid_shape() {
        assert!(looks_like_id("0b6f2c1e-7c1d-4e53-9d1a-3c1f2e4b5a6d"));
        assert!(!looks_like_id("TASK-07"));
    }
}
