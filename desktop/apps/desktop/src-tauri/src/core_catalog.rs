//! Read-only Board Manager catalog. Browsing versions must not mutate the CLI
//! configuration, installed packages, or the build engine's input identity.
use serde::{Deserialize, Serialize};
use std::{cmp::Ordering, collections::BTreeSet, time::{Duration, SystemTime, UNIX_EPOCH}};

const MAX_INDEX_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Serialize)]
pub struct CoreVersions {
    pub core_id: String,
    pub index_url: String,
    pub versions: Vec<String>,
    pub latest: Option<String>,
    pub checked_at: u64,
}

#[derive(Deserialize)]
struct Index { packages: Vec<Package> }
#[derive(Deserialize)]
struct Package {
    name: String,
    #[serde(default)]
    platforms: Vec<Platform>,
}
#[derive(Deserialize)]
struct Platform { architecture: String, version: String }

fn compare_versions(left: &str, right: &str) -> Ordering {
    match (semver::Version::parse(left), semver::Version::parse(right)) {
        (Ok(a), Ok(b)) => a.cmp(&b).then_with(|| left.cmp(right)),
        (Ok(_), Err(_)) => Ordering::Greater,
        (Err(_), Ok(_)) => Ordering::Less,
        _ => left.cmp(right),
    }
}

fn stable(version: &str) -> bool {
    semver::Version::parse(version).is_ok_and(|v| v.pre.is_empty() || v.pre.as_str() == "cn")
}

fn parse_index(core_id: &str, bytes: &[u8]) -> Result<Vec<String>, String> {
    let (vendor, architecture) = core_id.split_once(':').ok_or("Invalid Core ID (vendor:architecture required)")?;
    if vendor.is_empty() || architecture.is_empty() || architecture.contains(':') {
        return Err("Invalid Core ID (vendor:architecture required)".into());
    }
    let index: Index = serde_json::from_slice(bytes).map_err(|e| format!("Invalid Board Manager JSON: {e}"))?;
    let mut versions = BTreeSet::new();
    for package in index.packages.into_iter().filter(|p| p.name == vendor) {
        for platform in package.platforms.into_iter().filter(|p| p.architecture == architecture) {
            // Keep the exact index version for installation; never invent a version.
            if !platform.version.is_empty() && platform.version.len() <= 128
                && !platform.version.chars().any(|c| c.is_whitespace() || c.is_control() || c == '@') {
                versions.insert(platform.version);
            }
        }
    }
    let mut versions: Vec<_> = versions.into_iter().collect();
    versions.sort_by(|a, b| compare_versions(b, a));
    if versions.is_empty() { return Err(format!("No versions for {core_id} in this package index")); }
    Ok(versions)
}

pub async fn fetch(core_id: String, index_url: String) -> Result<CoreVersions, String> {
    let index_url = index_url.trim().to_string();
    let url = reqwest::Url::parse(&index_url).map_err(|_| "Invalid package index URL")?;
    if !matches!(url.scheme(), "https" | "http") || !url.username().is_empty() || url.password().is_some() {
        return Err("Package indexes require an HTTP(S) URL without credentials".into());
    }
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::limited(8))
        .user_agent("CK-Core-Catalog/1");
    if url.host_str().is_some_and(|host| host == "localhost" || host.trim_matches(['[', ']']).parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())) {
        builder = builder.no_proxy();
    }
    let client = builder.build().map_err(|e| e.to_string())?;
    let mut response = client.get(url).header(reqwest::header::CACHE_CONTROL, "no-cache")
        .send().await.map_err(|e| format!("Package index request failed: {e}"))?
        .error_for_status().map_err(|e| format!("Package index response failed: {e}"))?;
    if response.content_length().is_some_and(|n| n > MAX_INDEX_BYTES as u64) {
        return Err("Package index exceeds 32 MiB".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("Package index download interrupted: {e}"))? {
        if bytes.len() + chunk.len() > MAX_INDEX_BYTES { return Err("Package index exceeds 32 MiB".into()); }
        bytes.extend_from_slice(&chunk);
    }
    let versions = parse_index(&core_id, &bytes)?;
    let latest = versions.iter().find(|v| stable(v)).cloned();
    Ok(CoreVersions { core_id, index_url, versions, latest,
        checked_at: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selects_exact_vendor_and_arch_and_sorts_numeric_versions() {
        let bytes = br#"{"packages":[{"name":"esp32","platforms":[
            {"architecture":"esp32","version":"3.3.6"},
            {"architecture":"esp32","version":"3.3.13"},
            {"architecture":"esp32","version":"3.3.13"},
            {"architecture":"esp32","version":"4.0.0-rc1"},
            {"architecture":"other","version":"9.0.0"}]},
            {"name":"other","platforms":[{"architecture":"esp32","version":"8.0.0"}]}]}"#;
        let versions = parse_index("esp32:esp32", bytes).unwrap();
        assert_eq!(versions, ["4.0.0-rc1", "3.3.13", "3.3.6"]);
        assert_eq!(versions.iter().find(|v| stable(v)).unwrap(), "3.3.13");
        assert!(stable("3.3.13-cn"));
        assert!(!stable("4.0.0-beta.1"));
    }
    #[test]
    fn rejects_bad_or_unrelated_indexes() {
        for bytes in [b"<html>login</html>".as_slice(), br#"{"packages":[]}"#, br#"{}"#] {
            assert!(parse_index("arduino:avr", bytes).is_err());
        }
        assert!(parse_index("not-a-core", br#"{"packages":[]}"#).is_err());
    }
    #[tokio::test]
    async fn fetches_redirect_and_rejects_http_failure() {
        use std::io::{Read, Write};
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = server.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            for (status, body, extra) in [
                ("302 Found", "", "Location: /index.json\r\n"),
                ("200 OK", r#"{"packages":[{"name":"arduino","platforms":[{"architecture":"avr","version":"1.8.8"}]}]}"#, ""),
                ("503 Unavailable", "unavailable", ""),
                ("200 OK", "login required", ""),
            ] {
                let (mut socket, _) = server.accept().unwrap();
                let mut buffer = [0; 4096]; let _ = socket.read(&mut buffer);
                write!(socket, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}", body.len()).unwrap();
            }
        });
        let url = format!("http://{address}/start");
        let result = fetch("arduino:avr".into(), url.clone()).await.unwrap();
        assert_eq!(result.latest.as_deref(), Some("1.8.8"));
        assert_eq!(result.index_url, url);
        assert!(fetch("arduino:avr".into(), url.clone()).await.unwrap_err().contains("503"));
        assert!(fetch("arduino:avr".into(), url).await.unwrap_err().contains("JSON"));
        worker.join().unwrap();
        assert!(fetch("arduino:avr".into(), "file:///index.json".into()).await.is_err());
    }
}
