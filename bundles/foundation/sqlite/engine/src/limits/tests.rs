use doric_bundle::ContractError;

use super::*;
use crate::{
    kv::{Condition, KeyRange, PositionedPut, Put, commit_request},
    store::testing::detail_str,
};

const CALLER: &str = "a";

/// A key of `size` bytes under the prefix `a/`.
fn key_of(size: usize) -> Vec<u8> {
    let mut key = b"a/".to_vec();
    key.resize(size, b'x');
    key
}

fn assert_limit(result: Result<(), ContractError>, limit: &str) {
    let error = result.expect_err("the limit is exceeded");
    assert_eq!(error.code, "limit_exceeded");
    assert_eq!(detail_str(&error, "limit").as_deref(), Some(limit));
}

fn assert_code<T: std::fmt::Debug>(result: Result<T, ContractError>, code: &str) {
    assert_eq!(result.expect_err("the call is refused").code, code);
}

fn keys(count: usize) -> GetRequest {
    GetRequest {
        keys: (0..count).map(|n| format!("a/{n}").into_bytes()).collect(),
    }
}

fn range_of(start: &[u8], end: &[u8], limit: u32) -> RangeRequest {
    RangeRequest {
        start: start.to_vec(),
        end: end.to_vec(),
        limit,
        ..RangeRequest::default()
    }
}

fn request(item: commit_request::Item) -> CommitRequest {
    CommitRequest { item: Some(item) }
}

fn condition(key: &[u8], version: f64) -> CommitRequest {
    request(commit_request::Item::Condition(Condition {
        key: key.to_vec(),
        version,
    }))
}

fn put(key: &[u8], value: Vec<u8>) -> CommitRequest {
    request(commit_request::Item::Put(Put {
        key: key.to_vec(),
        value,
    }))
}

fn delete(key: &[u8]) -> CommitRequest {
    request(commit_request::Item::Delete(key.to_vec()))
}

fn clear_range(start: &[u8], end: &[u8]) -> CommitRequest {
    request(commit_request::Item::ClearRange(KeyRange {
        start: start.to_vec(),
        end: end.to_vec(),
    }))
}

fn positioned_put(key_prefix: &[u8], value: Vec<u8>) -> CommitRequest {
    request(commit_request::Item::PositionedPut(PositionedPut {
        key_prefix: key_prefix.to_vec(),
        value,
    }))
}

/// A batch of puts on `a/k` whose keys and values are exactly `bytes`.
fn filled(bytes: usize) -> Batch {
    let mut batch = Batch::default();
    let mut left = bytes;
    while left > 0 {
        let value = (left - 3).min(VALUE_BYTES);
        batch
            .push(CALLER, put(b"a/k", vec![0; value]))
            .expect("a put within the limits");
        left -= 3 + value;
    }
    batch
}

#[test]
fn a_get_without_keys_is_invalid_input() {
    assert_code(get(CALLER, &keys(0)), "invalid_input");
}

#[test]
fn a_get_of_1000_keys_passes_and_1001_is_get_keys() {
    assert_eq!(get(CALLER, &keys(1000)), Ok(()));
    assert_limit(get(CALLER, &keys(1001)), "getKeys");
}

#[test]
fn a_get_key_of_4096_bytes_passes_and_4097_is_key_bytes() {
    let request = |size| GetRequest {
        keys: vec![key_of(size)],
    };

    assert_eq!(get(CALLER, &request(4096)), Ok(()));
    assert_limit(get(CALLER, &request(4097)), "keyBytes");
}

#[test]
fn a_get_over_the_key_count_answers_get_keys_before_the_prefix() {
    let mut request = keys(1001);
    request.keys[0] = b"b/x".to_vec();

    assert_limit(get(CALLER, &request), "getKeys");
}

#[test]
fn a_range_limit_of_0_is_invalid_input() {
    assert_code(range(CALLER, &range_of(b"a/0", b"a/9", 0)), "invalid_input");
}

#[test]
fn a_range_limit_of_1000_passes_and_1001_is_range_limit() {
    assert_eq!(range(CALLER, &range_of(b"a/0", b"a/9", 1000)), Ok(()));
    assert_limit(range(CALLER, &range_of(b"a/0", b"a/9", 1001)), "rangeLimit");
}

#[test]
fn a_range_whose_start_is_after_its_end_is_invalid_input() {
    assert_code(
        range(CALLER, &range_of(b"a/9", b"a/0", 10)),
        "invalid_input",
    );
}

#[test]
fn an_empty_range_passes() {
    assert_eq!(range(CALLER, &range_of(b"a/5", b"a/5", 10)), Ok(()));
}

#[test]
fn a_range_bound_outside_the_prefix_is_not_owner() {
    let error = range(CALLER, &range_of(b"a/0", b"b/", 10)).expect_err("refused");
    assert_eq!(error.code, "not_owner");
    assert_eq!(detail_str(&error, "key").as_deref(), Some("622f"));

    let error = range(CALLER, &range_of(b"", b"a/0", 10)).expect_err("refused");
    assert_eq!(error.code, "not_owner");
    assert_eq!(detail_str(&error, "key").as_deref(), Some(""));
}

#[test]
fn a_commit_item_with_no_case_set_is_invalid_input() {
    let mut batch = Batch::default();

    assert_code(
        batch.push(CALLER, CommitRequest { item: None }),
        "invalid_input",
    );
}

#[test]
fn a_commit_without_items_is_invalid_input() {
    assert_code(Batch::default().finish(), "invalid_input");
}

#[test]
fn a_commit_of_conditions_only_is_invalid_input() {
    let mut batch = Batch::default();
    batch
        .push(CALLER, condition(b"a/x", 0.0))
        .expect("a condition");
    batch
        .push(CALLER, condition(b"a/y", 3.0))
        .expect("a condition");

    assert_code(batch.finish(), "invalid_input");
}

#[test]
fn a_value_of_1048576_bytes_passes_and_one_more_is_value_bytes() {
    let mut batch = Batch::default();

    assert_eq!(batch.push(CALLER, put(b"a/k", vec![0; 1_048_576])), Ok(()));
    assert_limit(
        batch.push(CALLER, put(b"a/k", vec![0; 1_048_577])),
        "valueBytes",
    );
}

#[test]
fn a_positioned_put_prefix_of_4088_bytes_passes_and_4089_is_key_bytes() {
    let mut batch = Batch::default();

    assert_eq!(
        batch.push(CALLER, positioned_put(&key_of(4088), b"v".to_vec())),
        Ok(())
    );
    assert_limit(
        batch.push(CALLER, positioned_put(&key_of(4089), b"v".to_vec())),
        "keyBytes",
    );
}

#[test]
fn a_commit_of_200000_items_passes_and_item_200001_is_commit_items() {
    let mut batch = Batch::default();
    for _ in 0..200_000 {
        batch
            .push(CALLER, delete(b"a/k"))
            .expect("an item within the limit");
    }

    assert_limit(batch.push(CALLER, delete(b"a/k")), "commitItems");
}

#[test]
fn a_commit_of_67108864_bytes_passes_and_one_more_key_is_commit_bytes() {
    let mut batch = filled(67_108_864);

    assert_limit(batch.push(CALLER, delete(b"a/")), "commitBytes");
}

#[test]
fn a_condition_key_counts_toward_commit_bytes() {
    let mut batch = filled(67_108_864 - 2);

    assert_limit(batch.push(CALLER, condition(b"a/c", 0.0)), "commitBytes");
}

#[test]
fn a_clear_ranges_bounds_count_toward_commit_bytes() {
    let mut batch = filled(67_108_864 - 5);

    assert_limit(
        batch.push(CALLER, clear_range(b"a/a", b"a/b")),
        "commitBytes",
    );
}

#[test]
fn a_positioned_put_counts_its_prefix_plus_8_bytes_toward_commit_bytes() {
    let mut at_limit = filled(67_108_864 - 11);
    assert_eq!(
        at_limit.push(CALLER, positioned_put(b"a/p", Vec::new())),
        Ok(())
    );
    drop(at_limit);

    let mut over = filled(67_108_864 - 10);
    assert_limit(
        over.push(CALLER, positioned_put(b"a/p", Vec::new())),
        "commitBytes",
    );
}

#[test]
fn a_clear_range_whose_start_is_after_its_end_is_invalid_input() {
    let mut batch = Batch::default();

    assert_code(
        batch.push(CALLER, clear_range(b"a/b", b"a/a")),
        "invalid_input",
    );
}

#[test]
fn finish_answers_the_items_in_arrival_order() {
    let mut batch = Batch::default();
    for item in [
        put(b"a/z", b"1".to_vec()),
        condition(b"a/y", 2.0),
        delete(b"a/x"),
        clear_range(b"a/a", b"a/c"),
        positioned_put(b"a/p/", b"2".to_vec()),
        condition(b"a/b", 0.0),
    ] {
        batch.push(CALLER, item).expect("an item within the limits");
    }

    assert_eq!(
        batch.finish(),
        Ok(vec![
            Item::Put {
                key: b"a/z".to_vec(),
                value: b"1".to_vec(),
            },
            Item::Condition {
                key: b"a/y".to_vec(),
                version: 2.0,
            },
            Item::Delete(b"a/x".to_vec()),
            Item::ClearRange {
                start: b"a/a".to_vec(),
                end: b"a/c".to_vec(),
            },
            Item::PositionedPut {
                key_prefix: b"a/p/".to_vec(),
                value: b"2".to_vec(),
            },
            Item::Condition {
                key: b"a/b".to_vec(),
                version: 0.0,
            },
        ])
    );
}

/// A key of `size` bytes under the prefix `b/`, outside the caller's.
fn outside_of(size: usize) -> Vec<u8> {
    let mut key = b"b/".to_vec();
    key.resize(size, b'x');
    key
}

fn assert_not_owner<T: std::fmt::Debug>(result: Result<T, ContractError>, hex: &str) {
    let error = result.expect_err("the key is refused");
    assert_eq!(error.code, "not_owner");
    assert_eq!(detail_str(&error, "key").as_deref(), Some(hex));
}

/// A batch that took one valid item, the put of `a/ok`.
fn one_valid() -> Batch {
    let mut batch = Batch::default();
    batch
        .push(CALLER, put(b"a/ok", b"v".to_vec()))
        .expect("a put under the prefix");
    batch
}

fn the_valid_item() -> Vec<Item> {
    vec![Item::Put {
        key: b"a/ok".to_vec(),
        value: b"v".to_vec(),
    }]
}

#[test]
fn a_commit_item_naming_a_key_outside_the_prefix_is_not_owner_and_is_not_taken() {
    for (item, hex) in [
        (condition(b"b/x", 0.0), "622f78"),
        (put(b"b/x", b"v".to_vec()), "622f78"),
        (delete(b"b/x"), "622f78"),
        (positioned_put(b"b/x", b"v".to_vec()), "622f78"),
        (clear_range(b"", b"a/x"), ""),
        (clear_range(b"a/x", b"b/x"), "622f78"),
    ] {
        let mut batch = one_valid();

        assert_not_owner(batch.push(CALLER, item), hex);
        assert_eq!(batch.finish(), Ok(the_valid_item()), "key {hex}");
    }
}

#[test]
fn a_get_answers_the_first_refusal_in_key_order_with_the_prefix_before_the_size() {
    let request = |keys: Vec<Vec<u8>>| GetRequest { keys };

    assert_not_owner(
        get(CALLER, &request(vec![b"b/x".to_vec(), key_of(4097)])),
        "622f78",
    );
    assert_limit(
        get(CALLER, &request(vec![key_of(4097), b"b/x".to_vec()])),
        "keyBytes",
    );
    assert_code(get(CALLER, &request(vec![outside_of(4097)])), "not_owner");
}

#[test]
fn a_range_checks_its_limit_then_its_order_then_the_prefix_of_start_and_end_then_their_size() {
    assert_code(range(CALLER, &range_of(b"c/", b"b/", 0)), "invalid_input");
    assert_limit(range(CALLER, &range_of(b"c/", b"b/", 1001)), "rangeLimit");
    assert_code(range(CALLER, &range_of(b"c/", b"b/", 10)), "invalid_input");
    assert_not_owner(range(CALLER, &range_of(b"b/1", b"b/2", 10)), "622f31");
    assert_not_owner(range(CALLER, &range_of(&key_of(4097), b"b/", 10)), "622f");
}

#[test]
fn a_range_over_the_limit_from_outside_the_prefix_is_range_limit() {
    assert_limit(range(CALLER, &range_of(b"b/", b"b/z", 1001)), "rangeLimit");
}

#[test]
fn an_item_with_no_case_is_invalid_input_before_any_prefix_is_checked() {
    let mut batch = one_valid();

    assert_code(
        batch.push(CALLER, CommitRequest { item: None }),
        "invalid_input",
    );
    assert_not_owner(batch.push(CALLER, put(b"b/x", b"v".to_vec())), "622f78");
    assert_eq!(batch.finish(), Ok(the_valid_item()));
}

#[test]
fn the_prefix_of_an_item_is_checked_before_its_key_and_value_sizes() {
    let mut batch = one_valid();

    assert_code(
        batch.push(CALLER, put(&outside_of(4097), vec![0; 1_048_577])),
        "not_owner",
    );
    assert_eq!(batch.finish(), Ok(the_valid_item()));
}

#[test]
fn the_prefix_of_a_clear_ranges_start_then_end_is_checked_before_its_order() {
    let mut batch = one_valid();

    assert_not_owner(batch.push(CALLER, clear_range(b"c/", b"b/")), "632f");
    assert_not_owner(batch.push(CALLER, clear_range(b"a/", b"b/")), "622f");
    assert_eq!(batch.finish(), Ok(the_valid_item()));
}

#[test]
fn the_prefix_of_an_item_is_checked_before_the_commit_items_limit() {
    let mut batch = Batch::default();
    for _ in 0..200_000 {
        batch
            .push(CALLER, delete(b"a/k"))
            .expect("an item within the limit");
    }

    assert_not_owner(batch.push(CALLER, put(b"b/x", b"v".to_vec())), "622f78");
    assert_eq!(batch.finish().map(|items| items.len()), Ok(200_000));
}
