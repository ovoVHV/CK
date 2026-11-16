/// HTTP chunks can split a Chinese character or a JSON tool argument anywhere.
/// Keep only the incomplete final UTF-8 code point between chunks; never replace
/// it with U+FFFD, which could silently change a field value in a proposal.
#[derive(Default)]
pub(crate) struct Utf8Stream {
    pending: Vec<u8>,
}
impl Utf8Stream {
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Result<String, String> {
        self.pending.extend_from_slice(chunk);
        let valid = match std::str::from_utf8(&self.pending) {
            Ok(_) => self.pending.len(),
            Err(error) if error.error_len().is_none() => error.valid_up_to(),
            Err(_) => return Err("AI stream contained invalid UTF-8; response was not applied".to_string()),
        };
        let text = std::str::from_utf8(&self.pending[..valid]).unwrap().to_string();
        self.pending.drain(..valid);
        Ok(text)
    }
    pub(crate) fn finish(&self) -> Result<(), String> {
        if self.pending.is_empty() { Ok(()) }
        else { Err("AI stream ended inside a UTF-8 character; response was not applied".to_string()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chinese_and_emoji_survive_every_byte_boundary() {
        let text = "data: {\"arguments\":\"把等待改成两秒 🔧\"}\n\n";
        for split in 0..=text.len() {
            let mut stream = Utf8Stream::default();
            let a = stream.push(&text.as_bytes()[..split]).unwrap();
            let b = stream.push(&text.as_bytes()[split..]).unwrap();
            stream.finish().unwrap();
            assert_eq!(a + &b, text);
        }
        let mut stream = Utf8Stream::default();
        let mut result = String::new();
        for byte in text.as_bytes() { result.push_str(&stream.push(&[*byte]).unwrap()); }
        stream.finish().unwrap();
        assert_eq!(result, text);
    }
    #[test]
    fn corrupt_or_incomplete_text_is_rejected() {
        assert!(Utf8Stream::default().push(&[0xff]).is_err());
        let mut stream = Utf8Stream::default();
        assert_eq!(stream.push(&[0xe4]).unwrap(), "");
        assert!(stream.finish().is_err());
    }
}
