#![allow(dead_code)]

use std::collections::HashMap;
use std::io::{Cursor, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use shepherd_cli::Io;

/// A server/agent string carrying OSC (title + BEL), CSI and C1-CSI terminal sequences.
pub const EVIL: &str = "x\u{1b}]0;pwn\u{7}\u{1b}[2J\u{9b}31my";

/// No terminal control byte made it through to a terminal.
pub fn assert_clean(text: &str) {
    for c in ['\u{1b}', '\u{7}', '\u{9b}'] {
        assert!(!text.contains(c), "{c:?} in {text:?}");
    }
}

#[derive(Clone, Default)]
pub struct Buf(Arc<Mutex<Vec<u8>>>);

impl Buf {
    pub fn text(&self) -> String {
        String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
    }
}

impl Write for Buf {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(data);
        Ok(data.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub struct Harness {
    pub out: Buf,
    pub err: Buf,
    pub env: HashMap<String, String>,
    pub tty: bool,
    pub stdin: String,
    pub config_home: tempfile::TempDir,
    /// Stands in for the `/proc/net/tcp` owner check; never foreign by default.
    pub foreign: Arc<dyn Fn(&str) -> bool + Send + Sync>,
}

impl Harness {
    /// A harness whose config dir is empty and whose env carries only `SHEPHERD_TOKEN`.
    pub fn new() -> Self {
        let config_home = tempfile::tempdir().unwrap();
        let mut env = HashMap::new();
        env.insert(
            "XDG_CONFIG_HOME".to_string(),
            config_home.path().display().to_string(),
        );
        env.insert("SHEPHERD_TOKEN".to_string(), "shp_test".to_string());
        Harness {
            out: Buf::default(),
            err: Buf::default(),
            env,
            tty: false,
            stdin: String::new(),
            config_home,
            foreign: Arc::new(|_| false),
        }
    }

    pub fn io(&self) -> Io {
        Io {
            stdout: Box::new(self.out.clone()),
            stderr: Box::new(self.err.clone()),
            stdin: Box::new(Cursor::new(self.stdin.clone().into_bytes())),
            stdout_is_tty: self.tty,
            env: self.env.clone(),
            cwd: Path::new("/").to_path_buf(),
            foreign_listener: self.foreign.clone(),
        }
    }

    pub async fn run(&self, args: &[&str]) -> i32 {
        let mut io = self.io();
        let mut argv = vec!["shepherd"];
        argv.extend_from_slice(args);
        shepherd_cli::run(argv, &mut io).await
    }

    /// Neither stdout nor stderr carries a terminal control byte.
    pub fn assert_clean(&self) {
        assert_clean(&self.out.text());
        assert_clean(&self.err.text());
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::from_str(self.out.text().trim()).expect("stdout is one JSON document")
    }

    /// Uses a stored profile token for `url` instead of `SHEPHERD_TOKEN`.
    pub fn profile(&mut self, url: &str, token: &str) {
        self.env.remove("SHEPHERD_TOKEN");
        let dir = self.config_home.path().join("shepherd");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("config.toml"),
            format!("[profiles.default]\nurl = \"{url}\"\ntoken = \"{token}\"\n"),
        )
        .unwrap();
    }

    /// Makes the listener check report "another user" once the returned flag is set.
    pub fn foreign_when(&mut self) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        let f = flag.clone();
        self.foreign = Arc::new(move |_| f.load(Ordering::SeqCst));
        flag
    }
}
