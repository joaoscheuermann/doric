//! Guarantee 8 of `storage.kv/v1`, isolation: a caller names only keys under
//! its own prefix, the UTF-8 bytes of `<bundleId>/`.

use doric_bundle::ContractError;

/// The platform's caller, the one caller never checked: the host's own keys,
/// the migration and the inspection tool reach every prefix.
pub const DORIC: &str = "doric";

/// Checks that `key` starts with the prefix of `caller`, the bundle id the
/// router stamped on the call (`call.caller.bundle_id`), followed by `/`.
///
/// It reads and writes nothing, so a refusal leaves the store untouched. A key
/// equal to the prefix itself passes; the caller [`DORIC`] always passes.
///
/// # Errors
///
/// `not_owner`, with the message `Key <hex> is outside the prefix <caller>/.`
/// and `details { key: <hex> }`, where `<hex>` is the whole key in lowercase
/// hexadecimal ([`hex`]).
pub(crate) fn check(caller: &str, key: &[u8]) -> Result<(), ContractError> {
    let owned = key
        .strip_prefix(caller.as_bytes())
        .is_some_and(|rest| rest.starts_with(b"/"));
    if caller == DORIC || owned {
        return Ok(());
    }

    let key = hex(key);
    Err(crate::refusal(
        "not_owner",
        format!("Key {key} is outside the prefix {caller}/."),
        "key",
        key.into(),
    ))
}

/// `bytes` in lowercase hexadecimal, two digits per byte; empty for no bytes.
/// The form of every key in a message or a detail (`not_owner`,
/// `condition_failed`), and of the schema hash.
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::testing::detail_str;

    #[test]
    fn the_platform_caller_passes_any_key() {
        for key in [&b""[..], b"a", b"b/x", b"core/secret", &[0xff, 0x00]] {
            assert_eq!(check(DORIC, key), Ok(()), "key {key:?}");
        }
    }

    #[test]
    fn a_key_under_the_callers_prefix_passes() {
        assert_eq!(check("a", b"a/x"), Ok(()));
        assert_eq!(check("a", b"a/"), Ok(()));
    }

    #[test]
    fn a_key_outside_the_callers_prefix_is_not_owner_with_its_hex() {
        for (key, hex) in [
            (&b"ab/x"[..], "61622f78"),
            (b"b/x", "622f78"),
            (b"a", "61"),
            (b"", ""),
        ] {
            let error = check("a", key).expect_err("the key is refused");

            assert_eq!(error.code, "not_owner", "key {key:?}");
            assert_eq!(
                detail_str(&error, "key").as_deref(),
                Some(hex),
                "key {key:?}"
            );
        }
    }

    #[test]
    fn a_key_that_only_resembles_the_prefix_is_not_owner_with_its_hex() {
        for (key, hex) in [
            (&b"A/x"[..], "412f78"),
            (b"a0", "6130"),
            (b"doric/x", "646f7269632f78"),
        ] {
            let error = check("a", key).expect_err("the key is refused");

            assert_eq!(error.code, "not_owner", "key {key:?}");
            assert_eq!(
                detail_str(&error, "key").as_deref(),
                Some(hex),
                "key {key:?}"
            );
        }
    }

    #[test]
    fn a_key_of_another_caller_is_not_owner_whichever_prefix_sorts_first() {
        assert_eq!(check("b", b"a/x").expect_err("refused").code, "not_owner");
        assert_eq!(
            check("a", b"b/keep").expect_err("refused").code,
            "not_owner"
        );
    }

    #[test]
    fn hex_is_lowercase_with_two_digits_per_byte() {
        assert_eq!(hex(b""), "");
        assert_eq!(hex(&[0x00, 0x0f, 0xab, 0xff]), "000fabff");
    }
}
