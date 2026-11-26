use std::{fs::File, io::Read, path::Path};
use ring::signature::{UnparsedPublicKey, ED25519};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;
pub const MAX_INSTALLER_BYTES: u64 = 512 * 1024 * 1024;
pub const APP_ID: &str = "ck-build-engine-v91";
pub const PACKAGE_MARKER: &str = "CK-V91-alpha-current-user";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Channel {
    pub endpoint: String,
    pub download_prefix: String,
    pub public_key: String,
    pub channel: String,
}
pub fn channel() -> Result<Channel, String> {
    serde_json::from_str(include_str!("../channel.json")).map_err(|e| e.to_string())
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema: u32,
    pub app: String,
    pub channel: String,
    pub target: String,
    pub version: String,
    pub notes: String,
    pub published_at: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope { pub payload: String, pub signature: String }

pub fn verify_manifest(bytes: &[u8], policy: &Channel) -> Result<Manifest, String> {
    if bytes.len() > MAX_MANIFEST_BYTES { return Err("更新清单过大".into()); }
    let envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| "更新清单格式错误")?;
    let key = hex::decode(&policy.public_key).map_err(|_| "更新公钥格式错误")?;
    let signature = hex::decode(&envelope.signature).map_err(|_| "更新签名格式错误")?;
    UnparsedPublicKey::new(&ED25519, key).verify(envelope.payload.as_bytes(), &signature)
        .map_err(|_| "更新签名验证失败，未下载或运行安装包")?;
    let manifest: Manifest = serde_json::from_str(&envelope.payload).map_err(|_| "更新内容格式错误")?;
    let version = semver::Version::parse(&manifest.version).map_err(|_| "更新版本号无效")?;
    if manifest.schema != 1 || manifest.app != APP_ID || manifest.target != "windows-x86_64"
        || manifest.channel != policy.channel || !version.build.is_empty()
        || (policy.channel == "v1" && (version.major != 1 || !version.pre.is_empty()))
        || manifest.size == 0 || manifest.size > MAX_INSTALLER_BYTES
        || manifest.sha256.len() != 64 || hex::decode(&manifest.sha256).map_or(true, |b| b.len() != 32)
        || manifest.notes.len() > 24 * 1024 {
        return Err("更新内容与当前产品或平台不匹配".into());
    }
    let expected_url = format!("{}{}/CK-V{}-Setup-x64.exe", policy.download_prefix, manifest.version, manifest.version);
    if !policy.download_prefix.starts_with("https://") || manifest.url != expected_url {
        return Err("安装包下载地址未获授权".into());
    }
    Ok(manifest)
}

pub fn is_newer(manifest: &Manifest, current: &str) -> Result<bool, String> {
    let current = semver::Version::parse(current).map_err(|_| "当前版本号无效")?;
    let next = semver::Version::parse(&manifest.version).map_err(|_| "更新版本号无效")?;
    Ok(next > current)
}

// Kept open while the installer runs. On Windows this denies write/delete so
// the bytes we authenticated cannot be replaced between validation and launch.
pub fn open_verified_package(path: &Path, manifest: &Manifest) -> Result<File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)] {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1); // FILE_SHARE_READ
    }
    let mut file = options.open(path).map_err(|e| format!("无法读取安装包：{e}"))?;
    if file.metadata().map_err(|e| e.to_string())?.len() != manifest.size { return Err("安装包大小不符，请重新下载".into()); }
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        hash.update(&buffer[..n]);
    }
    if hex::encode(hash.finalize()) != manifest.sha256.to_ascii_lowercase() { return Err("安装包校验失败，请重新下载".into()); }
    Ok(file)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallRequest {
    pub schema: u32,
    pub install_root: String,
    pub installer: String,
    pub envelope: String,
    pub current_version: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};
    fn fixture() -> (Channel, Manifest, Ed25519KeyPair) {
        let key = Ed25519KeyPair::from_seed_unchecked(&[7; 32]).unwrap();
        let policy = Channel { endpoint: "https://example.test/latest.json".into(), download_prefix: "https://example.test/releases/".into(), public_key: hex::encode(key.public_key().as_ref()), channel: "preview".into() };
        let m = Manifest { schema: 1, app: APP_ID.into(), channel: "preview".into(), target: "windows-x86_64".into(), version: "9.1.0-alpha.24".into(), notes: "中文说明".into(), published_at: "2026-11-08".into(), url: "https://example.test/releases/9.1.0-alpha.24/CK-V9.1.0-alpha.24-Setup-x64.exe".into(), size: 3, sha256: hex::encode(Sha256::digest(b"abc")) };
        (policy, m, key)
    }
    fn signed(m: &Manifest, key: &Ed25519KeyPair) -> Vec<u8> {
        let payload = serde_json::to_string(m).unwrap();
        let signature = hex::encode(key.sign(payload.as_bytes()).as_ref());
        serde_json::to_vec(&Envelope { payload, signature }).unwrap()
    }
    #[test] fn authentic_release_and_version_order() {
        let (p, m, k) = fixture(); let m = verify_manifest(&signed(&m, &k), &p).unwrap();
        assert!(is_newer(&m, "9.1.0-alpha.23").unwrap());
        assert!(!is_newer(&m, "9.1.0-alpha.24").unwrap());
        assert!(!is_newer(&m, "9.1.0").unwrap());
    }
    #[test] fn tampering_wrong_key_and_unknown_fields_fail() {
        let (mut p, m, k) = fixture(); let b = signed(&m, &k);
        let tampered = String::from_utf8(b.clone()).unwrap().replace("中文说明", "changed");
        assert!(verify_manifest(tampered.as_bytes(), &p).is_err());
        p.public_key = "00".repeat(32); assert!(verify_manifest(&b, &p).is_err());
    }
    #[test] fn v1_channel_rejects_legacy_even_with_valid_signature() {
        let (mut p, mut m, k) = fixture();
        p.channel = "v1".into();
        assert!(verify_manifest(&signed(&m, &k), &p).is_err());
        m.channel = "v1".into();
        assert!(verify_manifest(&signed(&m, &k), &p).is_err());
        m.version = "1.0.59".into();
        m.url = format!("{}{}/CK-V{}-Setup-x64.exe", p.download_prefix, m.version, m.version);
        let stable = verify_manifest(&signed(&m, &k), &p).unwrap();
        assert!(!is_newer(&stable, "9.1.0-alpha.58").unwrap());
        assert!(!is_newer(&stable, "1.0.59").unwrap());
        assert!(is_newer(&stable, "1.0.58").unwrap());
    }
    #[test] fn signed_wrong_product_target_channel_and_url_fail() {
        let (p, m, k) = fixture();
        for field in ["app", "target", "channel", "url", "version"] {
            let mut v = serde_json::to_value(&m).unwrap(); v[field] = "wrong".into();
            let altered: Manifest = serde_json::from_value(v).unwrap();
            assert!(verify_manifest(&signed(&altered, &k), &p).is_err());
        }
    }
    #[test] fn oversized_metadata_and_installer_fail() {
        let (p, mut m, k) = fixture();
        assert!(verify_manifest(&vec![b' '; MAX_MANIFEST_BYTES + 1], &p).is_err());
        m.size = MAX_INSTALLER_BYTES + 1; assert!(verify_manifest(&signed(&m, &k), &p).is_err());
    }
    #[test] fn actual_bytes_must_match_even_at_identical_size() {
        let (_, m, _) = fixture(); let dir = tempfile::tempdir().unwrap(); let f = dir.path().join("setup.exe");
        std::fs::write(&f, b"abc").unwrap(); drop(open_verified_package(&f, &m).unwrap());
        std::fs::write(&f, b"xyz").unwrap(); assert!(open_verified_package(&f, &m).is_err());
        std::fs::write(&f, b"ab").unwrap(); assert!(open_verified_package(&f, &m).is_err());
    }
}
