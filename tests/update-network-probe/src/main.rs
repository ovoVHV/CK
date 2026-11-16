use std::{time::{Duration, Instant, SystemTime, UNIX_EPOCH}, path::PathBuf};
#[path = "../../../desktop/apps/desktop/src-tauri/src/update_transport.rs"]
mod transport;

#[tokio::main]
async fn main() {
    let policy = ck_update_protocol::channel().unwrap();
    let output = std::env::args_os().nth(1).map(PathBuf::from).unwrap_or_else(|| "CK-update-network.json".into());
    let mut results = Vec::new();
    for mode in ["native-system-proxy", "rustls-system-proxy", "native-direct", "rustls-direct"] {
        let started = Instant::now();
        println!("Checking {mode} ...");
        let mut builder = reqwest::Client::builder().https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10)).timeout(Duration::from_secs(15))
            .user_agent("CK-update-network-diagnostic");
        if mode.starts_with("rustls") { builder = builder.use_rustls_tls(); }
        if mode.ends_with("direct") { builder = builder.no_proxy(); }
        let client = if mode == "native-system-proxy" {
            // Exercise the actual production updater implementation.
            transport::client(15, "CK-update-network-diagnostic")
        } else { builder.build() };
        let result = async {
            let mut response = client?.get(&policy.endpoint).header("Cache-Control", "no-cache").send().await?.error_for_status()?;
            let status = response.status().as_u16();
            let server_date = response.headers().get("date").and_then(|v|v.to_str().ok()).unwrap_or("").to_string();
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await? {
                if bytes.len() + chunk.len() > ck_update_protocol::MAX_MANIFEST_BYTES {
                    return Ok(serde_json::json!({"http":status,"error":"Manifest exceeds allowed size"}));
                }
                bytes.extend_from_slice(&chunk);
            }
            let verified = ck_update_protocol::verify_manifest(&bytes, &policy).map(|m|m.version);
            Ok::<_,reqwest::Error>(serde_json::json!({"http":status,"bytes":bytes.len(),"serverDate":server_date,"verified":verified}))
        }.await;
        let detail = match result {
            Ok(value) => value,
            Err(error) => serde_json::json!({"hint":transport::error_hint(&error),"errorChain":transport::error_details(&error),"timeout":error.is_timeout(),"connect":error.is_connect()})
        };
        let sample = serde_json::json!({"mode":mode,"ms":started.elapsed().as_millis(),"detail":detail});
        println!("{sample}"); results.push(sample);
    }
    let report = serde_json::json!({"schema":1,"localUnixSeconds":SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),"endpoint":policy.endpoint,"results":results,"installerDownloaded":false});
    match std::fs::write(&output, serde_json::to_vec_pretty(&report).unwrap()) {
        Ok(()) => println!("Saved: {}", output.display()),
        Err(error) => { eprintln!("Unable to save report: {error}"); std::process::exit(1); }
    }
}
