// Included from lib.rs so the program ID selection does not shift line numbers
// that are embedded in the release binary.

#[cfg(feature = "localnet-program-ids")]
declare_id!("AF46Np2fvFA9rWirgHcQpjuJgXPPUgHZPFCtiDYcaog5");

#[cfg(not(feature = "localnet-program-ids"))]
declare_id!("9WUyNREiPDMgwMh5Gt81Fd3JpiCKxpjZ5Dpq9Bo1RhMV");
