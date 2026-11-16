//! Preserve the deployed HTTPS transport while exposing its underlying errors.
//! Mainland probes failed before TLS; switching TLS cannot repair that route.
use std::{error::Error, time::Duration};

pub fn client(timeout: u64, user_agent: &str) -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(timeout))
        .user_agent(user_agent)
        .build()
}

// Do not log proxy settings, credentials, response bodies or signed manifests.
// reqwest's Display omits its source, which is where DNS/TLS/socket failures live.
pub fn error_details(error: &reqwest::Error) -> String {
    let mut messages = Vec::new();
    let mut source = error.source();
    while let Some(cause) = source {
        let message = cause.to_string();
        if messages.last() != Some(&message) { messages.push(message); }
        source = cause.source();
        if messages.len() >= 8 { break; }
    }
    if messages.is_empty() { messages.push(error.to_string()); }
    messages.join(" → ").chars().take(1600).collect()
}

pub fn error_hint(error: &reqwest::Error) -> &'static str {
    let details = error_details(error).to_ascii_lowercase();
    if details.contains("certificate") || details.contains("cert") || details.contains("证书") {
        "HTTPS 证书验证失败；请检查系统日期时间及网络证书设置"
    } else if details.contains("dns") || details.contains("resolve") || details.contains("11001") || details.contains("解析") {
        "无法解析更新服务器域名；请检查当前网络的 DNS 设置"
    } else if error.is_timeout() {
        "连接更新服务器超时；请稍后重试，或检查代理连接"
    } else if details.contains("proxy") || details.contains("tunnel") {
        "无法通过当前代理连接更新服务器；请检查系统代理设置"
    } else if error.is_connect() {
        "无法连接更新服务器；请检查网络、代理或防火墙设置"
    } else {
        "更新连接中断，请重试"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn refuses_plain_http() {
        let error = client(2, "CK-test").unwrap().get("http://ckswitch.site/").send().await.unwrap_err();
        assert!(error.is_builder());
    }

    #[tokio::test]
    async fn preserves_socket_failure_details() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let error = client(2, "CK-test").unwrap().get(format!("https://{address}/")).send().await.unwrap_err();
        let details = error_details(&error);
        assert!(!details.is_empty());
        assert!(details != error.to_string(), "the source must survive the reqwest wrapper");
    }
}
