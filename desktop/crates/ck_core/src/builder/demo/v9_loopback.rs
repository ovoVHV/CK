use super::*;

// This client only speaks to the desktop's own controller. Never forward
// the session secret to a redirect, a configured proxy, or a non-loopback IP.
pub(super) struct Endpoint {
    client: reqwest::Client,
    port: u16,
    token: String,
}

impl Endpoint {
    pub(super) fn new(config: &Config) -> Result<Self> {
        anyhow::ensure!(config.port >= 1024 && config.token.len() == 64
            && config.token.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "Invalid local controller endpoint");
        let client = reqwest::Client::builder().no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(3)).timeout(Duration::from_secs(1000)).build()?;
        Ok(Self {client, port:config.port, token:config.token.clone()})
    }
    fn post(&self, route: &str) -> reqwest::RequestBuilder {
        self.client.post(format!("http://127.0.0.1:{}/{route}", self.port)).bearer_auth(&self.token)
    }
    pub(super) async fn ack(&self, id: &str, sha: &str) -> Result<()> {
        let mut response = self.post("ack").timeout(Duration::from_secs(5))
            .json(&json!({"requestId":id,"sourceSha256":sha,"success":true})).send().await?.error_for_status()?;
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            anyhow::ensure!(body.len()+chunk.len() <= 4096, "Oversized export acknowledgement");
            body.extend_from_slice(&chunk);
        }
        anyhow::ensure!(serde_json::from_slice::<Value>(&body)?["success"] == true, "V9 export lease acknowledgement failed");
        Ok(())
    }
    pub(super) async fn cancel(&self, id: &str) {
        let _ = self.post("cancel").timeout(Duration::from_secs(5)).json(&json!({"requestId":id})).send().await;
    }
    pub(super) async fn build<L: Fn(String)>(&self, request: &Value, source: &str, log: &L) -> Result<(Value,String)> {
        let id = request["requestId"].as_str().context("Missing request identity")?;
        let mut res = match self.post("build").header("Accept","application/x-ndjson")
            .header("X-CK-Diagnostics","1").json(&json!({"protocolVersion":1,"request":request,"source":source})).send().await {
            Ok(res) => res,
            Err(error) => {
                // Only an OS-level refused connection proves no job was submitted.
                let mut cause = std::error::Error::source(&error);
                while let Some(e) = cause {
                    if e.downcast_ref::<std::io::Error>().is_some_and(|io| io.kind()==std::io::ErrorKind::ConnectionRefused) {
                        return Ok((json!({"requestId":id,"fqbn":request["fqbn"],"sourceSha256":request["sourceSha256"],
                            "protocolVersion":1,"engineVersion":super::HOST_ENGINE_VERSION,"success":false,
                            "error":{"code":"ENGINE_UNAVAILABLE","fallbackSafe":true,"message":"Local controller refused the connection"}}),String::new()));
                    }
                    cause=e.source();
                }
                return Err(error.into());
            }
        };
        anyhow::ensure!(res.status().is_success() &&
            res.headers().get("content-type").and_then(|v|v.to_str().ok())==Some("application/x-ndjson"), "Invalid V9 controller response");
        let mut line=Vec::new(); let mut total=0usize; let mut result=None;
        while let Some(chunk)=res.chunk().await? {
            total+=chunk.len(); anyhow::ensure!(total<=32*1024*1024,"Oversized V9 build response");
            for part in chunk.split_inclusive(|b| *b==b'\n') {
                line.extend_from_slice(part);
                if part.last()!=Some(&b'\n') {continue;}
                let mut frame:Value=serde_json::from_slice(&line)?; line.clear();
                anyhow::ensure!(frame["requestId"]==id && result.is_none(), "Unexpected V9 frame identity/order");
                match frame["type"].as_str() {
                    Some("activity") => {
                        let messages=frame["messages"].as_array().context("Missing V9 activity")?;
                        anyhow::ensure!(messages.len()<=64, "Oversized V9 activity batch");
                        for m in messages {
                            let text=m.as_str().context("Invalid V9 activity")?;
                            anyhow::ensure!(text.len()<=2048, "Oversized V9 activity message");
                            log(format!("[V9 进度] {}\n",text.replace(['\n','\r']," ")));
                        }
                    }
                    Some("result") => {
                        let text=frame["diagnostics"].as_str().unwrap_or("");
                        anyhow::ensure!(text.len()<=256*1024,"Oversized V9 build diagnostics");
                        let text=text.to_owned();
                        result=Some((frame["receipt"].take(),text));
                    }
                    _ => anyhow::bail!("Unknown V9 build stream frame"),
                }
            }
        }
        anyhow::ensure!(line.is_empty(), "Truncated V9 build stream");
        result.context("Incomplete V9 build stream")
    }
}
