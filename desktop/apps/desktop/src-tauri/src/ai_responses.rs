use super::{
    ai_utf8_stream::Utf8Stream, bounded_sse, AgentLlmDeltaPayload, GlmChatResult, LlmToolCall,
    LlmToolCallFunction,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use tauri::{AppHandle, Emitter};

pub(super) fn selected(protocol: Option<&str>) -> Result<bool, String> {
    match protocol {
        None | Some("chat") => Ok(false),
        Some("responses") => Ok(true),
        _ => Err("不支持的 API 协议".into()),
    }
}

pub(super) fn base_path(path: &str) -> &str {
    let path = path.trim_end_matches('/');
    path.strip_suffix("/chat/completions")
        .or_else(|| path.strip_suffix("/responses"))
        .unwrap_or(path)
}

// Only these fields may be replayed as reasoning, never arbitrary output items.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub(super) struct Reasoning {
    id: String,
    encrypted_content: String,
    #[serde(default)]
    summary: Vec<Summary>,
    #[serde(rename = "type")]
    kind: ReasoningKind,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
enum ReasoningKind {
    #[serde(rename = "reasoning")]
    Reasoning,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
pub(super) struct Summary {
    #[serde(rename = "type")]
    kind: SummaryKind,
    text: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
enum SummaryKind {
    #[serde(rename = "summary_text")]
    Text,
}

pub(super) fn request(chat: &Value, effort: Option<&str>) -> Result<Value, String> {
    let mut input = Vec::new();
    for m in chat["messages"].as_array().ok_or("missing messages")? {
        let role = m["role"].as_str().ok_or("missing message role")?;
        if role == "tool" {
            input.push(json!({"type":"function_call_output","call_id":m["tool_call_id"].as_str().ok_or("missing call ID")?,"output":m["content"]}));
            continue;
        }
        if let Some(items) = m["responseReasoning"].as_array() {
            input.extend(items.iter().cloned());
        }
        if let Some(parts) = m["content"].as_array() {
            let mut content = Vec::new();
            for p in parts {
                content.push(match p["type"].as_str() {
                    Some("text") => json!({"type":"input_text","text":p["text"]}),
                    Some("image_url") => {
                        json!({"type":"input_image","image_url":p["image_url"]["url"]})
                    }
                    _ => return Err("不支持的 Responses 输入类型".into()),
                });
            }
            input.push(json!({"role":role,"content":content}));
        } else if let Some(text) = m["content"].as_str().filter(|s| !s.is_empty()) {
            input.push(json!({"role":role,"content":text}));
        }
        if let Some(calls) = m["tool_calls"].as_array() {
            for call in calls {
                input.push(json!({"type":"function_call","call_id":call["id"],"name":call["function"]["name"],"arguments":call["function"]["arguments"]}));
            }
        }
    }
    let mut body = json!({"model":chat["model"],"stream":chat["stream"],"input":input,"store":false,"include":["reasoning.encrypted_content"]});
    if let Some(limit) = chat.get("max_tokens") {
        body["max_output_tokens"] = limit.clone();
    }
    match effort.unwrap_or("auto") {
        "auto" => {}
        "max" => body["reasoning"] = json!({"effort":"xhigh"}),
        e @ ("none" | "low" | "medium" | "high") => body["reasoning"] = json!({"effort":e}),
        _ => return Err("思考强度无效".into()),
    }
    if let Some(tools) = chat["tools"].as_array() {
        let mut out = Vec::new();
        for t in tools {
            if t["type"] != "function" {
                return Err("仅支持 CK 函数工具".into());
            }
            let mut f = t["function"].clone();
            f["type"] = json!("function");
            // Preserve CK's optional fields; Responses otherwise infers a strict schema.
            f["strict"] = json!(false);
            out.push(f);
        }
        body["tools"] = json!(out);
    }
    if let Some(choice) = chat.get("tool_choice") {
        body["tool_choice"] = if choice["type"] == "function" {
            json!({"type":"function","name":choice["function"]["name"]})
        } else {
            choice.clone()
        };
    }
    Ok(body)
}

fn failure(r: &Value) -> String {
    let msg = r["error"]["message"]
        .as_str()
        .or(r["message"].as_str())
        .or(r["incomplete_details"]["reason"].as_str())
        .unwrap_or("未收到完整结果");
    format!("Responses: {}", msg.chars().take(500).collect::<String>())
}

pub(super) fn result(r: &Value) -> Result<GlmChatResult, String> {
    let truncated =
        r["status"] == "incomplete" && r["incomplete_details"]["reason"] == "max_output_tokens";
    if r["status"] != "completed" && !truncated {
        return Err(failure(r));
    }
    let mut text = String::new();
    let mut calls = Vec::new();
    let mut ids = HashSet::new();
    let mut reasoning = Vec::new();
    let mut budget = bounded_sse::SseBudget::new(bounded_sse::AGENT_SSE_LIMITS);
    if !truncated {
        for item in r["output"].as_array().ok_or("Responses 缺少输出")? {
            match item["type"].as_str() {
                Some("message") => {
                    for part in item["content"].as_array().ok_or("Responses 消息缺少内容")? {
                        if let Some(s) = part["text"].as_str().or(part["refusal"].as_str()) {
                            budget.append_generated(&mut text, s, "Responses text")?;
                        }
                    }
                }
                Some("function_call") => {
                    if item.get("status").is_some_and(|s| s != "completed") {
                        return Err("模型工具调用尚未完成".into());
                    }
                    let id = item["call_id"]
                        .as_str()
                        .filter(|s| !s.is_empty() && s.len() <= 512 && ids.insert(*s))
                        .ok_or("工具调用编号缺失或重复")?;
                    budget.record_tool_call()?;
                    let mut name = String::new();
                    let mut arguments = String::new();
                    budget.append_tool_name(
                        &mut name,
                        item["name"]
                            .as_str()
                            .filter(|s| !s.is_empty())
                            .ok_or("工具名称缺失")?,
                    )?;
                    budget.append_tool_arguments(
                        &mut arguments,
                        item["arguments"].as_str().ok_or("工具参数缺失")?,
                    )?;
                    if !serde_json::from_str::<Value>(&arguments).is_ok_and(|v| v.is_object()) {
                        return Err("工具参数不是完整 JSON 对象".into());
                    }
                    calls.push(LlmToolCall {
                        id: id.into(),
                        call_type: "function".into(),
                        function: LlmToolCallFunction { name, arguments },
                    });
                }
                Some("reasoning") if item["encrypted_content"].is_string() => {
                    reasoning.push(
                        serde_json::from_value::<Reasoning>(item.clone())
                            .map_err(|_| "Responses 思考记录格式无效")?,
                    );
                }
                _ => {}
            }
        }
        if text.is_empty() && calls.is_empty() {
            return Err("Responses 没有返回文字或工具调用".into());
        }
    }
    let finish = if truncated {
        "length"
    } else if !calls.is_empty() {
        "tool_calls"
    } else {
        "stop"
    };
    let tokens = |k: &str| r["usage"][k].as_u64().and_then(|n| u32::try_from(n).ok());
    Ok(GlmChatResult {
        model: r["model"].as_str().unwrap_or_default().to_owned(),
        content: text,
        reasoning_content: None,
        response_reasoning: reasoning,
        finish_reason: Some(finish.into()),
        prompt_tokens: tokens("input_tokens"),
        completion_tokens: tokens("output_tokens"),
        total_tokens: tokens("total_tokens"),
        raw_json: json!({"protocol":"responses","finish_reason":finish}).to_string(),
        tool_calls: (!calls.is_empty()).then_some(calls),
    })
}

pub(super) async fn stream(
    response: reqwest::Response,
    app: &AppHandle,
    run: &str,
) -> Result<GlmChatResult, String> {
    let mut bytes = response.bytes_stream();
    let mut utf8 = Utf8Stream::default();
    let mut pending = String::new();
    let mut budget = bounded_sse::SseBudget::new(bounded_sse::AGENT_SSE_LIMITS);
    let mut data = String::new();
    while let Some(chunk) = bytes.next().await {
        let chunk = chunk.map_err(|e| format!("Responses 连接中断：{e}"))?;
        budget.observe_chunk(chunk.len())?;
        let decoded = utf8.push(&chunk)?;
        for segment in decoded.split_inclusive('\n') {
            pending.push_str(segment);
            if !segment.ends_with('\n') {
                continue;
            }
            let line = pending.trim_end_matches(['\r', '\n']);
            if let Some(part) = line.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(part.strip_prefix(' ').unwrap_or(part));
            }
            let boundary = line.is_empty();
            pending.clear();
            if !boundary || data.is_empty() {
                continue;
            }
            budget.record_event()?;
            if data == "[DONE]" {
                return Err("Responses 未确认完成，工具未执行".into());
            }
            let e: Value = serde_json::from_str(&data).map_err(|_| "Responses 事件格式无效")?;
            data.clear();
            match e["type"].as_str() {
                Some("response.output_text.delta" | "response.refusal.delta") => {
                    if let Some(delta) = e["delta"].as_str() {
                        let _ = app.emit(
                            "agent-llm-delta",
                            AgentLlmDeltaPayload {
                                run_id: run.into(),
                                delta: delta.into(),
                                reasoning_delta: None,
                                done: false,
                                model: None,
                                finish_reason: None,
                                prompt_tokens: None,
                                completion_tokens: None,
                                total_tokens: None,
                            },
                        );
                    }
                }
                Some("response.completed" | "response.incomplete") => {
                    let r = result(&e["response"])?;
                    let _ = app.emit(
                        "agent-llm-delta",
                        AgentLlmDeltaPayload {
                            run_id: run.into(),
                            delta: String::new(),
                            reasoning_delta: None,
                            done: true,
                            model: Some(r.model.clone()),
                            finish_reason: r.finish_reason.clone(),
                            prompt_tokens: r.prompt_tokens,
                            completion_tokens: r.completion_tokens,
                            total_tokens: r.total_tokens,
                        },
                    );
                    return Ok(r);
                }
                Some("error") => return Err(failure(&e)),
                Some("response.failed") => return Err(failure(&e["response"])),
                _ => {}
            }
        }
    }
    utf8.finish()?;
    Err("Responses 连接在确认完成前中断，工具未执行".into())
}
