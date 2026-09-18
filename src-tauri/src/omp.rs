//! omp 子进程会话 actor：一个会话一个 tokio task 持有子进程，命令走 mpsc。
//!
//! 进程模型（手册 §18.2）：
//! - 启动参数固定 `--mode rpc-ui --approval-mode always-ask --profile omp-desktop`
//!   （approvalMode 默认是 yolo，不显式传等于关掉人工确认）
//! - stdout 只走协议；stderr 由独立 task 持续消费（不读会填满管道造成死锁）
//! - 启动后读 `ready` 帧 → 发 `negotiate_protocol v2` →（如需恢复）`switch_session`
//! - 优雅关闭：关 stdin → 等退出码 → 超时才 kill（先 kill 会丢最后的落盘与 dispose）

use crate::protocol::FrameDecoder;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, watch, Mutex};

/// 套壳专用 profile（硬约束：与用户 CLI 隔离认证/会话/设置）。
pub const OMP_PROFILE: &str = "omp-desktop";
/// 关闭顺序里的等待窗口：关 stdin 后等 omp 自行退出，超过才 SIGKILL。
const CLOSE_GRACE: Duration = Duration::from_secs(5);

pub type EventSink = Arc<dyn Fn(Value) + Send + Sync>;

#[derive(Debug, Clone)]
pub struct ExitInfo {
    pub code: Option<i32>,
}

pub struct SpawnOptions {
    pub cwd: PathBuf,
    pub resume_session: Option<PathBuf>,
}

enum Cmd {
    Request {
        frame: Value,
        reply: Option<oneshot::Sender<Result<Value, String>>>,
    },
    Shutdown,
}

/// stdout 行泵投递给主循环的条目。
enum Line {
    Text(String),
    Eof,
}

pub struct SessionHandle {
    pub key: String,
    cmd_tx: mpsc::Sender<Cmd>,
    exited: watch::Receiver<Option<ExitInfo>>,
    /// 最近 200 行 stderr（std Mutex：锁持有极短，同步读取方便诊断）。
    stderr_tail: Arc<std::sync::Mutex<VecDeque<String>>>,
    next_id: AtomicU64,
}

impl SessionHandle {
    /// 发 RPC 命令并等待同 id 的 response 帧（返回完整 response，含 success/error）。
    pub async fn request(&self, mut frame: Value, timeout: Duration) -> Result<Value, String> {
        if frame.get("id").is_none() {
            let n = self.next_id.fetch_add(1, Ordering::Relaxed);
            frame["id"] = json!(format!("u{}", n));
        }
        let (tx, rx) = oneshot::channel();
        self.cmd_tx
            .send(Cmd::Request { frame, reply: Some(tx) })
            .await
            .map_err(|_| "会话已关闭".to_string())?;
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => Err("会话内部通道已关闭".into()),
            Err(_) => Err("命令超时（omp 未在时限内应答）".into()),
        }
    }

    /// 发一帧并立即返回（extension_ui_response 等没有应答帧的入站帧用）。
    pub async fn send_frame(&self, frame: Value) -> Result<(), String> {
        self.cmd_tx
            .send(Cmd::Request { frame, reply: None })
            .await
            .map_err(|_| "会话已关闭".to_string())
    }

    pub async fn shutdown(&self) {
        let _ = self.cmd_tx.send(Cmd::Shutdown).await;
    }

    pub async fn wait_exit(&self, timeout: Duration) -> Option<ExitInfo> {
        let mut rx = self.exited.clone();
        if let Some(e) = rx.borrow().clone() {
            return Some(e);
        }
        match tokio::time::timeout(timeout, rx.changed()).await {
            Ok(Ok(())) => rx.borrow().clone(),
            _ => None,
        }
    }

    pub fn stderr_tail(&self) -> Vec<String> {
        self.stderr_tail.lock().unwrap().iter().cloned().collect()
    }
}

pub struct SessionManager {
    sessions: Mutex<HashMap<String, Arc<SessionHandle>>>,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

impl SessionManager {
    pub async fn spawn(
        &self,
        opts: SpawnOptions,
        event: EventSink,
    ) -> Result<Arc<SessionHandle>, String> {
        let key = uuid::Uuid::new_v4().to_string();
        let handle = spawn_session(&key, opts, event).await?;
        self.sessions.lock().await.insert(key.clone(), handle.clone());
        Ok(handle)
    }

    pub async fn get(&self, key: &str) -> Option<Arc<SessionHandle>> {
        self.sessions.lock().await.get(key).cloned()
    }

    pub async fn remove(&self, key: &str) -> Option<Arc<SessionHandle>> {
        self.sessions.lock().await.remove(key)
    }

    /// 退出前串行优雅关闭所有会话；每个会话最多等 CLOSE_GRACE + 1s。
    pub async fn shutdown_all(&self) {
        let all: Vec<Arc<SessionHandle>> = {
            let mut map = self.sessions.lock().await;
            map.drain().map(|(_, v)| v).collect()
        };
        for h in all {
            h.shutdown().await;
            let _ = h.wait_exit(CLOSE_GRACE + Duration::from_secs(1)).await;
        }
    }
}

fn resolve_omp_bin() -> PathBuf {
    // GUI 启动时 PATH 通常不含 ~/.bun，按常见安装位置探测；找不到再交给 PATH。
    if let Ok(home) = std::env::var("HOME") {
        let candidates = [
            PathBuf::from(&home).join(".bun/bin/omp"),
            PathBuf::from("/Volumes/MacApps/Home/.bun/bin/omp"),
            PathBuf::from("/opt/homebrew/bin/omp"),
            PathBuf::from("/usr/local/bin/omp"),
        ];
        for c in candidates {
            if c.is_file() {
                return c;
            }
        }
    }
    PathBuf::from("omp")
}

async fn spawn_session(
    key: &str,
    opts: SpawnOptions,
    event: EventSink,
) -> Result<Arc<SessionHandle>, String> {
    if !opts.cwd.is_dir() {
        return Err(format!("工作目录不存在: {}", opts.cwd.display()));
    }
    let mut child = Command::new(resolve_omp_bin())
        .args([
            "--mode",
            "rpc-ui",
            "--approval-mode",
            "always-ask",
            "--profile",
            OMP_PROFILE,
            "--cwd",
        ])
        .arg(&opts.cwd)
        .current_dir(&opts.cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("启动 omp 失败: {e}"))?;

    let stdin: ChildStdin = child.stdin.take().expect("stdin 已 piped");
    let stdout = child.stdout.take().expect("stdout 已 piped");
    let stderr = child.stderr.take().expect("stderr 已 piped");

    let (cmd_tx, cmd_rx) = mpsc::channel::<Cmd>(64);
    let (exited_tx, exited_rx) = watch::channel(None);
    let stderr_tail: Arc<std::sync::Mutex<VecDeque<String>>> =
        Arc::new(std::sync::Mutex::new(VecDeque::new()));

    // stderr 独立 task 持续消费：环形缓冲最近 200 行，供诊断拉取。
    let tail = stderr_tail.clone();
    let sink = event.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(l)) => {
                    let mut q = tail.lock().unwrap();
                    if q.len() >= 200 {
                        q.pop_front();
                    }
                    q.push_back(l);
                    drop(q);
                }
                _ => break,
            }
        }
        let _ = sink;
    });

    // stdout 行泵：EOF 可感知地进入主循环。
    let (line_tx, line_rx) = mpsc::channel::<Line>(256);
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(l)) => {
                    if line_tx.send(Line::Text(l)).await.is_err() {
                        break;
                    }
                }
                _ => {
                    let _ = line_tx.send(Line::Eof).await;
                    break;
                }
            }
        }
    });

    let handle = Arc::new(SessionHandle {
        key: key.to_string(),
        cmd_tx: cmd_tx.clone(),
        exited: exited_rx,
        stderr_tail,
        next_id: AtomicU64::new(0),
    });

    let event_for_actor = event.clone();
    let key_owned = key.to_string();
    tokio::spawn(run_actor(
        child,
        stdin,
        opts,
        event_for_actor,
        cmd_rx,
        exited_tx,
        line_rx,
        key_owned,
    ));

    Ok(handle)
}

#[allow(clippy::too_many_arguments)]
async fn run_actor(
    mut child: Child,
    mut stdin: ChildStdin,
    opts: SpawnOptions,
    event: EventSink,
    mut cmd_rx: mpsc::Receiver<Cmd>,
    exited_tx: watch::Sender<Option<ExitInfo>>,
    mut line_rx: mpsc::Receiver<Line>,
    _key: String,
) {
    let mut pending: HashMap<String, oneshot::Sender<Result<Value, String>>> = HashMap::new();
    let mut decoder = FrameDecoder::new();
    let mut stdout_open = true;
    let mut closing = false;
    let mut deadline: Option<std::pin::Pin<Box<tokio::time::Sleep>>> = None;
    let mut seq: u64 = 0;

    async fn write_line(stdin: &mut ChildStdin, v: &Value) -> Result<(), String> {
        let mut s = v.to_string();
        s.push('\n');
        stdin
            .write_all(s.as_bytes())
            .await
            .map_err(|e| format!("写 omp stdin 失败: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("flush omp stdin 失败: {e}"))
    }

    loop {
        tokio::select! {
            maybe = line_rx.recv(), if stdout_open => {
                match maybe {
                    Some(Line::Text(l)) => {
                        let frame = match decoder.decode_line(&l) {
                            Ok(Some(f)) => f,
                            Ok(None) => continue,
                            Err(e) => {
                                event(json!({"type": "desktop_error", "error": e}));
                                continue;
                            }
                        };
                        match frame.get("type").and_then(Value::as_str) {
                            Some("ready") => {
                                decoder.apply_ready(&frame);
                                if let Err(e) = write_line(&mut stdin, &json!({
                                    "id": "protocol-1",
                                    "type": "negotiate_protocol",
                                    "protocolVersion": 2
                                })).await {
                                    event(json!({"type": "desktop_error", "error": e}));
                                }
                            }
                            Some("response") if frame.get("command").and_then(Value::as_str) == Some("negotiate_protocol") => {
                                if frame.get("success").and_then(Value::as_bool) != Some(true) {
                                    event(json!({"type": "desktop_error", "error": format!("negotiate_protocol 失败: {}", frame.get("error").and_then(Value::as_str).unwrap_or("?"))}));
                                }
                                // 恢复会话：negotiate 之后、业务命令之前
                                if let Some(p) = &opts.resume_session {
                                    let f = json!({
                                        "id": "resume-1",
                                        "type": "switch_session",
                                        "sessionPath": p.display().to_string()
                                    });
                                    if let Err(e) = write_line(&mut stdin, &f).await {
                                        event(json!({"type": "desktop_error", "error": e}));
                                    }
                                }
                                event(json!({"type": "desktop_ready"}));
                            }
                            Some("response") => {
                                // 按 id 唤醒等待方；unknown id 的响应（id: undefined）广播给前端
                                if let Some(id) = frame.get("id").and_then(Value::as_str) {
                                    if let Some(tx) = pending.remove(id) {
                                        let _ = tx.send(Ok(frame));
                                        continue;
                                    }
                                }
                                event(frame);
                            }
                            _ => {
                                // 事件帧 / extension_ui_request / host_tool_call / notice 等
                                event(frame);
                            }
                        }
                    }
                    Some(Line::Eof) | None => {
                        stdout_open = false;
                    }
                }
            }
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(Cmd::Request { mut frame, reply }) => {
                        if frame.get("id").is_none() {
                            seq += 1;
                            frame["id"] = json!(format!("a{}", seq));
                        }
                        if let Some(tx) = reply {
                            let id = frame.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                            pending.insert(id, tx);
                        }
                        if let Err(e) = write_line(&mut stdin, &frame).await {
                            let id = frame.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                            if let Some(tx) = pending.remove(&id) {
                                let _ = tx.send(Err(e.clone()));
                            }
                            event(json!({"type": "desktop_error", "error": e}));
                        }
                    }
                    Some(Cmd::Shutdown) | None => {
                        // 优雅关闭：关 stdin → omp 拒绝挂起请求并 dispose → 退出码 0
                        closing = true;
                        let _ = stdin.shutdown().await;
                        deadline = Some(Box::pin(tokio::time::sleep(CLOSE_GRACE)));
                    }
                }
            }
            res = child.wait() => {
                match res {
                    Ok(status) => {
                        for (_, tx) in pending.drain() {
                            let _ = tx.send(Err("omp 进程已退出".into()));
                        }
                        let info = ExitInfo { code: status.code() };
                        let _ = exited_tx.send(Some(info.clone()));
                        event(json!({"type": "desktop_exit", "code": info.code}));
                    }
                    Err(e) => {
                        for (_, tx) in pending.drain() {
                            let _ = tx.send(Err("omp 进程状态获取失败".into()));
                        }
                        let _ = exited_tx.send(Some(ExitInfo { code: None }));
                        event(json!({"type": "desktop_error", "error": format!("等待 omp 退出失败: {e}")}));
                    }
                }
                break;
            }
            _ = async {
                match deadline.as_mut() {
                    Some(d) => d.as_mut().await,
                    None => std::future::pending::<()>().await,
                }
            }, if closing => {
                // 超过宽限期仍不退出：SIGKILL 兜底（此时落盘可能已尽力）
                let _ = child.start_kill();
                deadline = None;
            }
        }
    }
}
