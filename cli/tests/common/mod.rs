#![allow(dead_code)]

use std::collections::HashMap;
use std::io::{Cursor, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};

use shepherd_cli::Io;

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
        }
    }

    pub async fn run(&self, args: &[&str]) -> i32 {
        let mut io = self.io();
        let mut argv = vec!["shepherd"];
        argv.extend_from_slice(args);
        shepherd_cli::run(argv, &mut io).await
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::from_str(self.out.text().trim()).expect("stdout is one JSON document")
    }
}
