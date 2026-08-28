use anyhow::{Context, Result, anyhow};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Cursor, Write};
use std::path::Path;

pub async fn download_file(url: &str, dest: &Path, expected_sha256: Option<&str>) -> Result<()> {
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    let response = reqwest::get(url).await?;
    if !response.status().is_success() {
        return Err(anyhow!("Failed to download: status {}", response.status()));
    }

    let mut stream = response.bytes_stream();
    let mut file = std::fs::File::create(dest)?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;

    log::info!("Starting download: {} -> {:?}", url, dest);

    while let Some(item) = stream.next().await {
        let chunk = item.context("Error while downloading chunk")?;
        file.write_all(&chunk)?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
    }

    log::info!("Download complete. Size: {} bytes", downloaded);

    if let Some(expected_hash) = expected_sha256 {
        let result_hash = format!("{:x}", hasher.finalize());
        if result_hash != expected_hash {
            return Err(anyhow!(
                "Hash mismatch! Expected {}, got {}",
                expected_hash,
                result_hash
            ));
        }
        log::info!("Hash verified: {}", result_hash);
    }

    Ok(())
}

pub async fn extract_archive(archive_path: &Path, extract_to: &Path) -> Result<()> {
    tokio::fs::create_dir_all(extract_to).await?;
    let file = File::open(archive_path)?;
    let extension = archive_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");

    if extension == "zip" {
        let mut archive = zip::ZipArchive::new(file)?;
        archive.extract(extract_to)?;
    } else if archive_path.to_string_lossy().ends_with(".tar.gz") || extension == "tgz" {
        let tar = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(tar);
        archive.unpack(extract_to)?;
    } else {
        return Err(anyhow!("Unsupported archive format: {:?}", archive_path));
    }

    log::info!("Extracted to {:?}", extract_to);
    Ok(())
}
