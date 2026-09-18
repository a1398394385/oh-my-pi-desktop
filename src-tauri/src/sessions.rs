//! omp 会话存储只读扫描（硬约束：套壳不写 omp 的 session 存储）。
//!
//! 存储布局：`~/.omp/profiles/omp-desktop/agent/sessions/<编码后 cwd>/<时间戳>_<uuid>.jsonl`
//! 每个文件头部是 `{"type":"title",...}` 与 `{"type":"session","id","cwd",...}`。
//! 不解析目录名编码规则（含符号链接 resolve，规则不稳），直接读文件头比对 cwd 字段。

use serde::Serialize;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;

#[derive(Serialize, Clone)]
pub struct SessionMeta {
    pub path: String,
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub mtime_ms: u64,
}

fn profile_sessions_dir() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    Path::new(&home)
        .join(".omp/profiles")
        .join(crate::omp::OMP_PROFILE)
        .join("agent/sessions")
}

fn canonical(p: &Path) -> String {
    p.canonicalize()
        .map(|x| x.display().to_string())
        .unwrap_or_else(|_| p.display().to_string())
}

/// 读会话文件头部，返回 (title, session_id, cwd)。
fn read_head(path: &Path) -> Option<(String, String, String)> {
    let f = fs::File::open(path).ok()?;
    let mut r = BufReader::new(f);
    let mut title = String::new();
    let mut id = String::new();
    let mut cwd = String::new();
    for _ in 0..4 {
        let mut line = String::new();
        if r.read_line(&mut line).ok()? == 0 {
            break;
        }
        let v: serde_json::Value = serde_json::from_str(&line).ok()?;
        match v.get("type").and_then(|t| t.as_str()) {
            Some("title") => {
                title = v.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string();
            }
            Some("session") => {
                id = v.get("id").and_then(|t| t.as_str()).unwrap_or("").to_string();
                cwd = v.get("cwd").and_then(|t| t.as_str()).unwrap_or("").to_string();
            }
            _ => {}
        }
    }
    if id.is_empty() {
        return None;
    }
    Some((title, id, cwd))
}

pub fn list_sessions(cwd: &Path) -> Result<Vec<SessionMeta>, String> {
    let base = profile_sessions_dir();
    if !base.is_dir() {
        return Ok(Vec::new());
    }
    let want = canonical(cwd);
    let mut out: Vec<SessionMeta> = Vec::new();
    let dirs = fs::read_dir(&base).map_err(|e| format!("读取会话目录失败: {e}"))?;
    for dir in dirs.flatten() {
        if !dir.path().is_dir() {
            continue;
        }
        let files = match fs::read_dir(dir.path()) {
            Ok(f) => f,
            Err(_) => continue,
        };
        for file in files.flatten() {
            let p = file.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some((title, id, session_cwd)) = read_head(&p) else {
                continue;
            };
            if canonical(Path::new(&session_cwd)) != want {
                continue;
            }
            let mtime_ms = file
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.push(SessionMeta {
                path: p.display().to_string(),
                id,
                title,
                cwd: session_cwd,
                mtime_ms,
            });
        }
    }
    out.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    Ok(out)
}
