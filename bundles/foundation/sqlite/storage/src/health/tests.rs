//! S78b: `Health`'s measurement of the storage directory (R10).

use super::*;
use crate::{testing::TempDir, v2::StorageDisk};

#[test]
fn a_directory_that_exists_is_ok_and_writable_with_its_blocks() {
    let dir = TempDir::new();

    let health = measure(dir.path());

    assert_eq!(health.status, "ok");
    assert!(health.writable);
    assert_eq!(health.reason, None);
    let StorageDisk {
        blocks,
        available_blocks,
    } = health.disk.expect("a measured disk");
    assert!(blocks > 0.0, "blocks {blocks}");
    assert_eq!(blocks.fract(), 0.0, "blocks {blocks}");
    assert_eq!(
        available_blocks.fract(),
        0.0,
        "available {available_blocks}"
    );
    assert!(
        (0.0..=blocks).contains(&available_blocks),
        "available {available_blocks} of {blocks}"
    );
}

#[test]
fn a_missing_directory_is_unavailable_and_unmeasurable_with_no_disk() {
    let dir = TempDir::new();
    let missing = dir.path().join("missing");

    let health = measure(&missing);

    assert_eq!(
        health,
        StorageHealth {
            status: "unavailable".to_owned(),
            writable: false,
            reason: Some("storage_unmeasurable".to_owned()),
            disk: None,
        }
    );
}
