//! The tuple encoding of the layout's keys (spec, "The layout"), a port of
//! `encodeIndexKey` and `decodeIndexKey` (`packages/storage/src/keys.ts:88-104`),
//! so a query keeps today's order.

use doric_bundle::ContractError;

/// One element of a key's tuple: what an index value or a layout tuple holds.
#[derive(Debug, Clone, PartialEq)]
pub enum Element {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
}

/// The bytes of `tuple`, `encodeIndexKey`'s encoding (`packages/storage/src/keys.ts:96`):
/// null 0x01, false 0x02, true 0x03, number 0x04 + the 8 big-endian bytes of
/// the IEEE-754 double (-0 as 0) with every bit flipped when negative and only
/// the sign bit flipped otherwise, string 0x05 + UTF-8 with 0x00 escaped as
/// 0x00 0xFF, ended by 0x00 0x01. Comparing the bytes compares the tuples
/// (`null < false < true < numbers < strings`, numbers numerically, strings
/// bytewise in UTF-8); a tuple's bytes are a prefix of every longer tuple's
/// that starts with it; every element starts with a byte below 0xFF. The empty
/// tuple is the empty byte string.
///
/// # Errors
///
/// `invalid_index_value` for a number that is not finite.
pub fn encode(tuple: &[Element]) -> Result<Vec<u8>, ContractError> {
    let mut out = Vec::new();
    for element in tuple {
        match element {
            Element::Null => out.push(NULL_TAG),
            Element::Bool(false) => out.push(FALSE_TAG),
            Element::Bool(true) => out.push(TRUE_TAG),
            Element::Number(number) => encode_number(*number, &mut out)?,
            Element::String(text) => encode_string(text, &mut out),
        }
    }
    Ok(out)
}

const NULL_TAG: u8 = 0x01;
const FALSE_TAG: u8 = 0x02;
const TRUE_TAG: u8 = 0x03;
const NUMBER_TAG: u8 = 0x04;
const STRING_TAG: u8 = 0x05;

/// Greater than every tag byte and every byte an encoded value starts with.
const TOP: u8 = 0xFF;

const SIGN: u64 = 1 << 63;

fn encode_number(number: f64, out: &mut Vec<u8>) -> Result<(), ContractError> {
    if !number.is_finite() {
        // As JavaScript writes the number in `keys.ts`'s message.
        let written = if number.is_nan() {
            "NaN"
        } else if number > 0.0 {
            "Infinity"
        } else {
            "-Infinity"
        };
        return Err(ContractError::new(
            "invalid_index_value",
            format!("An indexed number must be finite, not {written}."),
        ));
    }
    // -0 and 0 are the same JSON number, so they get the same key.
    let bits = if number == 0.0 { 0 } else { number.to_bits() };
    let ordered = if bits & SIGN == 0 { bits | SIGN } else { !bits };
    out.push(NUMBER_TAG);
    out.extend_from_slice(&ordered.to_be_bytes());
    Ok(())
}

fn encode_string(text: &str, out: &mut Vec<u8>) {
    out.push(STRING_TAG);
    for &byte in text.as_bytes() {
        if byte == 0x00 {
            out.extend_from_slice(&[0x00, TOP]);
        } else {
            out.push(byte);
        }
    }
    out.extend_from_slice(&[0x00, 0x01]);
}

fn malformed() -> ContractError {
    ContractError::new("invalid_input", "Malformed index key.")
}

/// The inverse of [`encode`]: `decode(&encode(t)?)` is `t`, with -0 read as 0.
///
/// # Errors
///
/// `invalid_input` ("Malformed index key.") for bytes `encode` never produces.
pub fn decode(bytes: &[u8]) -> Result<Vec<Element>, ContractError> {
    let mut elements = Vec::new();
    let mut rest = bytes;
    while let Some((&tag, after)) = rest.split_first() {
        rest = after;
        elements.push(match tag {
            NULL_TAG => Element::Null,
            FALSE_TAG => Element::Bool(false),
            TRUE_TAG => Element::Bool(true),
            NUMBER_TAG => {
                let (number, after) = rest.split_first_chunk::<8>().ok_or_else(malformed)?;
                rest = after;
                let ordered = u64::from_be_bytes(*number);
                let bits = if ordered & SIGN == 0 {
                    !ordered
                } else {
                    ordered & !SIGN
                };
                Element::Number(f64::from_bits(bits))
            }
            STRING_TAG => {
                let mut text = Vec::new();
                loop {
                    match rest {
                        [0x00, 0x01, after @ ..] => {
                            rest = after;
                            break;
                        }
                        [0x00, TOP, after @ ..] => {
                            text.push(0x00);
                            rest = after;
                        }
                        [byte, after @ ..] if *byte != 0x00 => {
                            text.push(*byte);
                            rest = after;
                        }
                        _ => return Err(malformed()),
                    }
                }
                Element::String(String::from_utf8(text).map_err(|_| malformed())?)
            }
            _ => return Err(malformed()),
        });
    }
    Ok(elements)
}

/// A key of the layout: the UTF-8 bytes of `<prefix>/`, then [`encode`]`(tuple)`.
///
/// # Errors
///
/// As [`encode`].
pub fn key(prefix: &str, tuple: &[Element]) -> Result<Vec<u8>, ContractError> {
    let mut out = format!("{prefix}/").into_bytes();
    out.extend(encode(tuple)?);
    Ok(out)
}

/// The bounds of an index range, `StorageRange`'s fields as elements: each
/// `None` is a bound the query does not give.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Range {
    /// Value tuples above this element.
    pub gt: Option<Element>,
    /// Value tuples from this element.
    pub gte: Option<Element>,
    /// Value tuples below this element.
    pub lt: Option<Element>,
    /// Value tuples up to this element.
    pub lte: Option<Element>,
}

/// `keyBounds` (`packages/storage/src/keys.ts:285-319`): the bytes
/// `[lower, upper)` of the value tuples a query selects, compared with an
/// index entry's tuple after its `("idx", type, name)` prefix. With `p` =
/// [`encode`]`(equals)`: `lower` is `p ‖ encode([gt]) ‖ 0xFF` with `gt`,
/// `p ‖ encode([gte])` with `gte`, else `p`; `upper` is `p ‖ encode([lt])`
/// with `lt`, `p ‖ encode([lte]) ‖ 0xFF` with `lte`, else `p ‖ 0xFF`. A tuple
/// that starts with `equals` and whose next element falls in `range` (or that
/// only starts with `equals`, with no range) has bytes in `[lower, upper)`,
/// and no other tuple does. It reads no store; `lower >= upper` is an empty
/// selection, not an error.
///
/// # Errors
///
/// `invalid_input`, no details, message `A range takes either gt or gte, not
/// both.` when both `gt` and `gte` are given, else `A range takes either lt or
/// lte, not both.` when both `lt` and `lte` are; then the errors of [`encode`]
/// (`invalid_index_value` for a number that is not finite).
pub fn bounds(equals: &[Element], range: &Range) -> Result<(Vec<u8>, Vec<u8>), ContractError> {
    if range.gt.is_some() && range.gte.is_some() {
        return Err(ContractError::new(
            "invalid_input",
            "A range takes either gt or gte, not both.",
        ));
    }
    if range.lt.is_some() && range.lte.is_some() {
        return Err(ContractError::new(
            "invalid_input",
            "A range takes either lt or lte, not both.",
        ));
    }
    let prefix = encode(equals)?;
    let with = |element: &Element, top: bool| -> Result<Vec<u8>, ContractError> {
        let mut out = prefix.clone();
        out.extend(encode(std::slice::from_ref(element))?);
        if top {
            out.push(TOP);
        }
        Ok(out)
    };
    let lower = match (&range.gt, &range.gte) {
        (Some(gt), _) => with(gt, true)?,
        (None, Some(gte)) => with(gte, false)?,
        (None, None) => prefix.clone(),
    };
    let upper = match (&range.lt, &range.lte) {
        (Some(lt), _) => with(lt, false)?,
        (None, Some(lte)) => with(lte, true)?,
        (None, None) => [prefix.as_slice(), &[TOP]].concat(),
    };
    Ok((lower, upper))
}

#[cfg(test)]
mod tests {
    use super::*;
    use Element::{Bool, Null, Number, String as Str};

    fn s(text: &str) -> Element {
        Str(text.to_owned())
    }

    fn bytes(tuple: &[Element]) -> Vec<u8> {
        encode(tuple).expect("an encodable tuple")
    }

    #[test]
    fn each_kind_has_its_tag_and_bytes() {
        assert_eq!(bytes(&[Null]), [0x01]);
        assert_eq!(bytes(&[Bool(false)]), [0x02]);
        assert_eq!(bytes(&[Bool(true)]), [0x03]);
        assert_eq!(bytes(&[s("")]), [0x05, 0x00, 0x01]);
        assert_eq!(bytes(&[s("a")]), [0x05, 0x61, 0x00, 0x01]);
        assert_eq!(
            bytes(&[Number(0.0)]),
            [0x04, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        );
    }

    #[test]
    fn a_zero_byte_in_a_string_is_escaped() {
        assert_eq!(
            bytes(&[s("a\0b")]),
            [0x05, 0x61, 0x00, 0xFF, 0x62, 0x00, 0x01]
        );
    }

    #[test]
    fn negative_zero_encodes_as_zero() {
        assert_eq!(bytes(&[Number(-0.0)]), bytes(&[Number(0.0)]));
    }

    #[test]
    fn numbers_sort_numerically() {
        let numbers = [
            -1e308,
            -2.0,
            -1.0,
            -0.5,
            0.0,
            5e-324,
            0.5,
            1.0,
            9_007_199_254_740_991.0,
            1e308,
        ];
        for pair in numbers.windows(2) {
            assert!(
                bytes(&[Number(pair[0])]) < bytes(&[Number(pair[1])]),
                "{} sorts before {}",
                pair[0],
                pair[1]
            );
        }
    }

    #[test]
    fn kinds_sort_null_false_true_numbers_strings_and_strings_bytewise() {
        let ordered = [
            Null,
            Bool(false),
            Bool(true),
            Number(-1e308),
            Number(1e308),
            s(""),
            s("a"),
            s("aa"),
            s("b"),
            s("é"),
            s("😀"),
        ];
        for pair in ordered.windows(2) {
            assert!(
                bytes(&pair[..1]) < bytes(&pair[1..]),
                "{:?} sorts before {:?}",
                pair[0],
                pair[1]
            );
        }
    }

    #[test]
    fn a_tuple_is_a_prefix_of_its_extensions_and_each_element_starts_below_0xff() {
        let tuples: [&[Element]; 4] = [&[], &[s("meta")], &[Number(-1.0), Null], &[s("a\0")]];
        let elements = [Null, Bool(true), Number(-3.5), s(""), s("\u{FFFF}")];
        for tuple in tuples {
            for element in &elements {
                let mut longer = tuple.to_vec();
                longer.push(element.clone());
                let short = bytes(tuple);
                let long = bytes(&longer);
                assert!(long.starts_with(&short), "{tuple:?} then {element:?}");
                assert!(long[short.len()] < 0xFF, "{element:?} starts below 0xFF");
            }
        }
    }

    #[test]
    fn a_number_that_is_not_finite_is_refused() {
        for number in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let error = encode(&[s("x"), Number(number)]).expect_err("refused");
            assert_eq!(error.code, "invalid_index_value", "{number}");
        }
    }

    #[test]
    fn decode_reverses_encode() {
        let tuple = vec![
            Null,
            Bool(false),
            Bool(true),
            Number(-2.5),
            Number(0.0),
            Number(9_007_199_254_740_991.0),
            s(""),
            s("a\0b"),
            s("é😀"),
        ];
        assert_eq!(decode(&bytes(&tuple)), Ok(tuple));
        assert_eq!(bytes(&[]), Vec::<u8>::new());
        assert_eq!(decode(&[]), Ok(vec![]));
    }

    #[test]
    fn bytes_encode_never_produces_are_malformed() {
        let malformed: [&[u8]; 5] = [
            &[0x06],
            &[0x04, 0x01, 0x02],
            &[0x05, 0x61],
            &[0x05, 0x00, 0x02],
            &[0x05, 0xFF, 0xFE, 0x00, 0x01],
        ];
        for input in malformed {
            let error = decode(input).expect_err("malformed");
            assert_eq!(
                (error.code.as_str(), error.message.as_str()),
                ("invalid_input", "Malformed index key."),
                "{input:02x?}"
            );
        }
    }

    #[test]
    fn a_key_is_its_prefix_and_a_slash_then_its_tuple() {
        let tuple = [s("meta"), s("layout")];
        let mut expected = b"doric/".to_vec();
        expected.extend(bytes(&tuple));
        assert_eq!(key("doric", &tuple), Ok(expected));
    }

    fn then(mut prefix: Vec<u8>, rest: &[u8]) -> Vec<u8> {
        prefix.extend_from_slice(rest);
        prefix
    }

    #[test]
    fn bounds_with_no_equals_and_no_range_select_every_tuple() {
        assert_eq!(bounds(&[], &Range::default()), Ok((vec![], vec![0xFF])));
    }

    #[test]
    fn bounds_with_equals_select_the_tuples_that_start_with_it() {
        let p = bytes(&[s("x")]);

        assert_eq!(
            bounds(&[s("x")], &Range::default()),
            Ok((p.clone(), then(p, &[0xFF])))
        );
    }

    #[test]
    fn a_gt_bound_is_above_every_tuple_that_starts_with_it() {
        let range = Range {
            gt: Some(s("m")),
            ..Range::default()
        };

        let (lower, upper) = bounds(&[], &range).expect("valid bounds");

        assert_eq!(lower, then(bytes(&[s("m")]), &[0xFF]));
        assert_eq!(upper, vec![0xFF]);
        assert!(bytes(&[s("m"), s("id")]) < lower);
        assert!(bytes(&[s("m\0")]) >= lower);
        assert!(bytes(&[s("n")]) >= lower);
    }

    #[test]
    fn gte_lt_and_lte_bounds_follow_key_bounds() {
        let m = bytes(&[s("m")]);
        let only = |range: Range| bounds(&[], &range);

        assert_eq!(
            only(Range {
                gte: Some(s("m")),
                ..Range::default()
            }),
            Ok((m.clone(), vec![0xFF]))
        );
        assert_eq!(
            only(Range {
                lt: Some(s("m")),
                ..Range::default()
            }),
            Ok((vec![], m.clone()))
        );
        assert_eq!(
            only(Range {
                lte: Some(s("m")),
                ..Range::default()
            }),
            Ok((vec![], then(m, &[0xFF])))
        );

        let p = bytes(&[s("e")]);
        let range = Range {
            gte: Some(Number(1.0)),
            lt: Some(Number(5.0)),
            ..Range::default()
        };
        assert_eq!(
            bounds(&[s("e")], &range),
            Ok((
                then(p.clone(), &bytes(&[Number(1.0)])),
                then(p, &bytes(&[Number(5.0)]))
            ))
        );
    }

    #[test]
    fn both_bounds_of_a_pair_are_refused() {
        let lower = Range {
            gt: Some(s("a")),
            gte: Some(s("a")),
            lt: Some(s("z")),
            lte: Some(s("z")),
        };
        let error = bounds(&[], &lower).expect_err("gt and gte");
        assert_eq!(
            (error.code.as_str(), error.message.as_str()),
            ("invalid_input", "A range takes either gt or gte, not both.")
        );
        assert_eq!(error.details, None);

        let upper = Range {
            lt: Some(s("z")),
            lte: Some(s("z")),
            ..Range::default()
        };
        let error = bounds(&[], &upper).expect_err("lt and lte");
        assert_eq!(
            (error.code.as_str(), error.message.as_str()),
            ("invalid_input", "A range takes either lt or lte, not both.")
        );
    }

    #[test]
    fn a_bound_that_is_not_finite_is_refused() {
        let range = Range {
            lt: Some(Number(f64::INFINITY)),
            ..Range::default()
        };

        let error = bounds(&[s("x")], &range).expect_err("not finite");

        assert_eq!(error.code, "invalid_index_value");
    }
}
