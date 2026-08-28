use futures_util::StreamExt;

#[derive(Debug, Clone, Copy)]
pub(crate) struct SseLimits {
    pub raw_stream_bytes: usize,
    pub pending_line_bytes: usize,
    pub event_count: usize,
    pub generated_content_bytes: usize,
    pub tool_call_count: usize,
    pub tool_name_bytes: usize,
    pub tool_arguments_per_call_bytes: usize,
    pub tool_arguments_total_bytes: usize,
}

pub(crate) const AGENT_SSE_LIMITS: SseLimits = SseLimits {
    raw_stream_bytes: 8 * 1024 * 1024,
    pending_line_bytes: 256 * 1024,
    event_count: 4_096,
    generated_content_bytes: 4 * 1024 * 1024,
    tool_call_count: 64,
    tool_name_bytes: 256,
    tool_arguments_per_call_bytes: 512 * 1024,
    tool_arguments_total_bytes: 1024 * 1024,
};

pub(crate) const EXTENSION_REPAIR_SSE_LIMITS: SseLimits = SseLimits {
    raw_stream_bytes: 4 * 1024 * 1024,
    pending_line_bytes: 256 * 1024,
    event_count: 2_048,
    generated_content_bytes: 1024 * 1024,
    tool_call_count: 0,
    tool_name_bytes: 0,
    tool_arguments_per_call_bytes: 0,
    tool_arguments_total_bytes: 0,
};

pub(crate) const ERROR_RESPONSE_MAX_BYTES: usize = 256 * 1024;

#[derive(Debug)]
pub(crate) struct SseBudget {
    limits: SseLimits,
    raw_stream_bytes: usize,
    event_count: usize,
    generated_content_bytes: usize,
    tool_call_count: usize,
    tool_arguments_total_bytes: usize,
}

impl SseBudget {
    pub(crate) fn new(limits: SseLimits) -> Self {
        Self {
            limits,
            raw_stream_bytes: 0,
            event_count: 0,
            generated_content_bytes: 0,
            tool_call_count: 0,
            tool_arguments_total_bytes: 0,
        }
    }

    pub(crate) fn observe_chunk(&mut self, bytes: usize) -> Result<(), String> {
        self.raw_stream_bytes = self
            .raw_stream_bytes
            .checked_add(bytes)
            .ok_or_else(|| "SSE stream byte counter overflowed".to_string())?;
        ensure_within(
            "SSE response bytes",
            self.raw_stream_bytes,
            self.limits.raw_stream_bytes,
        )
    }

    pub(crate) fn append_pending_text(
        &self,
        target: &mut String,
        text: &str,
    ) -> Result<(), String> {
        let next = target
            .len()
            .checked_add(text.len())
            .ok_or_else(|| "SSE pending-line byte counter overflowed".to_string())?;
        ensure_within("SSE pending line", next, self.limits.pending_line_bytes)?;
        target.push_str(text);
        Ok(())
    }

    pub(crate) fn record_event(&mut self) -> Result<(), String> {
        self.event_count = self
            .event_count
            .checked_add(1)
            .ok_or_else(|| "SSE event counter overflowed".to_string())?;
        ensure_within("SSE event count", self.event_count, self.limits.event_count)
    }

    pub(crate) fn event_count(&self) -> usize {
        self.event_count
    }

    /// Content and reasoning share one budget. A provider cannot evade the
    /// response limit by moving an unlimited answer into a reasoning field.
    pub(crate) fn append_generated(
        &mut self,
        target: &mut String,
        delta: &str,
        label: &str,
    ) -> Result<(), String> {
        let next_total = self
            .generated_content_bytes
            .checked_add(delta.len())
            .ok_or_else(|| format!("{label} byte counter overflowed"))?;
        ensure_within(
            "SSE generated content",
            next_total,
            self.limits.generated_content_bytes,
        )?;
        self.generated_content_bytes = next_total;
        target.push_str(delta);
        Ok(())
    }

    pub(crate) fn record_tool_call(&mut self) -> Result<(), String> {
        self.tool_call_count = self
            .tool_call_count
            .checked_add(1)
            .ok_or_else(|| "SSE tool-call counter overflowed".to_string())?;
        ensure_within(
            "SSE tool-call count",
            self.tool_call_count,
            self.limits.tool_call_count,
        )
    }

    pub(crate) fn append_tool_name(&self, target: &mut String, delta: &str) -> Result<(), String> {
        let next = target
            .len()
            .checked_add(delta.len())
            .ok_or_else(|| "SSE tool name byte counter overflowed".to_string())?;
        ensure_within("SSE tool name", next, self.limits.tool_name_bytes)?;
        target.push_str(delta);
        Ok(())
    }

    pub(crate) fn append_tool_arguments(
        &mut self,
        target: &mut String,
        delta: &str,
    ) -> Result<(), String> {
        let next_call = target
            .len()
            .checked_add(delta.len())
            .ok_or_else(|| "SSE tool arguments byte counter overflowed".to_string())?;
        ensure_within(
            "SSE tool arguments for one call",
            next_call,
            self.limits.tool_arguments_per_call_bytes,
        )?;
        let next_total = self
            .tool_arguments_total_bytes
            .checked_add(delta.len())
            .ok_or_else(|| "SSE total tool arguments byte counter overflowed".to_string())?;
        ensure_within(
            "SSE total tool arguments",
            next_total,
            self.limits.tool_arguments_total_bytes,
        )?;
        self.tool_arguments_total_bytes = next_total;
        target.push_str(delta);
        Ok(())
    }
}

fn ensure_within(label: &str, actual: usize, maximum: usize) -> Result<(), String> {
    if actual <= maximum {
        return Ok(());
    }
    Err(format!(
        "{label} exceeded the hard limit ({actual} > {maximum} bytes/items); CK stopped reading the endpoint before applying any truncated result"
    ))
}

pub(crate) async fn read_response_text_bounded(
    response: reqwest::Response,
    maximum_bytes: usize,
    label: &str,
) -> Result<String, String> {
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::<u8>::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("Failed to read {label}: {error}"))?;
        let next = bytes
            .len()
            .checked_add(chunk.len())
            .ok_or_else(|| format!("{label} byte counter overflowed"))?;
        ensure_within(label, next, maximum_bytes)?;
        bytes.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_LIMITS: SseLimits = SseLimits {
        raw_stream_bytes: 8,
        pending_line_bytes: 6,
        event_count: 2,
        generated_content_bytes: 7,
        tool_call_count: 2,
        tool_name_bytes: 5,
        tool_arguments_per_call_bytes: 5,
        tool_arguments_total_bytes: 7,
    };

    #[test]
    fn raw_stream_pending_line_and_event_limits_are_fail_closed() {
        let mut budget = SseBudget::new(TEST_LIMITS);
        assert!(budget.observe_chunk(8).is_ok());
        assert!(budget.observe_chunk(1).unwrap_err().contains("hard limit"));

        let mut pending = String::new();
        assert!(budget.append_pending_text(&mut pending, "123456").is_ok());
        assert!(
            budget
                .append_pending_text(&mut pending, "7")
                .unwrap_err()
                .contains("pending line")
        );

        let mut events = SseBudget::new(TEST_LIMITS);
        assert!(events.record_event().is_ok());
        assert!(events.record_event().is_ok());
        assert!(events.record_event().unwrap_err().contains("event count"));
    }

    #[test]
    fn content_and_reasoning_share_one_accumulation_budget() {
        let mut budget = SseBudget::new(TEST_LIMITS);
        let mut content = String::new();
        let mut reasoning = String::new();
        assert!(
            budget
                .append_generated(&mut content, "1234", "content")
                .is_ok()
        );
        assert!(
            budget
                .append_generated(&mut reasoning, "567", "reasoning")
                .is_ok()
        );
        assert!(
            budget
                .append_generated(&mut reasoning, "8", "reasoning")
                .unwrap_err()
                .contains("generated content")
        );
        assert_eq!(content, "1234");
        assert_eq!(reasoning, "567");
    }

    #[test]
    fn tool_count_names_and_arguments_have_independent_hard_limits() {
        let mut budget = SseBudget::new(TEST_LIMITS);
        assert!(budget.record_tool_call().is_ok());
        assert!(budget.record_tool_call().is_ok());
        assert!(
            budget
                .record_tool_call()
                .unwrap_err()
                .contains("tool-call count")
        );

        let mut name = String::new();
        assert!(budget.append_tool_name(&mut name, "abcde").is_ok());
        assert!(
            budget
                .append_tool_name(&mut name, "f")
                .unwrap_err()
                .contains("tool name")
        );

        let mut first = String::new();
        let mut second = String::new();
        assert!(budget.append_tool_arguments(&mut first, "12345").is_ok());
        assert!(budget.append_tool_arguments(&mut second, "67").is_ok());
        assert!(
            budget
                .append_tool_arguments(&mut second, "8")
                .unwrap_err()
                .contains("total tool arguments")
        );
        assert_eq!(first, "12345");
        assert_eq!(second, "67");
    }
}
