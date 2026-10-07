// Included from lib.rs so the program ID selection does not shift line numbers
// that are embedded in the release binary.

#[cfg(feature = "localnet-program-ids")]
declare_id!("GLCJS7CRsbH8eqnx1eSsAKwnB6CQBddLzF9ZwfukdS1C");

#[cfg(not(feature = "localnet-program-ids"))]
declare_id!("97V7JsExNC6yFWu5KjK1FLfVkNVvtMpAFL5QkLWKEGxY");
