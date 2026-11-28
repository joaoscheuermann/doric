use std::collections::HashMap;

use doric_bundle::CancellationToken;
use doric_sqlite::KvEngine as _;
use doric_storage::{layout, schema::DESCRIPTOR_SET_BYTES};
use prost::Message as _;

use super::*;
use crate::testing::{TempDir, caller, code_of, detail_str, open_temp, storage_set};

fn call_from(bundle_id: &str) -> Call {
    Call {
        caller: caller(bundle_id, 1),
        scope: HashMap::new(),
        traceparent: String::new(),
        deadline: None,
        cancelled: CancellationToken::new(),
    }
}

fn request(descriptor_set: Vec<u8>) -> RegisterRequest {
    RegisterRequest { descriptor_set }
}

fn valid_set() -> Vec<u8> {
    storage_set(
        "message Note {\n\
           option (doric.platform.v1.storage_type) = { type: \"a.note/v1\" };\n\
           string slug = 1;\n\
         }",
    )
}

#[tokio::test]
async fn the_platform_is_not_owner_before_the_store() {
    let result = Engine::default()
        .register(call_from("doric"), request(valid_set()))
        .await;

    assert_eq!(code_of(result), "not_owner");
}

#[tokio::test]
async fn a_set_over_the_limit_is_refused_before_the_store() {
    let result = Engine::default()
        .register(
            call_from("a"),
            request(vec![0xFF; DESCRIPTOR_SET_BYTES + 1]),
        )
        .await;

    assert_eq!(code_of(result), "limit_exceeded");
}

#[tokio::test]
async fn a_valid_set_before_activation_is_unavailable() {
    let result = Engine::default()
        .register(call_from("a"), request(valid_set()))
        .await;

    assert_eq!(code_of(result), "unavailable");
}

#[tokio::test]
async fn a_valid_set_registers_on_the_open_store() {
    let (_dir, store) = open_temp();
    let engine = Engine::default();
    assert!(engine.store.set(store).is_ok(), "the store is set once");

    let response = engine.register(call_from("a"), request(valid_set())).await;

    assert_eq!(response, Ok(RegisterResponse {}));
    let key = layout::declaration("a", "a.note/v1");
    let stored = engine
        .store()
        .expect("the store is open")
        .read(move |txn| txn.get(&key))
        .await
        .expect("the read succeeds")
        .expect("the declaration is stored");
    let declaration = layout::TypeDeclaration::decode(stored.0.as_slice()).expect("a declaration");
    assert_eq!(declaration.message_type, "fixture.v1.Note");
}

#[tokio::test]
async fn an_invalid_cache_setting_is_refused_before_the_open() {
    let dir = TempDir::new();
    let engine = Engine::default();

    let error = engine
        .activate_from(Some(dir.path().into()), Some("2".into()))
        .await
        .expect_err("the setting is refused");

    assert_eq!(error.code, "invalid_input");
    assert_eq!(
        detail_str(&error, "variable").as_deref(),
        Some(CACHE_VARIABLE)
    );
    assert_eq!(code_of(engine.store().map(|_| ())), "unavailable");
    assert!(
        !dir.path().join("doric.sqlite3").exists(),
        "the store was opened"
    );
}

#[tokio::test]
async fn a_cache_setting_of_0_activates_with_no_cache() {
    let dir = TempDir::new();
    let engine = Engine::default();

    let activated = engine
        .activate_from(Some(dir.path().into()), Some("0".into()))
        .await;

    assert_eq!(activated, Ok(()));
    assert_eq!(engine.headers().bound(), 0);
    engine.stop().await;
}
