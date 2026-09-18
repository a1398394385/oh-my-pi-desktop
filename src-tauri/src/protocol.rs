//! RPC 帧解码与协议 v2 `rpc_chunk` 重组。
//!
//! 规则来自 omp `docs/rpc.md`：
//! - 单行一个 JSON 对象（JSONL）
//! - v2 下超大对象拆成连续 `rpc_chunk` 帧（base64 分片），必须按 index 重组
//! - 校验 chunkId/index/count/byteLength，拒绝交错或中断的序列
//! - 重组结果不得超过 `maxReassembledFrameBytes`（ready 帧通告，实测 64 MiB）

use base64::Engine;
use serde_json::Value;
use std::collections::BTreeMap;

/// ready 帧未到达前的保守缺省，ready 到达后以帧内通告值为准。
const DEFAULT_MAX_REASSEMBLED: usize = 64 * 1024 * 1024;

struct ChunkState {
    chunk_id: String,
    count: usize,
    byte_length: usize,
    parts: BTreeMap<usize, Vec<u8>>,
}

pub struct FrameDecoder {
    max_reassembled: usize,
    chunk: Option<ChunkState>,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self {
            max_reassembled: DEFAULT_MAX_REASSEMBLED,
            chunk: None,
        }
    }

    /// 从 ready 帧读取传输上限。
    pub fn apply_ready(&mut self, ready: &Value) {
        if let Some(v) = ready.get("maxReassembledFrameBytes").and_then(Value::as_u64) {
            self.max_reassembled = v as usize;
        }
    }

    /// 解码一行 stdout。返回 `Ok(None)` 表示是分片中间帧。
    pub fn decode_line(&mut self, line: &str) -> Result<Option<Value>, String> {
        let v: Value =
            serde_json::from_str(line).map_err(|e| format!("stdout 非 JSONL: {e}: {}", truncate(line, 120)))?;
        match v.get("type").and_then(Value::as_str) {
            Some("rpc_chunk") => self.feed_chunk(v),
            _ => Ok(Some(v)),
        }
    }

    fn feed_chunk(&mut self, v: Value) -> Result<Option<Value>, String> {
        let get = |k: &str| v.get(k).ok_or_else(|| format!("rpc_chunk 缺字段 {k}"));
        let chunk_id = get("chunkId")?
            .as_str()
            .ok_or("rpc_chunk.chunkId 非 string")?
            .to_string();
        let index = get("index")?.as_u64().ok_or("rpc_chunk.index 非法")? as usize;
        let count = get("count")?.as_u64().ok_or("rpc_chunk.count 非法")? as usize;
        let byte_length = get("byteLength")?.as_u64().ok_or("rpc_chunk.byteLength 非法")? as usize;
        let data = get("data")?.as_str().ok_or("rpc_chunk.data 非 string")?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|e| format!("rpc_chunk base64 解码失败: {e}"))?;

        if count == 0 {
            return Err("rpc_chunk.count 为 0".into());
        }
        match &self.chunk {
            // 同一序列的续片：元数据必须一致
            Some(cur) if cur.chunk_id == chunk_id => {
                if cur.count != count || cur.byte_length != byte_length {
                    return Err(format!(
                        "rpc_chunk 序列 {chunk_id} 元数据不一致（count/byteLength 变化）"
                    ));
                }
            }
            // 新序列：拒绝与未完成序列交错
            Some(cur) => {
                return Err(format!(
                    "rpc_chunk 交错：期待序列 {} 未收完却出现 {}",
                    cur.chunk_id, chunk_id
                ));
            }
            None => {
                if index != 0 {
                    return Err(format!("rpc_chunk 序列 {chunk_id} 起始 index={index}，应为 0"));
                }
                self.chunk = Some(ChunkState {
                    chunk_id: chunk_id.clone(),
                    count,
                    byte_length,
                    parts: BTreeMap::new(),
                });
            }
        }

        let cur = self.chunk.as_mut().expect("上方已初始化");
        if index >= cur.count {
            return Err(format!("rpc_chunk index {index} 越界（count={}）", cur.count));
        }
        if cur.parts.insert(index, bytes).is_some() {
            return Err(format!("rpc_chunk 序列 {} 重复 index {index}", cur.chunk_id));
        }
        let received: usize = cur.parts.values().map(|b| b.len()).sum();
        if received > self.max_reassembled {
            self.chunk = None;
            return Err(format!(
                "重组帧超过上限 {} 字节（已收 {received}）",
                self.max_reassembled
            ));
        }

        if cur.parts.len() == cur.count {
            let state = self.chunk.take().expect("存在");
            let mut buf = Vec::with_capacity(state.byte_length);
            for i in 0..state.count {
                buf.extend_from_slice(&state.parts[&i]);
            }
            if buf.len() != state.byte_length {
                return Err(format!(
                    "rpc_chunk 序列 {} 重组长度 {} ≠ 通告 {}",
                    state.chunk_id,
                    buf.len(),
                    state.byte_length
                ));
            }
            let s = String::from_utf8(buf).map_err(|_| "重组帧不是合法 UTF-8".to_string())?;
            let v: Value =
                serde_json::from_str(&s).map_err(|e| format!("重组帧 JSON 解析失败: {e}"))?;
            Ok(Some(v))
        } else {
            Ok(None)
        }
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        format!("{}…", &s[..n])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn b64(s: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(s)
    }

    #[test]
    fn 单片即完整帧() {
        let mut d = FrameDecoder::new();
        let line = format!(
            r#"{{"type":"rpc_chunk","chunkId":"c1","index":0,"count":1,"byteLength":13,"data":"{}"}}"#,
            b64(r#"{"type":"x"}"#)
        );
        // byteLength 故意写错，应报错
        assert!(d.decode_line(&line).is_err());
    }

    #[test]
    fn 多片重组按序拼接() {
        let mut d = FrameDecoder::new();
        let payload = r#"{"type":"response","command":"get_available_models","data":{"models":[]}}"#;
        let bytes = payload.as_bytes();
        let (a, b) = bytes.split_at(20);
        let mk = |i: usize, part: &[u8]| {
            format!(
                r#"{{"type":"rpc_chunk","chunkId":"rpc-9","index":{i},"count":2,"byteLength":{},"data":"{}"}}"#,
                bytes.len(),
                base64::engine::general_purpose::STANDARD.encode(part)
            )
        };
        assert!(d.decode_line(&mk(0, a)).unwrap().is_none());
        let done = d.decode_line(&mk(1, b)).unwrap().unwrap();
        assert_eq!(done["command"], json!("get_available_models"));
    }

    #[test]
    fn 拒绝交错序列() {
        let mut d = FrameDecoder::new();
        let mk = |id: &str, i: usize| {
            format!(
                r#"{{"type":"rpc_chunk","chunkId":"{id}","index":{i},"count":2,"byteLength":4,"data":"{}"}}"#,
                b64("abcd")
            )
        };
        assert!(d.decode_line(&mk("a", 0)).unwrap().is_none());
        assert!(d.decode_line(&mk("b", 1)).is_err());
    }

    #[test]
    fn 重组超限报错() {
        let mut d = FrameDecoder::new();
        d.max_reassembled = 8;
        let line = format!(
            r#"{{"type":"rpc_chunk","chunkId":"c","index":0,"count":1,"byteLength":100,"data":"{}"}}"#,
            b64("0123456789abcdef")
        );
        assert!(d.decode_line(&line).is_err());
    }

    #[test]
    fn ready_更新上限() {
        let mut d = FrameDecoder::new();
        let ready = json!({"type":"ready","maxReassembledFrameBytes":1024});
        d.apply_ready(&ready);
        assert_eq!(d.max_reassembled, 1024);
    }
}
